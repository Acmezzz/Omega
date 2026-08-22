/**
 * Controlled DTOs consumed by the renderer.
 *
 * These are the ONLY shapes the renderer ever sees. They are produced by the
 * Electron main process (mostly `electron/state-reader.js`) which reads the
 * extensions' append-only state files and scrubs everything sensitive
 * (thinking, raw tool parameters/results, backup fragments). See
 * system_design.md §3.1–§3.5 and the security red line.
 */

/** Unified IPC envelope returned by every `omega:*` invoke. */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

// ===== workflow_* =====

export interface CatalogFeature {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  levelSemantics?: string;
  entryIds: string[];
  updatedAt: string;
}

export interface WorkflowCatalog {
  version: 1;
  updatedAt: string;
  features: CatalogFeature[];
}

export type EntryStatus = "probation" | "active" | "deprecated";
export type WorkflowLevel = 1 | 2 | 3;

export interface RegistryEntry {
  id: string;
  featureId: string;
  level: WorkflowLevel;
  intent: string;
  excludes?: string[];
  evidence: number;
  usage: number;
  escapes: number;
  status: EntryStatus;
  updatedAt: string;
}

export interface WorkflowRegistry {
  entries: RegistryEntry[];
}

export interface WorkflowTracker {
  workflowId: string;
  intent?: string;
  stepCount: number;
  currentIndex: number;
  retryCounts: Record<string, number>;
  completedToolCounts: Record<string, number>;
  expanded: string[];
  alternativeId: string | null;
  alternativeTools: string[] | null;
  escaped: boolean;
  updatedAt: string;
}

export interface CoverageSegment {
  fromSeq: number;
  toSeq: number;
  path: string;
}

export interface WorkflowMemoryCoverage {
  distilledUpTo: number;
  stale: boolean;
  segments: CoverageSegment[];
}

export interface WorkflowStats {
  projectKey: string;
  tasks: number;
  turns: number;
  pendingDistill: number;
  escapes: Array<{ taskId: string; workflowId: string; stepIndex: number; reason: string }>;
  generatedAt: string;
}

export type HealthSeverity = "info" | "warning" | "error";

export interface HealthIssue {
  code: string;
  severity: HealthSeverity;
  path: string;
  detail: string;
}

export interface WorkflowHealth {
  status: "ok" | "warn" | "error";
  projectKey: string;
  taskId?: string;
  roots: { journals: string; backups: string; workflows: string };
  summary: {
    tasks: number;
    journalTurns: number;
    backupEvents: number;
    fragments: number;
    pendingRestore: number;
    skippedLines: number;
    restricted: number;
  };
  issues: HealthIssue[];
}

// ===== scout_* =====

export type ScoutPolicy = "manual" | "explore-first" | "off";

export interface ScoutStatus {
  enabled: boolean;
  policy: ScoutPolicy;
  mode: "active" | "inactive";
  currentRoundId?: string;
  projectKey?: string;
  taskId?: string;
  maxRoundsPerTask: number;
}

export interface KnownFact {
  fact: string;
  source: string;
}

export interface ProbeRecord {
  question: string;
  action: string;
  observation: string;
  status: "observed" | "not-observed" | "error" | "unknown";
  source?: string;
}

export interface Proposal {
  id: string;
  idea: string;
  steps: string[];
  assumptions: string[];
  expectedEvidence: string[];
  disqualifiers: string[];
  probes: ProbeRecord[];
  closureStatus?: "closed" | "partial";
}

export interface ScoutRunView {
  scoutId: string;
  angle: string;
  status:
    | "completed"
    | "timed_out"
    | "aborted"
    | "budget_exceeded"
    | "parse_failed"
    | "spawn_failed";
  toolCallCount: number;
  durationMs: number;
  proposalCount: number;
  proposals: Proposal[];
}

export interface ScoutRoundView {
  roundId: string;
  taskId: string;
  projectKey: string;
  trigger: "initial" | "replan" | "targeted";
  taskBrief: {
    objective: string;
    deliverable: string;
    constraints: string[];
    knownFacts: KnownFact[];
    unknowns: string[];
    relevantPaths: string[];
  };
  model: string;
  prior: { kind: "matched" | "none" | "unavailable"; reason: string };
  runs: ScoutRunView[];
  adoptedProposalIds: string[];
  combinedPlanSummary?: string;
  verifiedOutcome: "not-yet-executed" | "succeeded" | "failed" | "aborted";
  selection: {
    selectedProposalIds: string[];
    combinedPlanSummary: string | null;
    reason: string | null;
  } | null;
}

export interface ScoutRounds {
  rounds: ScoutRoundView[];
  currentRound: ScoutRoundView | null;
  skippedLines: number;
  invalidSelections: number;
}

