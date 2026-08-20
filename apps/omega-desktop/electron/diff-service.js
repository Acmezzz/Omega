/**
 * Diff service — main-process, privileged.
 *
 * Produces a read-only `WorkspaceDiff` from `git diff` and performs `revert`
 * for rejected changes (tracked → `git checkout -- <file>`, untracked →
 * `git clean -f <file>`). The renderer NEVER writes to disk or runs git; it only
 * receives the structured DTO and an approval result. See system_design.md §3.4.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * @typedef {Object} DiffHunk
 * @property {string} header
 * @property {Array<{type:"context"|"add"|"del",oldLine?:number,newLine?:number,content:string}>} lines
 */

/**
 * @typedef {Object} DiffFile
 * @property {string} path
 * @property {"added"|"modified"|"deleted"|"renamed"} status
 * @property {number} additions
 * @property {number} deletions
 * @property {DiffHunk[]} hunks
 */

/**
 * @typedef {Object} WorkspaceDiff
 * @property {string} generatedAt
 * @property {string} repoRoot
 * @property {boolean} isGitRepo
 * @property {DiffFile[]} files
 */

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function isInsideWorkTree(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function repoRoot(cwd) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return cwd;
  }
}

function isTracked(cwd, file) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Parse a single-file unified diff body into hunks. */
function parseUnifiedDiff(body) {
  /** @type {DiffHunk[]} */
  const hunks = [];
  const lines = body.split("\n");
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      current = { header: line.replace(/^@@ /, "@@ ").trim(), lines: [] };
      hunks.push(current);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", newLine, content: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", oldLine, content: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", oldLine, newLine, content: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — ignore.
    } else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      // file headers between hunks — ignore.
    }
  }
  return hunks;
}

function statusFromCode(code) {
  if (code === "A" || code === "??") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return "modified";
}

function countHunkChanges(hunks) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions += 1;
      else if (line.type === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}

/** Build a single-file diff entry from git status + `git diff` (or file content). */
function buildDiffFile(cwd, code, filePath) {
  const status = statusFromCode(code);
  const untracked = code === "??";
  /** @type {DiffHunk[]} */
  let hunks = [];
  if (untracked) {
    const abs = join(cwd, filePath);
    if (existsSync(abs)) {
      const content = readFileSync(abs, "utf8");
      const fileLines = content.split("\n");
      if (fileLines.at(-1) === "") fileLines.pop();
      const lines = fileLines.map((text, index) => ({
        type: "add",
        newLine: index + 1,
        content: text,
      }));
      hunks = [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }];
    }
  } else {
    try {
      const body = git(cwd, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        filePath,
      ]);
      hunks = parseUnifiedDiff(body);
    } catch {
      hunks = [];
    }
  }
  const { additions, deletions } = countHunkChanges(hunks);
  return { path: filePath, status, additions, deletions, hunks };
}

/**
 * Compute a read-only structured diff of the working tree against HEAD.
 * @param {string} cwd
 * @returns {WorkspaceDiff}
 */
export function computeDiff(cwd) {
  const generatedAt = new Date().toISOString();
  if (!isInsideWorkTree(cwd)) {
    return { generatedAt, repoRoot: cwd, isGitRepo: false, files: [] };
  }
  const root = repoRoot(cwd);
  let statusText = "";
  try {
    statusText = git(cwd, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]);
  } catch {
    statusText = "";
  }
  /** @type {DiffFile[]} */
  const files = [];
  for (const raw of statusText.split("\n")) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    let filePath = raw.slice(3).trim();
    // Handle "R  old -> new" renames: keep the destination path.
    if (code[0] === "R" && filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ")[1];
    }
    files.push(buildDiffFile(cwd, code, filePath));
  }
  return { generatedAt, repoRoot: root, isGitRepo: true, files };
}

/**
 * Revert the given files. Tracked files use `git checkout -- <file>`; untracked
 * files use `git clean -f <file>` (irreversible deletion — UI must confirm).
 * @param {string[]} files
 * @param {string} cwd
 * @returns {{applied:boolean,action:string,revertedFiles:string[],errors:string[]}}
 */
export function revertFiles(files, cwd) {
  /** @type {string[]} */
  const revertedFiles = [];
  /** @type {string[]} */
  const errors = [];
  for (const file of files ?? []) {
    if (typeof file !== "string" || !file.trim()) continue;
    try {
      if (isTracked(cwd, file)) {
        git(cwd, ["checkout", "--", file]);
      } else {
        git(cwd, ["clean", "-f", "--", file]);
      }
      revertedFiles.push(file);
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    applied: errors.length === 0,
    action: "reject",
    revertedFiles,
    errors,
  };
}

/** Accept = no-op (keep changes). */
export function acceptChanges() {
  return { applied: true, action: "accept", revertedFiles: [], errors: [] };
}
