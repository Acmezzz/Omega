/**
 * Session persistence — local JSON files under `<sessionsRoot>/`.
 *
 * V1 storage format (system_design.md §3.5):
 *   manifest.json        SessionSummary[]
 *   <sessionId>.json     SessionRecord (transcript + tool cards)
 *
 * All filesystem writes happen HERE (main process only). The renderer has no
 * filesystem access. The functions are pure with respect to `sessionsRoot`
 * (injected by main.js) so they remain testable without Electron.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @typedef {Object} SessionSummary
 * @property {string} id
 * @property {string} title
 * @property {string} [projectKey]
 * @property {string} workspace
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {"active"|"archived"} status
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {string} title
 * @property {string} [projectKey]
 * @property {string} workspace
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {"active"|"archived"} status
 * @property {Array<{role:string,id:string,text:string,ts:string}>} messages
 * @property {Array<{toolCallId:string,toolName:string,status:string}>} [toolCards]
 */

function ensureDir(root) {
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function manifestPath(root) {
  return join(root, "manifest.json");
}

function readManifest(root) {
  const path = manifestPath(root);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeManifest(root, summaries) {
  ensureDir(root);
  const target = manifestPath(root);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(summaries, null, "\t")}\n`);
  renameSync(temp, target);
}

function recordPath(root, id) {
  return join(root, `${id}.json`);
}

/** List all sessions (most recently updated first). */
export function list(root) {
  const summaries = readManifest(ensureDir(root));
  return [...summaries].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** Create a new empty session and return its full record. */
export function create(root, req = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const record = {
    id,
    title: req.title?.trim() || "未命名会话",
    projectKey: req.projectKey,
    workspace: req.workspace || "",
    createdAt: now,
    updatedAt: now,
    status: "active",
    messages: [],
    toolCards: [],
  };
  writeFileSync(recordPath(root, id), `${JSON.stringify(record, null, "\t")}\n`);
  const summaries = readManifest(root).filter((s) => s.id !== id);
  summaries.push({
    id: record.id,
    title: record.title,
    projectKey: record.projectKey,
    workspace: record.workspace,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
  });
  writeManifest(root, summaries);
  return record;
}

/** Load a full session record, or null when missing. */
export function load(root, id) {
  const path = recordPath(root, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Persist (overwrite) a session record and refresh its manifest summary. */
export function save(root, record) {
  if (!record || typeof record.id !== "string") {
    throw new Error("invalid_session_record");
  }
  const now = new Date().toISOString();
  const enriched = { ...record, updatedAt: now };
  writeFileSync(recordPath(root, enriched.id), `${JSON.stringify(enriched, null, "\t")}\n`);
  const summaries = readManifest(root).filter((s) => s.id !== enriched.id);
  summaries.push({
    id: enriched.id,
    title: enriched.title,
    projectKey: enriched.projectKey,
    workspace: enriched.workspace,
    createdAt: enriched.createdAt,
    updatedAt: enriched.updatedAt,
    status: enriched.status,
  });
  writeManifest(root, summaries);
  return enriched;
}

/** Delete a session (record + manifest entry). */
export function remove(root, id) {
  const path = recordPath(root, id);
  if (existsSync(path)) unlinkSync(path);
  const summaries = readManifest(root).filter((s) => s.id !== id);
  writeManifest(root, summaries);
}