export interface ScoutProposals {
  roundId: string | null;
  proposals: Proposal[];
}

// ===== agent_* (V1 placeholders) =====

export interface AgentPermissionState {
  available: boolean;
  mode: "default" | "elevated" | "restricted";
  toolsAllowed: string[];
  note: string;
}

export interface AgentPlan {
  available: boolean;
  steps: string[];
  source: "event" | "derived" | "none";
  note: string;
}

// ===== diff / approval =====

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  header: string;
  lines: Array<{
    type: "context" | "add" | "del";
    oldLine?: number;
    newLine?: number;
    content: string;
  }>;
  raw?: string;
}

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface WorkspaceDiff {
  generatedAt: string;
  repoRoot: string;
  isGitRepo: boolean;
  files: DiffFile[];
}

export interface ChangeApprovalResult {
  applied: boolean;
  action: "accept" | "reject";
  revertedFiles: string[];
  errors: string[];
}

// ===== sessions =====

export interface SessionSummary {
  id: string;
  title: string;
  projectKey?: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "archived";
  messageCount?: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  id: string;
  text: string;
  ts: string;
  entryId?: string;
  thinking?: string;
  thinkingDeferred?: boolean;
}

export interface ToolCardSummary {
  toolCallId: string;
  toolName: string;
  status: string;
  kind?: string;
  target?: string;
  argsJson?: string;
  resultText?: string;
  isError?: boolean;
  afterMessageId?: string;
}

export interface SessionRecord extends SessionSummary {
  messages: SessionMessage[];
  toolCards?: ToolCardSummary[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  selected?: boolean;
}

export interface UsageSnapshot {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  input: number;
  output: number;
  total: number;
  cost: number;
}

export interface PromptImage {
  mimeType: string;
  data: string;
}

export interface AgentStateSnapshot {
  ready: boolean;
  cwd: string;
  sessionId: string;
  sessionName: string | null;
  model: Omit<ModelInfo, "selected"> | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;
  isStreaming: boolean;
  isIdle: boolean;
  isCompacting: boolean;
  usage: UsageSnapshot;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  autoCompaction: boolean;
  autoRetry: boolean;
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    totalMessages: number;
  };
  modelFallbackMessage: string | null;
  messages?: SessionMessage[];
  toolCards?: ToolCardSummary[];
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  action: "prompt" | "compact" | "new";
}

export interface AuthProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  source: string | null;
}

export interface AuthStatus {
  providers: AuthProviderStatus[];
  label: string;
  ready: boolean;
}

export interface TreeNodeRow {
  id: string;
  parentId: string | null;
  depth: number;
  role: string;
  preview: string;
  isLeaf: boolean;
  label?: string;
}

export interface SessionTree {
  nodes: TreeNodeRow[];
  activePath: string[];
  leafId: string | null;
}

export interface ForkCandidate {
  entryId: string;
  text: string;
}

export interface ExtensionResource {
  name: string;
  path: string;
  commands: number;
  tools: number;
}

export interface SkillResource {
  name: string;
  description: string;
  filePath: string;
}

export interface PromptResource {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
}

export interface ResourceBundle {
  extensions: ExtensionResource[];
  skills: SkillResource[];
  prompts: PromptResource[];
}

export interface DirEntryInfo {
  name: string;
  isDir: boolean;
  size: number;
}

export interface DirListing {
  path: string;
  entries: DirEntryInfo[];
}

export interface FileReadResult {
  path: string;
  size: number;
  binary: boolean;
  content?: string;
  truncated?: boolean;
}

export interface BashResultDTO {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
}

export interface GitCommitInfo {
  hash: string;
  message: string;
}

export interface GitSnapshot {
  generatedAt: string;
  repoRoot: string;
  isGitRepo: boolean;
  branch: string;
  log: GitCommitInfo[];
  unstaged: DiffFile[];
  staged: DiffFile[];
}

export interface GitApplyResult {
  applied: boolean;
  errors: string[];
}

export interface GitStageItem {
  path: string;
  hunks?: string[];
}

// ===== extension state aggregation (single pull) =====

export interface ExtensionStateBundle {
  workflow_catalog?: WorkflowCatalog;
  workflow_registry?: WorkflowRegistry;
  workflow_tracker?: WorkflowTracker;
  workflow_memory_coverage?: WorkflowMemoryCoverage;
  workflow_stats?: WorkflowStats;
  workflow_health?: WorkflowHealth;
  scout_status?: ScoutStatus;
  scout_rounds?: ScoutRounds;
  scout_proposals?: ScoutProposals;
  agent_permission_state?: AgentPermissionState;
  agent_plan?: AgentPlan;
}
