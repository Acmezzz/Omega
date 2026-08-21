/**
 * StateReader — main-process, read-only.
 *
 * Reads the extensions' append-only state files (journal-workflow +
 * exploration-scout) and derives the controlled DTOs that the renderer is
 * allowed to see. Critically, EVERYTHING sensitive is dropped here:
 *   - ScoutRounds: `rawOutput` is never copied.
 *   - No thinking, no raw tool parameters/results, no backup fragments.
 *   - Scout/tracker `taskId` is inferred, never the raw payload.
 *
 * This module does NOT import any extension source — it re-implements the small
 * amount of schema parsing needed, so it stays forward-compatible and cannot
 * leak upstream types. See system_design.md §3.1 and the security red line.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir as osHomedir } from "node:os";

// ---------------------------------------------------------------------------
// Path / identity helpers (mirror the extensions' own derivation)
// ---------------------------------------------------------------------------

export function projectKeyFromCwd(cwd) {
  const normalized = String(cwd).replace(/\\/g, "/").replace(/^\/+/, "");
  return `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function safeTaskSegment(taskId) {
  return encodeURIComponent(taskId).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(osHomedir(), ".pi", "agent");
}

function resolveConfiguredPath(value, agentDir) {
  if (typeof value !== "string") return null;
  const expanded = value.startsWith("~/") ? join(osHomedir(), value.slice(2)) : value;
  return expanded;
}

/** Resolve the four extension roots + scout config from settings.json. */
function resolveRoots(agentDir = defaultAgentDir()) {
  const defaults = {
    journalsRoot: join(agentDir, "journals"),
    workflowsRoot: join(agentDir, "workflows"),
    backupsRoot: join(agentDir, "journal-backups"),
    explorationsRoot: join(agentDir, "explorations"),
    scoutPolicy: "manual",
    scoutEnabled: true,
    scoutMaxRounds: 2,
  };
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return defaults;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) || {};
    const jw = parsed.journalWorkflow || {};
    const sc = parsed.explorationScout || {};
    return {
      journalsRoot: jw.journalsRoot
        ? resolveConfiguredPath(jw.journalsRoot, agentDir)
        : defaults.journalsRoot,
      workflowsRoot: jw.workflowsRoot
        ? resolveConfiguredPath(jw.workflowsRoot, agentDir)
        : defaults.workflowsRoot,
      backupsRoot: jw.backupsRoot
        ? resolveConfiguredPath(jw.backupsRoot, agentDir)
        : defaults.backupsRoot,
      explorationsRoot: sc.explorationsRoot
        ? resolveConfiguredPath(sc.explorationsRoot, agentDir)
        : defaults.explorationsRoot,
      scoutPolicy: sc.policy ?? defaults.scoutPolicy,
      scoutEnabled: sc.enabled !== false && sc.policy !== "off",
      scoutMaxRounds: sc.budget?.maxRoundsPerTask ?? defaults.scoutMaxRounds,
    };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Generic JSON / directory helpers
