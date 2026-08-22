/**
 * Workspace file access — main-process only, path-safe.
 *
 * Every operation resolves the requested path strictly under the active
 * workspace root (realpath-style prefix check, case-insensitive on Windows);
 * the renderer never receives raw fs access. Used by the file tree, the
 * viewer, and the `@` completion index.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "release",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
]);
const MAX_READ_BYTES = 512 * 1024;
const MAX_INDEX_FILES = 4000;
const MAX_INDEX_DEPTH = 10;

function resolveUnder(root, relPath) {
  const abs = resolve(root, relPath || ".");
  const normRoot = resolve(root).toLowerCase();
  const normAbs = abs.toLowerCase();
  if (normAbs !== normRoot && !normAbs.startsWith(`${normRoot}\\`) && !normAbs.startsWith(`${normRoot}/`)) {
    throw new Error("Path escapes the workspace root");
  }
  return abs;
}

/** List one directory level (dirs first, alphabetical). */
export function listDir(root, relPath) {
  const abs = resolveUnder(root, relPath);
  const entries = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith(".") && name !== ".github") continue;
    let isDir = false;
    let size = 0;
    try {
      const info = statSync(join(abs, name));
      isDir = info.isDirectory();
      size = isDir ? 0 : info.size;
    } catch {
      continue;
    }
    entries.push({ name, isDir, size });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { path: relPath ?? "", entries };
}

/** Read a text file (size- and binary-guarded). */
export function readFile(root, relPath) {
  const abs = resolveUnder(root, relPath);
  const info = statSync(abs);
  if (info.isDirectory()) throw new Error("Path is a directory");
  const size = info.size;
  const handle = { buffer: readFileSync(abs) };
  const head = handle.buffer.subarray(0, 8192);
  if (head.includes(0)) return { path: relPath, size, binary: true };
  const content = handle.buffer.toString("utf8", 0, Math.min(handle.buffer.length, MAX_READ_BYTES));
  return { path: relPath, size, binary: false, content, truncated: size > MAX_READ_BYTES };
}

/** Fuzzy-ish file index under the root for `@` completion (bounded walk). */
export function fileIndex(root, query) {
  const q = String(query ?? "").toLowerCase().replace(/\\/g, "/");
  const results = [];
  const queue = [{ rel: "", depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_INDEX_FILES && results.length < 400) {
    const { rel, depth } = queue.shift();
    if (depth >= MAX_INDEX_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(resolveUnder(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        queue.push({ rel: childRel, depth: depth + 1 });
      } else {
        scanned += 1;
        if (q && !childRel.toLowerCase().includes(q)) continue;
        results.push(childRel);
      }
    }
  }
  results.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return results.slice(0, 50);
}
