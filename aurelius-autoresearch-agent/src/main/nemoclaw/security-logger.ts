/**
 * @module security-logger
 * @description Security Event Logger for NemoClaw.
 *
 * Buffers security events in-memory and periodically flushes them to MinIO
 * (S3-compatible object storage) as JSONL files. Provides real-time critical
 * event notification and filtered querying of recent events.
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

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Severity levels for security events. */
export type SecuritySeverity = "info" | "warning" | "critical";

/** High-level category for a security event. */
export type SecurityCategory =
  | "access_control"
  | "data_protection"
  | "resource_management"
  | "policy_enforcement"
  | "system";

/** A single security event. */
export interface SecurityEvent {
  /** Unique event identifier (UUID v4). */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Sandbox that produced the event (empty for system events). */
  sandbox_id: string;
  /** Agent name associated with the event. */
  agent_name: string;
  /** Concise event type label (e.g. "filesystem_breach", "cui_leak"). */
  event_type: string;
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
  /** ISO-8601 timestamp of the query window start (or "all" if unbounded). */
  since: string;
}

/** Input type for logging -- `id` and `timestamp` are auto-populated. */
export type SecurityEventInput = Omit<SecurityEvent, "id" | "timestamp">;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Event types that are always classified as critical. */
const CRITICAL_EVENT_TYPES: Set<string> = new Set([
  "cui_cloud_leak",
  "filesystem_breach",
  "network_breach",
  "resource_exceeded",
]);

/** Burst threshold: this many violations in BURST_WINDOW_MS triggers critical. */
const BURST_THRESHOLD = 3;
/** Time window for burst detection in milliseconds. */
const BURST_WINDOW_MS = 60_000;

/** Default flush interval in milliseconds (30 seconds). */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

/** MinIO bucket name for security logs. */
const MINIO_BUCKET = "nemoclaw-security-logs";

// ---------------------------------------------------------------------------
// SecurityLogger
// ---------------------------------------------------------------------------