// ---------------------------------------------------------------------------

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readLines(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function newestMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Find the most recently updated task dir under a project, or null. */
function latestTaskId(journalsRoot, projectKey) {
  const projectDir = join(journalsRoot, projectKey);
  if (!existsSync(projectDir)) return null;
  let best = null;
  let bestMtime = -1;
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDir = join(projectDir, entry.name);
    const metaPath = join(taskDir, "task.json");
    if (!existsSync(metaPath)) continue;
    const mtime = newestMtime(metaPath);
    if (mtime > bestMtime) {
      bestMtime = mtime;
      best = entry.name;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// workflow_* readers
// ---------------------------------------------------------------------------

export function readWorkflowCatalog(workflowsRoot) {
  const data = readJson(join(workflowsRoot, "catalog.json"));
  if (!data || !Array.isArray(data.features)) {
    return { version: 1, updatedAt: "", features: [] };
  }
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    features: data.features
      .filter(
        (f) =>
          f &&
          typeof f.id === "string" &&
          typeof f.label === "string" &&
          typeof f.description === "string" &&
          Array.isArray(f.aliases) &&
          Array.isArray(f.entryIds),
      )
      .map((f) => ({
        id: f.id,
        label: f.label,
        description: f.description,
        aliases: [...f.aliases],
        levelSemantics: typeof f.levelSemantics === "string" ? f.levelSemantics : undefined,
        entryIds: [...f.entryIds],
        updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : "",
      })),
  };
}

export function readWorkflowRegistry(workflowsRoot) {
  const data = readJson(join(workflowsRoot, "registry.json"));
  if (!data || !Array.isArray(data.entries)) return { entries: [] };
  return {
    entries: data.entries
      .filter((e) => e && typeof e.id === "string")
      .map((e) => ({
        id: e.id,
        featureId: String(e.featureId ?? ""),
        level: (typeof e.level === "number" ? e.level : 1),
        intent: String(e.intent ?? ""),
        excludes: Array.isArray(e.excludes) ? [...e.excludes] : undefined,
        evidence: Number(e.evidence ?? 0),
        usage: Number(e.usage ?? 0),
        escapes: Number(e.escapes ?? 0),
        status: e.status ?? "probation",
        updatedAt: String(e.updatedAt ?? ""),
      })),
  };
}

export function readWorkflowTracker(journalsRoot, projectKey, taskId, workflowsRoot) {
  if (!taskId) return undefined;
  const snap = readJson(join(journalsRoot, projectKey, taskId, "tracker.json"));
  if (!snap || snap.version !== 1 || typeof snap.workflowId !== "string") return undefined;
  const registry = readWorkflowRegistry(workflowsRoot ?? join(journalsRoot, "..", "workflows"));
  const entry = registry.entries.find((e) => e.id === snap.workflowId);
  return {
    workflowId: snap.workflowId,
    intent: entry?.intent,
    stepCount: Number(snap.stepCount ?? 0),
    currentIndex: Number(snap.currentIndex ?? 0),
    retryCounts: snap.retryCounts && typeof snap.retryCounts === "object" ? { ...snap.retryCounts } : {},
    completedToolCounts:
      snap.completedToolCounts && typeof snap.completedToolCounts === "object"
        ? { ...snap.completedToolCounts }
        : {},
    expanded: Array.isArray(snap.expanded) ? [...snap.expanded] : [],
    alternativeId: typeof snap.alternativeId === "string" ? snap.alternativeId : null,
    alternativeTools: Array.isArray(snap.alternativeTools) ? [...snap.alternativeTools] : null,
    escaped: snap.escaped === true,
    updatedAt: String(snap.updatedAt ?? ""),
  };
}

export function readWorkflowMemoryCoverage(journalsRoot, projectKey, taskId) {
  if (!taskId) return undefined;
  const coverage = readJson(join(journalsRoot, projectKey, taskId, "memory", "coverage.json"));
  if (!coverage) return undefined;
  return {
    distilledUpTo: Number(coverage.distilledUpTo ?? 0),
    stale: coverage.stale === true,
    segments: Array.isArray(coverage.segments)
      ? coverage.segments.map((s) => ({
          fromSeq: Number(s.fromTurnSeq ?? 0),
          toSeq: Number(s.toTurnSeq ?? 0),
          path: String(s.file ?? ""),
        }))
      : [],
  };
}

export function readWorkflowStats(journalsRoot, projectKey) {
  const projectDir = join(journalsRoot, projectKey);
  let tasks = 0;
  let turns = 0;
  let pendingDistill = 0;
  /** @type {Array<{taskId:string,workflowId:string,stepIndex:number,reason:string}>} */
  const escapes = [];
  if (existsSync(projectDir)) {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      const taskDir = join(projectDir, taskId);
      const meta = readJson(join(taskDir, "task.json"));
      if (!meta) continue;
      tasks += 1;
      turns += Number(meta.turnCount ?? 0);
      const coverage = readJson(join(taskDir, "memory", "coverage.json"));
      const fullyCovered =
        coverage && !coverage.stale && Number(coverage.distilledUpTo ?? 0) >= Number(meta.turnCount ?? 0);
      if (!fullyCovered) pendingDistill += 1;
      for (const line of readLines(join(taskDir, "failures.jl"))) {
        try {
          const rec = JSON.parse(line);
          escapes.push({
            taskId,
            workflowId: String(rec.workflowId ?? ""),
            stepIndex: Number(rec.stepIndex ?? 0),
            reason: String(rec.escapeReason ?? rec.reason ?? ""),
          });
        } catch {
          /* skip malformed */
        }
      }
    }
  }
  return {
    projectKey,
    tasks,
    turns,
    pendingDistill,
    escapes,
    generatedAt: new Date().toISOString(),
  };
}

export function readWorkflowHealth(journalsRoot, backupsRoot, workflowsRoot, projectKey, taskId) {
  /** @type {Array<{code:string,severity:string,path:string,detail:string}>} */
  const issues = [];
  let journalTurns = 0;
  let backupEvents = 0;
  let fragments = 0;
  let pendingRestore = 0;
  const projectDir = join(journalsRoot, projectKey);
  if (existsSync(projectDir)) {
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const taskDir = join(projectDir, entry.name);
      const meta = readJson(join(taskDir, "task.json"));
      if (!meta) {
        issues.push({
          code: "JOURNAL_META_MISSING_OR_INVALID",
          severity: "error",
          path: join(taskDir, "task.json"),
          detail: "task.json missing or unreadable",
        });
        continue;
      }
      journalTurns += Number(meta.turnCount ?? 0);
      const coverage = readJson(join(taskDir, "memory", "coverage.json"));
      const fullyCovered =
        coverage && !coverage.stale && Number(coverage.distilledUpTo ?? 0) >= Number(meta.turnCount ?? 0);
      if (!fullyCovered) pendingRestore += 1;
      const backupDir = join(backupsRoot, projectKey, entry.name);
      if (existsSync(backupDir)) {
        backupEvents += readLines(join(backupDir, "events.jl")).length;
        fragments += readLines(join(backupDir, "fragments.jl")).length;
      }
    }
  }

  // Workflow sanity checks (catalog dangling entries / orphan entities).
  const registry = readWorkflowRegistry(workflowsRoot);
  const known = new Set(registry.entries.map((e) => e.id));
  const catalog = readWorkflowCatalog(workflowsRoot);
  const dangling = catalog.features.flatMap((f) => f.entryIds.filter((id) => !known.has(id)));
  if (dangling.length > 0) {
    issues.push({
      code: "CATALOG_DANGLING_ENTRIES",
      severity: "warning",
      path: join(workflowsRoot, "catalog.json"),
      detail: `dangling entry references: ${dangling.length}`,
    });
  }

  const status = issues.some((i) => i.severity === "error")
    ? "error"
    : issues.length > 0
      ? "warn"
      : "ok";
  return {
    status,
    projectKey,
    ...(taskId ? { taskId } : {}),
    roots: { journals: journalsRoot, backups: backupsRoot, workflows: workflowsRoot },
    summary: {
      tasks: existsSync(projectDir) ? readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0,
      journalTurns,
      backupEvents,
      fragments,
      pendingRestore,
      skippedLines: 0,
      restricted: 0,
    },
    issues,
  };
}

