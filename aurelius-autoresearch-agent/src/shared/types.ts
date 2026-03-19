/**
 * Shared Type Definitions
 *
 * Interfaces used across all panels and the main process.
 */

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export type AutonomyLevel = "supervised" | "guided" | "fully_autonomous";

export interface RPCResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Maestro (Loop Control)
// ---------------------------------------------------------------------------

export type LoopPhase =
  | "idle"
  | "hypothesis"
  | "modify"
  | "score"
  | "review"
  | "export";

export interface LoopStatus {
  running: boolean;
  currentCycle: number;
  totalCycles: number;
  phase: LoopPhase;
  startedAt: number | null;
  lastCompletedAt: number | null;
  autonomyLevel: AutonomyLevel;
  errorCount: number;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  taskType: string;
  enabled: boolean;
  autonomyLevel: AutonomyLevel;
  payload: Record<string, unknown>;
}

export type MaestroCommand =
  | { type: "start"; params: { totalCycles: number; autonomyLevel: AutonomyLevel; targetArtifact?: string } }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "status" }
  | { type: "advance" };

// ---------------------------------------------------------------------------
// NemoClaw (Sandbox & Policy)
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  image?: string;
  entrypoint?: string[];
  networkAccess?: boolean;
  memoryLimitMb?: number;
  cpuQuota?: number;
  readonlyRoot?: boolean;
  timeoutMs?: number;
}

export interface SandboxSession {
  id: string;
  containerId: string | null;
  status: string;
  endpoint: string | null;
}

export interface PolicyQuery {
  path: string;
  input: Record<string, unknown>;
}

export interface PolicyResult {
  policyPath: string;
  allowed: boolean;
  score?: number;
  totalControls?: number;
  passingControls?: number;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface SecurityEvent {
  type: string;
  sessionId: string;
  containerId: string | null;
  timestamp: number;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Trigger (Task Queue)
// ---------------------------------------------------------------------------

export type TaskType =
  | "hypothesis_generate"
  | "modify_apply"
  | "score_evaluate"
  | "parse_pdf"
  | "generate_volume"
  | "export_package"
  | "compliance_scan"
  | "proposal_review"
  | "rfp_watch"
  | "sprs_score_update"
  | "artifact_generation"
  | "volume_generation";

export interface TaskDefinition {
  taskType: TaskType | string;
  payload: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface TaskStatus {
  id: string;
  taskType: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  enqueuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  retryCount: number;
  maxRetries: number;
}

export interface TaskResult {
  success: boolean;
  output: unknown;
  metrics?: Record<string, number>;
  artifacts?: string[];
}

// ---------------------------------------------------------------------------
// OPA (Policy)
// ---------------------------------------------------------------------------

export interface ComplianceScore {
  overallScore: number;
  totalControls: number;
  passingControls: number;
  failingControls: number;
  findings: PolicyResult[];
  evaluatedAt: number;
}

// ---------------------------------------------------------------------------
// MinIO (Artifacts)
// ---------------------------------------------------------------------------

export interface ArtifactMetadata {
  bucket: string;
  key: string;
  size: number;
  contentType: string;
  etag: string;
  lastModified: number;
  userMetadata: Record<string, string>;
}

export interface Artifact {
  bucket: string;
  key: string;
  data: Uint8Array;
  contentType: string;
  size: number;
  etag: string;
}

// ---------------------------------------------------------------------------
// Governor (Autonomy)
// ---------------------------------------------------------------------------

export interface OperationRequest {
  operation: string;
  source: string;
  context?: Record<string, unknown>;
}

export interface GovernorDecision {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
  autonomyLevel: AutonomyLevel;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface WatcherEvent {
  type: "created" | "modified" | "existing";
  filename: string;
  filePath: string;
  fileSize: number;
  extension: string;
  detectedAt: number;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export type PanelId =
  | "maestro"
  | "nemoclaw"
  | "trigger"
  | "compliance"
  | "workspace";

export interface PanelConfig {
  id: PanelId;
  title: string;
  url: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  resizable: boolean;
  visible: boolean;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export type LLMProvider = "anthropic" | "ollama" | "auto";

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  localModel: string;
  apiKey?: string;
  endpoint?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: LLMProvider;
  tokensUsed: number;
  latencyMs: number;
}