/**
 * Buffers, analyses, and persists security events for the NemoClaw platform.
 *
 * @example
 * ```ts
 * const logger = new SecurityLogger("http://localhost:9000");
 * logger.on_critical((event) => {
 *   console.error("CRITICAL:", event.description);
 * });
 *
 * logger.log({
 *   sandbox_id: "abc-123",
 *   agent_name: "researcher-1",
 *   event_type: "filesystem_breach",
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
  /** MinIO/S3 endpoint URL. */
  private readonly minio_endpoint: string;
  /** In-memory event buffer awaiting flush. */
  private buffer: SecurityEvent[] = [];
  /** Full event store (including flushed events, kept for queries). */
  private store: SecurityEvent[] = [];
  /** Registered critical event handlers. */
  private critical_handlers: Array<(event: SecurityEvent) => void> = [];
  /** Per-sandbox timestamps for burst detection. */
  private violation_timestamps: Map<string, number[]> = new Map();
  /** Periodic flush timer handle. */
  private flush_timer: Timer | null = null;

  /**
   * @param minio_endpoint MinIO/S3-compatible endpoint URL.
   *   Defaults to `http://localhost:9000`.
   */
  constructor(minio_endpoint: string = "http://localhost:9000") {
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
   * If the event is critical (by type or burst detection), registered handlers
   * are invoked immediately.
   *
   * @param input Event data (id and timestamp are auto-generated).
   * @returns The fully populated event.
   */
  log(input: SecurityEventInput): SecurityEvent {
    const event: SecurityEvent = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    this.buffer.push(event);
    this.store.push(event);

    // Determine if this event should trigger critical notification.
    const isCritical = this.isCriticalEvent(event);
    if (isCritical && event.severity !== "critical") {
      // Promote severity if the event is critical by trigger rules.
      event.severity = "critical";
    }

    if (event.severity === "critical") {
      this.emitCritical(event);
    }

    return event;
  }

  /**
   * Flush the in-memory buffer to MinIO as a JSONL object.
   *
   * Each flush writes one object to:
   *   `s3://<bucket>/YYYY/MM/DD/HH/<uuid>.jsonl`
   *
   * If the MinIO endpoint is unreachable, events are retained in the buffer
   * and a warning is logged.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const eventsToFlush = [...this.buffer];
    this.buffer = [];

    const jsonl = eventsToFlush.map((e) => JSON.stringify(e)).join("\n");

    const now = new Date();
    const path = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
      String(now.getUTCHours()).padStart(2, "0"),
    ].join("/");
    const objectKey = `${path}/${crypto.randomUUID()}.jsonl`;

    try {
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
        throw new Error(`MinIO returned HTTP ${resp.status}: ${await resp.text()}`);
      }

      console.log(
        `Flushed ${eventsToFlush.length} security events to ${MINIO_BUCKET}/${objectKey}`
      );
    } catch (err) {
      // Re-queue events so they are not lost.
      this.buffer.unshift(...eventsToFlush);
      console.warn(
        `Failed to flush security events to MinIO (${eventsToFlush.length} events re-queued):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Query recent events with optional filters.
   *
   * @param count Maximum number of events to return (default 50).
   * @param severity Filter by severity level.
   * @param category Filter by category.
   * @returns Matching events, most recent first.
   */
  get_recent(
    count: number = 50,
    severity?: SecuritySeverity,
    category?: SecurityCategory
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
   * Compute aggregate statistics over a time window.
   *
   * @param since ISO-8601 timestamp for the start of the window.
   *   If omitted, statistics cover all recorded events.
   * @returns Aggregate counts by severity and category.
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
    };
    const by_category: Record<SecurityCategory, number> = {
      access_control: 0,
      data_protection: 0,
      resource_management: 0,
      policy_enforcement: 0,
      system: 0,
    };

    for (const e of events) {
      by_severity[e.severity] = (by_severity[e.severity] ?? 0) + 1;
      by_category[e.category] = (by_category[e.category] ?? 0) + 1;
    }

    return {
      total: events.length,
      by_severity,
      by_category,
      since: since ?? "all",
    };
  }

  /**
   * Register a handler that is invoked for every critical event.
   *
   * @param handler Callback receiving the critical event.
   */
  on_critical(handler: (event: SecurityEvent) => void): void {
    this.critical_handlers.push(handler);
  }

  /**
   * Stop the periodic flush timer. Call this during shutdown.
   */
  destroy(): void {
    if (this.flush_timer) {
      clearInterval(this.flush_timer);
      this.flush_timer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Determine whether an event qualifies as critical.
   *
   * An event is critical if:
   * 1. Its `event_type` is in the CRITICAL_EVENT_TYPES set, OR
   * 2. Its `severity` is already "critical", OR
   * 3. The originating sandbox has produced 3+ violations within 60 seconds
   *    (burst detection).
   */
  private isCriticalEvent(event: SecurityEvent): boolean {
    // Explicit critical types.
    if (CRITICAL_EVENT_TYPES.has(event.event_type)) return true;
    if (event.severity === "critical") return true;

    // Burst detection.
    if (event.sandbox_id) {
      const now = Date.now();
      const timestamps = this.violation_timestamps.get(event.sandbox_id) ?? [];

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
        console.error("Critical event handler threw:", err);
      }
    }
  }

  /** Start the periodic flush timer. */
  private startPeriodicFlush(): void {
    this.flush_timer = setInterval(async () => {
      try {
        await this.flush();
      } catch (err) {
        console.error("Periodic flush failed:", err);
      }
    }, DEFAULT_FLUSH_INTERVAL_MS);

    // Allow the process to exit even if the timer is still active.
    if (this.flush_timer && typeof this.flush_timer === "object" && "unref" in this.flush_timer) {
      (this.flush_timer as any).unref();
    }
  }
}