// ---------------------------------------------------------------------------
// scout_* readers
// ---------------------------------------------------------------------------

function mapProposal(proposal) {
  if (!proposal || typeof proposal.id !== "string") return null;
  return {
    id: proposal.id,
    idea: String(proposal.idea ?? ""),
    steps: Array.isArray(proposal.steps) ? proposal.steps.map(String) : [],
    assumptions: Array.isArray(proposal.assumptions) ? proposal.assumptions.map(String) : [],
    expectedEvidence: Array.isArray(proposal.expectedEvidence) ? proposal.expectedEvidence.map(String) : [],
    disqualifiers: Array.isArray(proposal.disqualifiers) ? proposal.disqualifiers.map(String) : [],
    probes: Array.isArray(proposal.probes)
      ? proposal.probes
          .filter((p) => p && typeof p === "object")
          .map((p) => ({
            question: String(p.question ?? ""),
            action: String(p.action ?? ""),
            observation: String(p.observation ?? ""),
            status: p.status ?? "unknown",
            source: typeof p.source === "string" ? p.source : undefined,
          }))
      : [],
    closureStatus: proposal.closureStatus,
  };
}

function mapRun(run) {
  if (!run || typeof run.scoutId !== "string") return null;
  const proposals = (run.report?.proposals ?? [])
    .map(mapProposal)
    .filter(Boolean);
  return {
    scoutId: run.scoutId,
    angle: String(run.angle ?? ""),
    status: run.status ?? "completed",
    toolCallCount: Number(run.toolCallCount ?? 0),
    durationMs: Number(run.durationMs ?? 0),
    proposalCount: proposals.length,
    proposals,
  };
}

