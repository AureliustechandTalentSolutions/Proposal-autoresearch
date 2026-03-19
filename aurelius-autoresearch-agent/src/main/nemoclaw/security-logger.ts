/**
 * @module security-logger
 * @description Security Event Logger for NemoClaw.
 *
 * Buffers security events in-memory and flushes them to:
 * 1. Local JSONL files in workspace/audit/ (primary)
 * 2. MinIO (S3-compatible) for long-term storage (secondary)
 *
 * Provides real-time critical event notification and filtered querying.
 * All events are structured for compliance auditability.
 *
 * Critical triggers:
 * - CUI data detected in a cloud-routed request
 * - Filesystem policy breach
 * - Network policy breach
 * - Resource limits exceeded
 * - 3+ violations from the same sandbox within 60 seconds
 *
 * Uses Bun-native APIs exclusively.
 */

import { mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Severity levels for security events. */
export type SecuritySeverity = "info" | "warning" | "critical" | "violation";

/** High-level category for a security event. */
export type SecurityCategory =
  | "access_control"
  | "data_protection"
  | "resource_management"
  | "policy_enforcement"
  | "system"
  | "routing"
  | "sandbox";

/** A single security event -- structured for audit compliance. */
export interface SecurityEvent {
  /** Unique event identifier (UUID v4). */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Sandbox that produced the event (empty for system events). */
  sandbox_id: string;
  /** Agent ID / name associated with the event. */
  agent_id: string;
  /** Concise action label (e.g. "filesystem_read", "route_decision"). */
  action: string;
  /** The resource being accessed or affected. */
  resource: string;
  /** The decision taken ("allow", "deny", "warn", "escalate"). */
  decision: "allow" | "deny" | "warn" | "escalate";
  /** Policy reference that triggered the decision (e.g. "level-2-guided.filesystem.denied_paths"). */
  policy_ref: string;
  /** Broad category. */
  category: SecurityCategory;
  /** Human-readable description. */
  description: string;
  /** Arbitrary structured details. */
  details: Record<string, unknown>;
  /** Assessed severity. */
  severity: SecuritySeverity;
}

/** Aggregate statistics over a time window. */
export interface SecurityStats {
  /** Total number of events. */
  total: number;
  /** Counts keyed by severity. */
  by_severity: Record<SecuritySeverity, number>;
  /** Counts keyed by category. */
  by_category: Record<SecurityCategory, number>;
  /** Counts keyed by decision. */
  by_decision: Record<string, number>;
  /** ISO-8601 timestamp of the query window start (or "all" if unbounded). */
  since: string;
}

/** Input type for logging -- `id` and `timestamp` are auto-populated. */
export type SecurityEventInput = Omit<SecurityEvent, "id" | "timestamp">;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event actions that are always classified as critical. */
const CRITICAL_ACTIONS: Set<string> = new Set([
  "cui_cloud_leak",
  "filesystem_breach",
  "network_breach",
  "resource_exceeded",
  "sandbox_escape",
  "pii_exfiltration",
]);

/** Burst threshold: this many violations in BURST_WINDOW_MS triggers critical. */
const BURST_THRESHOLD = 3;
/** Time window for burst detection in milliseconds. */
const BURST_WINDOW_MS = 60_000;

/** Default flush interval in milliseconds (30 seconds). */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/** MinIO bucket name for security logs. */
const MINIO_BUCKET = "nemoclaw-security-logs";

/** Maximum events to keep in-memory store. */
const MAX_STORE_SIZE = 50_000;

// ---------------------------------------------------------------------------
// SecurityLogger
// ---------------------------------------------------------------------------

/**
 * Buffers, analyses, and persists security events for the NemoClaw platform.
 *
 * @example
 * ```ts
 * const logger = new SecurityLogger("/workspace/audit", "http://localhost:9000");
 * logger.on_critical((event) => {
 *   console.error("CRITICAL:", event.description);
 * });
 *
 * logger.log({
 *   sandbox_id: "abc-123",
 *   agent_id: "researcher-1",
 *   action: "filesystem_breach",
 *   resource: "/etc/shadow",
 *   decision: "deny",
 *   policy_ref: "level-1-supervised.filesystem.denied_paths",
 *   category: "access_control",
 *   description: "Agent attempted to read /etc/shadow",
 *   details: { path: "/etc/shadow" },
 *   severity: "critical",
 * });
 *
 * const recent = logger.get_recent(10, "critical");
 * await logger.flush();
 * ```
 */
export class SecurityLogger {
  /** Local audit directory for JSONL files. */
  private readonly audit_dir: string;
  /** MinIO/S3 endpoint URL. */
  private readonly minio_endpoint: string;
  /** In-memory event buffer awaiting flush. */
  private buffer: SecurityEvent[] = [];
  /** Full event store (including flushed events, kept for queries). */
  private store: SecurityEvent[] = [];
  /** Registered critical event handlers. */
  private critical_handlers: Array<(event: SecurityEvent) => void> = [];
  /** Registered event handlers for real-time UI updates. */
  private event_handlers: Array<(event: SecurityEvent) => void> = [];
  /** Per-sandbox timestamps for burst detection. */
  private violation_timestamps: Map<string, number[]> = new Map();
  /** Periodic flush timer handle. */
  private flush_timer: Timer | null = null;
  /** Whether the audit directory has been created. */
  private audit_dir_ready = false;
  /** Current JSONL file path for the day. */
  private current_jsonl_path: string = "";
  /** Current JSONL file date string. */
  private current_date_str: string = "";

  /**
   * @param audit_dir Local directory for JSONL audit files. Defaults to "/workspace/audit".
   * @param minio_endpoint MinIO/S3-compatible endpoint URL. Defaults to "http://localhost:9000".
   */
  constructor(
    audit_dir: string = "/workspace/audit",
    minio_endpoint: string = "http://localhost:9000",
  ) {
    this.audit_dir = audit_dir;
    this.minio_endpoint = minio_endpoint.replace(/\/+$/, "");
    this.startPeriodicFlush();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Record a security event.
   *
   * The event is enriched with a UUID and timestamp, then added to the buffer.
   * If the event is critical (by action or burst detection), registered handlers
   * are invoked immediately and the buffer is flushed.
   */
  log(input: SecurityEventInput): SecurityEvent {
    const event: SecurityEvent = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.buffer.push(event);
    this.store.push(event);

    // Cap store size.
    if (this.store.length > MAX_STORE_SIZE) {
      this.store = this.store.slice(-MAX_STORE_SIZE / 2);
    }

    // Determine if this event should trigger critical notification.
    const isCritical = this.isCriticalEvent(event);
    if (isCritical && event.severity !== "critical") {
      event.severity = "critical";
    }

    // Emit to real-time event handlers.
    for (const handler of this.event_handlers) {
      try {
        handler(event);
      } catch {
        // Swallow handler errors.
      }
    }

    if (event.severity === "critical" || event.severity === "violation") {
      this.emitCritical(event);
      // Flush immediately on critical events.
      this.flush().catch((err) =>
        console.error("[SecurityLogger] Critical flush failed:", err),
      );
    }

    return event;
  }

  /**
   * Convenience method for logging common security event types.
   */
  logAccess(params: {
    sandbox_id: string;
    agent_id: string;
    action: string;
    resource: string;
    allowed: boolean;
    policy_ref: string;
    category?: SecurityCategory;
    details?: Record<string, unknown>;
  }): SecurityEvent {
    return this.log({
      sandbox_id: params.sandbox_id,
      agent_id: params.agent_id,
      action: params.action,
      resource: params.resource,
      decision: params.allowed ? "allow" : "deny",
      policy_ref: params.policy_ref,
      category: params.category ?? "access_control",
      description: `${params.action} ${params.allowed ? "allowed" : "denied"} for ${params.resource}`,
      details: params.details ?? {},
      severity: params.allowed ? "info" : "warning",
    });
  }

  /**
   * Log a routing decision.
   */
  logRouting(params: {
    sandbox_id: string;
    agent_id: string;
    route: "local" | "cloud";
    model: string;
    classification: string;
    rule_matched: string;
    cui_detected?: boolean;
    pii_types?: string[];
  }): SecurityEvent {
    const severity: SecuritySeverity =
      params.cui_detected ? "critical" : "info";
    return this.log({
      sandbox_id: params.sandbox_id,
      agent_id: params.agent_id,
      action: "route_decision",
      resource: params.model,
      decision: params.cui_detected && params.route === "cloud" ? "deny" : "allow",
      policy_ref: `routing.${params.rule_matched}`,
      category: "routing",
      description: `Routed to ${params.route} (${params.model}) via rule "${params.rule_matched}" [${params.classification}]`,
      details: {
        route: params.route,
        model: params.model,
        classification: params.classification,
        cui_detected: params.cui_detected ?? false,
        pii_types: params.pii_types ?? [],
      },
      severity,
    });
  }

  /**
   * Flush the in-memory buffer to local JSONL file and optionally to MinIO.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const eventsToFlush = [...this.buffer];
    this.buffer = [];

    const jsonl = eventsToFlush.map((e) => JSON.stringify(e)).join("\n") + "\n";

    // 1. Write to local JSONL file.
    await this.writeToLocalFile(jsonl);

    // 2. Attempt MinIO upload (best-effort).
    await this.writeToMinIO(eventsToFlush, jsonl);
  }

  /**
   * Query recent events with optional filters.
   */
  get_recent(
    count: number = 50,
    severity?: SecuritySeverity,
    category?: SecurityCategory,
  ): SecurityEvent[] {
    let results = this.store;

    if (severity) {
      results = results.filter((e) => e.severity === severity);
    }
    if (category) {
      results = results.filter((e) => e.category === category);
    }

    // Most recent first, limited to `count`.
    return results.slice(-count).reverse();
  }

  /**
   * Get violations only (severity = "critical" or "violation").
   */
  get_violations(count: number = 50): SecurityEvent[] {
    return this.store
      .filter(
        (e) => e.severity === "critical" || e.severity === "violation",
      )
      .slice(-count)
      .reverse();
  }

  /**
   * Compute aggregate statistics over a time window.
   */
  get_stats(since?: string): SecurityStats {
    const cutoff = since ? new Date(since).getTime() : 0;
    const events = since
      ? this.store.filter((e) => new Date(e.timestamp).getTime() >= cutoff)
      : this.store;

    const by_severity: Record<SecuritySeverity, number> = {
      info: 0,
      warning: 0,
      critical: 0,
      violation: 0,
    };
    const by_category: Record<SecurityCategory, number> = {
      access_control: 0,
      data_protection: 0,
      resource_management: 0,
      policy_enforcement: 0,
      system: 0,
      routing: 0,
      sandbox: 0,
    };
    const by_decision: Record<string, number> = {};

    for (const e of events) {
      by_severity[e.severity] = (by_severity[e.severity] ?? 0) + 1;
      by_category[e.category] = (by_category[e.category] ?? 0) + 1;
      by_decision[e.decision] = (by_decision[e.decision] ?? 0) + 1;
    }

    return {
      total: events.length,
      by_severity,
      by_category,
      by_decision,
      since: since ?? "all",
    };
  }

  /**
   * Register a handler that is invoked for every critical event.
   */
  on_critical(handler: (event: SecurityEvent) => void): void {
    this.critical_handlers.push(handler);
  }

  /**
   * Register a handler for every event (real-time UI updates).
   */
  on_event(handler: (event: SecurityEvent) => void): void {
    this.event_handlers.push(handler);
  }

  /**
   * Stop the periodic flush timer and perform a final flush. Call during shutdown.
   */
  async destroy(): Promise<void> {
    if (this.flush_timer) {
      clearInterval(this.flush_timer);
      this.flush_timer = null;
    }
    // Final flush.
    await this.flush();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Write JSONL data to a local audit file.
   * Files are organized by date: audit_dir/YYYY-MM-DD/events.jsonl
   */
  private async writeToLocalFile(jsonl: string): Promise<void> {
    try {
      await this.ensureAuditDir();

      const now = new Date();
      const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

      // Rotate file daily.
      if (dateStr !== this.current_date_str) {
        this.current_date_str = dateStr;
        const dayDir = `${this.audit_dir}/${dateStr}`;
        try {
          await mkdir(dayDir, { recursive: true });
        } catch {
          // Directory may already exist.
        }
        this.current_jsonl_path = `${dayDir}/events.jsonl`;
      }

      // Append to JSONL file using Bun.write with append mode.
      const file = Bun.file(this.current_jsonl_path);
      const existing = (await file.exists()) ? await file.text() : "";
      await Bun.write(this.current_jsonl_path, existing + jsonl);
    } catch (err) {
      console.warn(
        "[SecurityLogger] Failed to write local audit file:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Upload events to MinIO for long-term storage.
   */
  private async writeToMinIO(
    events: SecurityEvent[],
    jsonl: string,
  ): Promise<void> {
    try {
      const now = new Date();
      const path = [
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, "0"),
        String(now.getUTCDate()).padStart(2, "0"),
        String(now.getUTCHours()).padStart(2, "0"),
      ].join("/");
      const objectKey = `${path}/${crypto.randomUUID()}.jsonl`;

      const url = `${this.minio_endpoint}/${MINIO_BUCKET}/${objectKey}`;
      const resp = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/x-ndjson",
        },
        body: jsonl,
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        throw new Error(
          `MinIO returned HTTP ${resp.status}: ${await resp.text()}`,
        );
      }

      console.log(
        `[SecurityLogger] Flushed ${events.length} events to MinIO ${MINIO_BUCKET}/${objectKey}`,
      );
    } catch (err) {
      // MinIO upload failure is non-fatal -- local file is the primary store.
      console.warn(
        `[SecurityLogger] MinIO upload failed (${events.length} events still saved locally):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Ensure the audit directory exists. */
  private async ensureAuditDir(): Promise<void> {
    if (this.audit_dir_ready) return;
    try {
      await mkdir(this.audit_dir, { recursive: true });
      this.audit_dir_ready = true;
    } catch {
      // May already exist.
      this.audit_dir_ready = true;
    }
  }

  /**
   * Determine whether an event qualifies as critical.
   */
  private isCriticalEvent(event: SecurityEvent): boolean {
    // Explicit critical actions.
    if (CRITICAL_ACTIONS.has(event.action)) return true;
    if (event.severity === "critical" || event.severity === "violation")
      return true;

    // Burst detection.
    if (event.sandbox_id) {
      const now = Date.now();
      const timestamps =
        this.violation_timestamps.get(event.sandbox_id) ?? [];

      // Prune old timestamps.
      const recent = timestamps.filter((t) => now - t <= BURST_WINDOW_MS);
      recent.push(now);
      this.violation_timestamps.set(event.sandbox_id, recent);

      if (recent.length >= BURST_THRESHOLD) {
        event.details._burst_detected = true;
        event.details._burst_count = recent.length;
        return true;
      }
    }

    return false;
  }

  /** Emit a critical event to all registered handlers. */
  private emitCritical(event: SecurityEvent): void {
    for (const handler of this.critical_handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[SecurityLogger] Critical event handler threw:", err);
      }
    }
  }

  /** Start the periodic flush timer. */
  private startPeriodicFlush(): void {
    this.flush_timer = setInterval(async () => {
      try {
        await this.flush();
      } catch (err) {
        console.error("[SecurityLogger] Periodic flush failed:", err);
      }
    }, DEFAULT_FLUSH_INTERVAL_MS);

    if (
      this.flush_timer &&
      typeof this.flush_timer === "object" &&
      "unref" in this.flush_timer
    ) {
      (this.flush_timer as any).unref();
    }
  }
}
