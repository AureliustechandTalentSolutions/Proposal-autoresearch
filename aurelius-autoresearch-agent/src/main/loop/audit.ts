/**
 * MinIO audit trail helper.
 *
 * Streams iteration records to a MinIO bucket for tamper-evident logging.
 * When MinIO is unreachable, records are buffered locally and flushed on
 * the next successful connection.
 */

import type { SecurityLogger } from "../nemoclaw/security-logger";
import type { AuditEntry } from "./types";

// ---------------------------------------------------------------------------
// Minimal MinIO client interface
// ---------------------------------------------------------------------------

/** Subset of the MinIO client API consumed by the audit helper. */
export interface MinIOClient {
  putObject(
    bucket: string,
    key: string,
    body: string | Buffer,
    metadata?: Record<string, string>,
  ): Promise<void>;

  statObject(
    bucket: string,
    key: string,
  ): Promise<{ size: number; lastModified: Date }>;

  bucketExists(bucket: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// AuditTrail
// ---------------------------------------------------------------------------

export interface AuditTrailConfig {
  bucket: string;
  /** Key prefix inside the bucket (e.g. "audit/runs/"). */
  keyPrefix: string;
  /** Whether to buffer locally when MinIO is down. */
  fallbackLocal: boolean;
}

export class AuditTrail {
  private readonly client: MinIOClient;
  private readonly security: SecurityLogger;
  private readonly config: AuditTrailConfig;

  /** Records buffered because MinIO was unreachable. */
  private localBuffer: AuditEntry[] = [];

  /** All entries recorded this session (for the final aggregate write). */
  private sessionEntries: AuditEntry[] = [];

  constructor(
    client: MinIOClient,
    security: SecurityLogger,
    config: AuditTrailConfig,
  ) {
    this.client = client;
    this.security = security;
    this.config = config;
  }

  /** Record a single audit event, attempting MinIO write immediately. */
  async record(entry: AuditEntry): Promise<void> {
    this.sessionEntries.push(entry);

    try {
      await this.writeToMinIO(entry);
    } catch (err) {
      if (this.config.fallbackLocal) {
        this.localBuffer.push(entry);
        this.security.warn("MinIO write failed, buffered locally", {
          run_id: entry.run_id,
          iteration: entry.iteration,
          bufferedCount: this.localBuffer.length,
          error: String(err),
        });
      } else {
        this.security.error("MinIO write failed, no fallback", {
          run_id: entry.run_id,
          error: String(err),
        });
        throw err;
      }
    }
  }

  /** Attempt to flush all locally-buffered records to MinIO. */
  async flushBuffer(): Promise<number> {
    if (this.localBuffer.length === 0) return 0;

    const toFlush = [...this.localBuffer];
    let flushed = 0;

    for (const entry of toFlush) {
      try {
        await this.writeToMinIO(entry);
        flushed++;
      } catch {
        // Stop flushing on first failure -- MinIO is likely still down
        break;
      }
    }

    // Remove successfully flushed entries
    this.localBuffer = this.localBuffer.slice(flushed);

    if (flushed > 0) {
      this.security.info("Flushed buffered audit records to MinIO", {
        flushed,
        remaining: this.localBuffer.length,
      });
    }

    return flushed;
  }

  /**
   * Write the complete session audit trail as a single aggregate object.
   * Called at the end of a run for easy retrieval.
   */
  async finalize(runId: string): Promise<string | undefined> {
    // Attempt final buffer flush
    await this.flushBuffer();

    const key = `${this.config.keyPrefix}${runId}/trail.json`;
    const body = JSON.stringify(this.sessionEntries, null, 2);

    try {
      await this.client.putObject(this.config.bucket, key, body, {
        "Content-Type": "application/json",
        "x-amz-meta-run-id": runId,
        "x-amz-meta-entry-count": String(this.sessionEntries.length),
      });

      this.security.info("Audit trail finalized", {
        run_id: runId,
        key,
        entryCount: this.sessionEntries.length,
      });

      return key;
    } catch (err) {
      this.security.error("Failed to finalize audit trail", {
        run_id: runId,
        error: String(err),
      });
      return undefined;
    }
  }

  /** Number of records currently in the local fallback buffer. */
  get bufferedCount(): number {
    return this.localBuffer.length;
  }

  /** Total records recorded this session. */
  get totalCount(): number {
    return this.sessionEntries.length;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async writeToMinIO(entry: AuditEntry): Promise<void> {
    const key = `${this.config.keyPrefix}${entry.run_id}/${String(entry.iteration).padStart(4, "0")}_${entry.event}.json`;
    const body = JSON.stringify(entry, null, 2);

    await this.client.putObject(this.config.bucket, key, body, {
      "Content-Type": "application/json",
      "x-amz-meta-run-id": entry.run_id,
      "x-amz-meta-iteration": String(entry.iteration),
      "x-amz-meta-event": entry.event,
    });
  }
}