function mapRound(record, selection) {
  if (!record || typeof record.roundId !== "string") return null;
  const brief = record.taskBrief || {};
  return {
    roundId: record.roundId,
    taskId: String(record.taskId ?? ""),
    projectKey: String(record.projectKey ?? ""),
    trigger: record.trigger ?? "initial",
    taskBrief: {
      objective: String(brief.objective ?? ""),
      deliverable: String(brief.deliverable ?? ""),
      constraints: Array.isArray(brief.constraints) ? brief.constraints.map(String) : [],
      knownFacts: Array.isArray(brief.knownFacts)
        ? brief.knownFacts.map((f) => ({ fact: String(f?.fact ?? ""), source: String(f?.source ?? "") }))
        : [],
      unknowns: Array.isArray(brief.unknowns) ? brief.unknowns.map(String) : [],
      relevantPaths: Array.isArray(brief.relevantPaths) ? brief.relevantPaths.map(String) : [],
    },
    model: String(record.model ?? ""),
    prior: {
      kind: record.prior?.kind ?? "none",
      reason: String(record.prior?.reason ?? ""),
    },
    runs: (record.runs ?? []).map(mapRun).filter(Boolean),
    adoptedProposalIds: Array.isArray(record.adoptedProposalIds) ? [...record.adoptedProposalIds] : [],
    ...(typeof record.combinedPlanSummary === "string"
      ? { combinedPlanSummary: record.combinedPlanSummary }
      : {}),
    verifiedOutcome: record.verifiedOutcome ?? "not-yet-executed",
    selection: selection
      ? {
          selectedProposalIds: Array.isArray(selection.selectedProposalIds)
            ? [...selection.selectedProposalIds]
            : [],
          combinedPlanSummary:
            typeof selection.combinedPlanSummary === "string" ? selection.combinedPlanSummary : null,
          reason: typeof selection.reason === "string" ? selection.reason : null,
        }
      : null,
  };
}

export function readScoutRounds(explorationsRoot, projectKey, taskId) {
  if (!taskId) return undefined;
  const file = join(explorationsRoot, projectKey, safeTaskSegment(taskId), "rounds.jl");
  /** @type {any[]} */
  const rounds = [];
  /** @type {Array<{roundId:string,selection:any}>} */
  const selections = [];
  let skippedLines = 0;
  let invalidSelections = 0;
  for (const line of readLines(file)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.kind === "round" && parsed.record?.roundId) {
        rounds.push(parsed.record);
      } else if (parsed.kind === "selection" && parsed.roundId && parsed.selection) {
        const ids = parsed.selection.selectedProposalIds || [];
        const proposalIds = new Set(
          rounds
            .find((r) => r.roundId === parsed.roundId)
            ?.runs?.flatMap((run) => run.report?.proposals?.map((p) => p.id) ?? []) ?? [],
        );
        const valid =
          new Set(ids).size === ids.length &&
          ids.every((id) => typeof id === "string" && id.trim() && proposalIds.has(id));
        if (!valid) {
          invalidSelections += 1;
          continue;
        }
        selections.push({ roundId: parsed.roundId, selection: parsed.selection });
      } else {
        skippedLines += 1;
      }
    } catch {
      skippedLines += 1;
    }
  }
  const latest = new Map();
  for (const item of selections) latest.set(item.roundId, item.selection);
  const views = rounds
    .map((record) => mapRound(record, latest.get(record.roundId) ?? null))
    .filter(Boolean);
  return {
    rounds: views,
    currentRound: views.at(-1) ?? null,
    skippedLines,
    invalidSelections,
  };
}

