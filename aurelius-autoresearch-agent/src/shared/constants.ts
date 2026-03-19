/**
 * App-wide Constants
 *
 * Centralized configuration constants used across the workbench.
 */

// ---------------------------------------------------------------------------
// IPC Channels
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = {
  MAESTRO: "ipc:maestro",
  NEMOCLAW: "ipc:nemoclaw",
  TRIGGER: "ipc:trigger",
  COMPLIANCE: "ipc:compliance",
  WORKSPACE: "ipc:workspace",
  GOVERNOR: "ipc:governor",
  NOTIFICATIONS: "ipc:notifications",
  SYSTEM: "ipc:system",
} as const;

// ---------------------------------------------------------------------------
// Panel Configuration
// ---------------------------------------------------------------------------

export const PANEL_IDS = {
  MAESTRO: "maestro",
  NEMOCLAW: "nemoclaw",
  TRIGGER: "trigger",
  COMPLIANCE: "compliance",
  WORKSPACE: "workspace",
} as const;

export const PANEL_TITLES: Record<string, string> = {
  maestro: "Maestro - Research Loop",
  nemoclaw: "NemoClaw - Sandbox & Policy",
  trigger: "Trigger - Task Queue",
  compliance: "Compliance Dashboard",
  workspace: "Workspace & Artifacts",
} as const;

export const DEFAULT_PANEL_DIMENSIONS = {
  maestro: { width: 1200, height: 800 },
  nemoclaw: { width: 1000, height: 700 },
  trigger: { width: 1000, height: 600 },
  compliance: { width: 1100, height: 750 },
  workspace: { width: 1000, height: 700 },
} as const;

// ---------------------------------------------------------------------------
// Service Endpoints (Defaults)
// ---------------------------------------------------------------------------

export const DEFAULT_ENDPOINTS = {
  OPA: "http://localhost:8181",
  MINIO: "http://localhost:9000",
  MINIO_CONSOLE: "http://localhost:9001",
  OLLAMA: "http://localhost:11434",
  OPENSHELL: "http://localhost:2376",
  TRIGGER: "http://localhost:3030",
} as const;

// ---------------------------------------------------------------------------
// MinIO Buckets
// ---------------------------------------------------------------------------

export const BUCKETS = {
  PROPOSALS: "proposals",
  COMPLIANCE: "compliance-artifacts",
  RFP_INBOX: "rfp-inbox",
  VOLUMES: "volumes",
  EXPORTS: "exports",
  HYPOTHESES: "hypotheses",
  SCORES: "scores",
  TEMPLATES: "templates",
} as const;

// ---------------------------------------------------------------------------
// OPA Policy Paths
// ---------------------------------------------------------------------------

export const POLICY_PATHS = {
  // Compliance frameworks
  NIST_800_53: "compliance/nist_800_53",
  NIST_800_171: "compliance/nist_800_171",
  STIG_K8S: "compliance/stig_k8s",
  CMMC_L2: "compliance/cmmc_l2",
  SPRS: "compliance/sprs",

  // Proposal evaluation
  EVAL_RUBRIC: "proposal/eval_rubric",
  READABILITY: "proposal/readability",
  PAGE_LIMITS: "proposal/page_limits",
  COMPLIANCE_MATRIX: "proposal/compliance_matrix",

  // Constraints
  FEDERAL_PROPOSAL: "constraints/federal_proposal",
  COMPLIANCE_ARTIFACT: "constraints/compliance_artifact",
  SAFETY: "constraints/safety",
} as const;

// ---------------------------------------------------------------------------
// Task Types
// ---------------------------------------------------------------------------

export const TASK_TYPES = {
  HYPOTHESIS_GENERATE: "hypothesis_generate",
  MODIFY_APPLY: "modify_apply",
  SCORE_EVALUATE: "score_evaluate",
  PARSE_PDF: "parse_pdf",
  GENERATE_VOLUME: "generate_volume",
  EXPORT_PACKAGE: "export_package",
  COMPLIANCE_SCAN: "compliance_scan",
  PROPOSAL_REVIEW: "proposal_review",
  RFP_WATCH: "rfp_watch",
  SPRS_SCORE_UPDATE: "sprs_score_update",
} as const;

// ---------------------------------------------------------------------------
// LLM Defaults
// ---------------------------------------------------------------------------

export const LLM_DEFAULTS = {
  PROVIDER: "auto" as const,
  MODEL: "claude-sonnet-4-20250514",
  LOCAL_MODEL: "nemotron:latest",
  MAX_TOKENS: 4096,
  TEMPERATURE: 0.7,
} as const;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export const TIMEOUTS = {
  /** Default task timeout: 5 minutes */
  TASK_DEFAULT_MS: 300_000,
  /** Sandbox creation timeout: 30 seconds */
  SANDBOX_CREATE_MS: 30_000,
  /** Policy evaluation timeout: 10 seconds */
  POLICY_EVAL_MS: 10_000,
  /** LLM call timeout: 2 minutes */
  LLM_CALL_MS: 120_000,
  /** Health check timeout: 5 seconds */
  HEALTH_CHECK_MS: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Workbench
// ---------------------------------------------------------------------------

export const WORKBENCH = {
  APP_NAME: "Aurelius Autonomous Workbench",
  APP_ID: "com.aurelius.workbench",
  VERSION: "0.1.0",
  DEFAULT_PORT: 8500,
  MAX_CONCURRENT_TASKS: 5,
  MAX_LOOP_CYCLES: 100,
} as const;
