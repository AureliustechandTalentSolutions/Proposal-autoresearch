/**
 * Autonomy Governor
 *
 * Enforces autonomy level policies across the workbench. Controls what
 * operations are allowed to proceed without human approval based on
 * the current autonomy level: supervised, guided, or fully_autonomous.
 */

import type {
  AutonomyLevel,
  GovernorDecision,
  OperationRequest,
  RPCResponse,
} from "../../shared/types";

/** Actions requiring different approval levels */
interface PermissionMatrix {
  /** Operations allowed at this level without approval */
  allowed: Set<string>;
  /** Operations that require notification but proceed automatically */
  notifyAndProceed: Set<string>;
  /** Operations that require explicit human approval */
  requiresApproval: Set<string>;
}

const PERMISSION_MATRICES: Record<AutonomyLevel, PermissionMatrix> = {
  supervised: {
    allowed: new Set([
      "read_artifact",
      "list_artifacts",
      "query_policy",
      "get_status",
      "list_schedules",
      "health_check",
    ]),
    notifyAndProceed: new Set([
      "compliance_scan",
      "rfp_watch",
      "sprs_score_update",
    ]),
    requiresApproval: new Set([
      "generate_hypothesis",
      "modify_artifact",
      "create_sandbox",
      "export_package",
      "generate_volume",
      "upload_artifact",
      "delete_artifact",
      "start_loop",
      "advance_phase",
    ]),
  },
  guided: {
    allowed: new Set([
      "read_artifact",
      "list_artifacts",
      "query_policy",
      "get_status",
      "list_schedules",
      "health_check",
      "compliance_scan",
      "rfp_watch",
      "sprs_score_update",
      "generate_hypothesis",
    ]),
    notifyAndProceed: new Set([
      "modify_artifact",
      "create_sandbox",
      "generate_volume",
      "upload_artifact",
      "start_loop",
      "advance_phase",
    ]),
    requiresApproval: new Set([
      "export_package",
      "delete_artifact",
    ]),
  },
  fully_autonomous: {
    allowed: new Set([
      "read_artifact",
      "list_artifacts",
      "query_policy",
      "get_status",
      "list_schedules",
      "health_check",
      "compliance_scan",
      "rfp_watch",
      "sprs_score_update",
      "generate_hypothesis",
      "modify_artifact",
      "create_sandbox",
      "generate_volume",
      "upload_artifact",
      "start_loop",
      "advance_phase",
      "export_package",
    ]),
    notifyAndProceed: new Set([
      "delete_artifact",
    ]),
    requiresApproval: new Set([
      // Only truly destructive or irreversible operations
    ]),
  },
};

/** Always blocked regardless of autonomy level */
const BLOCKED_OPERATIONS = new Set([
  "delete_all_artifacts",
  "reset_system",
  "modify_governor",
  "bypass_policy",
]);

export class Governor {
  private currentLevel: AutonomyLevel = "supervised";
  private pendingApprovals: Map<string, OperationRequest> = new Map();
  private auditLog: Array<{
    timestamp: number;
    operation: string;
    decision: GovernorDecision;
    level: AutonomyLevel;
  }> = [];
  private onApprovalRequired:
    | ((request: OperationRequest) => Promise<boolean>)
    | null = null;
  private onNotification:
    | ((message: string, operation: string) => void)
    | null = null;

  constructor(level: AutonomyLevel = "supervised") {
    this.currentLevel = level;
  }

  /**
   * Register callbacks for approval requests and notifications.
   */
  setCallbacks(callbacks: {
    onApprovalRequired?: (request: OperationRequest) => Promise<boolean>;
    onNotification?: (message: string, operation: string) => void;
  }): void {
    if (callbacks.onApprovalRequired) {
      this.onApprovalRequired = callbacks.onApprovalRequired;
    }
    if (callbacks.onNotification) {
      this.onNotification = callbacks.onNotification;
    }
  }