export function readScoutProposals(explorationsRoot, projectKey, taskId) {
  const rounds = readScoutRounds(explorationsRoot, projectKey, taskId);
  if (!rounds || !rounds.currentRound) return { roundId: null, proposals: [] };
  const proposals = rounds.currentRound.runs.flatMap((run) => run.proposals);
  return { roundId: rounds.currentRound.roundId, proposals };
}

export function readScoutStatus(roots, projectKey, taskId) {
  const rounds = readScoutRounds(roots.explorationsRoot, projectKey, taskId);
  const currentRound = rounds?.currentRound ?? null;
  return {
    enabled: roots.scoutEnabled,
    policy: roots.scoutPolicy,
    mode: currentRound ? "active" : "inactive",
    ...(currentRound?.roundId ? { currentRoundId: currentRound.roundId } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(taskId ? { taskId } : {}),
    maxRoundsPerTask: roots.scoutMaxRounds,
  };
}

// ---------------------------------------------------------------------------
// placeholders
// ---------------------------------------------------------------------------

function placeholderPermission() {
  return {
    available: false,
    mode: "default",
    toolsAllowed: [],
    note: "SDK 0.84.2 does not expose permission events; placeholder only.",
  };
}

function placeholderPlan() {
  return {
    available: false,
    steps: [],
    source: "none",
    note: "SDK 0.84.2 does not expose plan events; placeholder only.",
  };
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

/**
 * Read the controlled extension-state bundle.
 * @param {Object} opts
 * @param {string} [opts.scope] "all" | "workflow" | "scout"
 * @param {string} [opts.cwd]   current working directory (derives projectKey)
 * @param {string} [opts.projectKey]
 * @param {string} [opts.taskId]
 * @param {string} [opts.agentDir]
 * @returns {Object} ExtensionStateBundle (only present sections)
 */
export function readExtensionState(opts = {}) {
  const scope = opts.scope ?? "all";
  const roots = resolveRoots(opts.agentDir);
  const projectKey = opts.projectKey || (opts.cwd ? projectKeyFromCwd(opts.cwd) : undefined);
  if (!projectKey) return {};
  const taskId = opts.taskId || latestTaskId(roots.journalsRoot, projectKey);

  /** @type {Record<string, any>} */
  const bundle = {};
  if (scope === "workflow" || scope === "all") {
    bundle.workflow_catalog = readWorkflowCatalog(roots.workflowsRoot);
    bundle.workflow_registry = readWorkflowRegistry(roots.workflowsRoot);
    bundle.workflow_tracker = readWorkflowTracker(roots.journalsRoot, projectKey, taskId, roots.workflowsRoot);
    bundle.workflow_memory_coverage = readWorkflowMemoryCoverage(
      roots.journalsRoot,
      projectKey,
      taskId,
    );
    bundle.workflow_stats = readWorkflowStats(roots.journalsRoot, projectKey);
    bundle.workflow_health = readWorkflowHealth(
      roots.journalsRoot,
      roots.backupsRoot,
      roots.workflowsRoot,
      projectKey,
      taskId,
    );
  }
  if (scope === "scout" || scope === "all") {
    bundle.scout_status = readScoutStatus(roots, projectKey, taskId);
    bundle.scout_rounds = readScoutRounds(roots.explorationsRoot, projectKey, taskId);
    bundle.scout_proposals = readScoutProposals(roots.explorationsRoot, projectKey, taskId);
  }
  if (scope === "all") {
    bundle.agent_permission_state = placeholderPermission();
    bundle.agent_plan = placeholderPlan();
  }
  return bundle;
}