  /**
   * Evaluate whether an operation should proceed.
   */
  async evaluate(request: OperationRequest): Promise<GovernorDecision> {
    // Always block dangerous operations
    if (BLOCKED_OPERATIONS.has(request.operation)) {
      const decision: GovernorDecision = {
        allowed: false,
        reason: `Operation '${request.operation}' is permanently blocked`,
        requiresApproval: false,
        autonomyLevel: this.currentLevel,
      };
      this.recordAudit(request.operation, decision);
      return decision;
    }

    const matrix = PERMISSION_MATRICES[this.currentLevel];

    // Freely allowed
    if (matrix.allowed.has(request.operation)) {
      const decision: GovernorDecision = {
        allowed: true,
        reason: "Operation permitted at current autonomy level",
        requiresApproval: false,
        autonomyLevel: this.currentLevel,
      };
      this.recordAudit(request.operation, decision);
      return decision;
    }

    // Notify and proceed
    if (matrix.notifyAndProceed.has(request.operation)) {
      if (this.onNotification) {
        this.onNotification(
          `Auto-proceeding: ${request.operation}`,
          request.operation,
        );
      }
      const decision: GovernorDecision = {
        allowed: true,
        reason: "Operation auto-approved with notification",
        requiresApproval: false,
        autonomyLevel: this.currentLevel,
      };
      this.recordAudit(request.operation, decision);
      return decision;
    }

    // Requires approval
    if (matrix.requiresApproval.has(request.operation)) {
      const requestId = crypto.randomUUID();
      this.pendingApprovals.set(requestId, request);

      if (this.onNotification) {
        this.onNotification(
          `Approval required: ${request.operation}`,
          request.operation,
        );
      }

      let approved = false;
      if (this.onApprovalRequired) {
        try {
          approved = await this.onApprovalRequired(request);
        } catch {
          approved = false;
        }
      }

      this.pendingApprovals.delete(requestId);

      const decision: GovernorDecision = {
        allowed: approved,
        reason: approved
          ? "Operation approved by human"
          : "Operation denied: approval not granted",
        requiresApproval: true,
        autonomyLevel: this.currentLevel,
      };
      this.recordAudit(request.operation, decision);
      return decision;
    }

    // Unknown operation: default to requiring approval
    const decision: GovernorDecision = {
      allowed: false,
      reason: `Unknown operation '${request.operation}'; defaulting to deny`,
      requiresApproval: true,
      autonomyLevel: this.currentLevel,
    };
    this.recordAudit(request.operation, decision);
    return decision;
  }

  /**
   * Get the current autonomy level.
   */
  getLevel(): AutonomyLevel {
    return this.currentLevel;
  }

  /**
   * Set the autonomy level. Logs the change.
   */
  setLevel(level: AutonomyLevel): void {
    const previous = this.currentLevel;
    this.currentLevel = level;

    this.recordAudit("set_autonomy_level", {
      allowed: true,
      reason: `Autonomy level changed from '${previous}' to '${level}'`,
      requiresApproval: false,
      autonomyLevel: level,
    });

    if (this.onNotification) {
      this.onNotification(
        `Autonomy level changed to: ${level}`,
        "set_autonomy_level",
      );
    }
  }

  /**
   * List pending approval requests.
   */
  getPendingApprovals(): OperationRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * Retrieve the audit log, optionally filtered.
   */
  getAuditLog(params?: {
    operation?: string;
    since?: number;
    limit?: number;
  }): Array<{
    timestamp: number;
    operation: string;
    decision: GovernorDecision;
    level: AutonomyLevel;
  }> {
    let log = this.auditLog;

    if (params?.operation) {
      log = log.filter((e) => e.operation === params.operation);
    }
    if (params?.since) {
      log = log.filter((e) => e.timestamp >= params.since!);
    }
    if (params?.limit) {
      log = log.slice(-params.limit);
    }

    return log;
  }

  /**
   * Check what permissions an operation has at the current level.
   */
  describePermission(
    operation: string,
  ): "allowed" | "notify_and_proceed" | "requires_approval" | "blocked" | "unknown" {
    if (BLOCKED_OPERATIONS.has(operation)) return "blocked";

    const matrix = PERMISSION_MATRICES[this.currentLevel];
    if (matrix.allowed.has(operation)) return "allowed";
    if (matrix.notifyAndProceed.has(operation)) return "notify_and_proceed";
    if (matrix.requiresApproval.has(operation)) return "requires_approval";

    return "unknown";
  }

  /**
   * Export the audit log as a JSON-lines string for persistence.
   */
  exportAuditLog(): string {
    return this.auditLog
      .map((entry) => JSON.stringify(entry))
      .join("\n");
  }

  /**
   * Persist the audit log to disk using Bun.write.
   */
  async persistAuditLog(filePath: string): Promise<void> {
    const data = this.exportAuditLog();
    if (typeof globalThis.Bun !== "undefined") {
      await Bun.write(filePath, data + "\n");
    } else {
      const fs = await import("node:fs/promises");
      await fs.writeFile(filePath, data + "\n", "utf-8");
    }
  }

  /**
   * Get summary statistics of governor decisions.
   */
  getStats(): {
    total: number;
    allowed: number;
    denied: number;
    approvalRequired: number;
    byLevel: Record<string, number>;
  } {
    let allowed = 0;
    let denied = 0;
    let approvalRequired = 0;
    const byLevel: Record<string, number> = {};

    for (const entry of this.auditLog) {
      if (entry.decision.allowed) allowed++;
      else denied++;
      if (entry.decision.requiresApproval) approvalRequired++;
      byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;
    }

    return { total: this.auditLog.length, allowed, denied, approvalRequired, byLevel };
  }

  private recordAudit(operation: string, decision: GovernorDecision): void {
    this.auditLog.push({
      timestamp: Date.now(),
      operation,
      decision,
      level: this.currentLevel,
    });

    // Cap audit log at 10,000 entries
    if (this.auditLog.length > 10_000) {
      this.auditLog = this.auditLog.slice(-5_000);
    }
  }
}
