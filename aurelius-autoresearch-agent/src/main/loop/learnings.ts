/**
 * Learnings store.
 *
 * Persists cross-iteration and cross-run learning records so the
 * hypothesis generator can avoid repeating failed strategies and
 * double down on successful ones.
 */

import type { LearningRecord, Decision } from "./types";

/**
 * In-memory + file-backed learnings store.
 *
 * Records are kept in memory for fast access during a run and flushed
 * to disk (JSON-lines) for persistence across runs.
 */
export class LearningsStore {
  private records: LearningRecord[] = [];
  private readonly filePath: string;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load existing learnings from the backing file. */
  async load(): Promise<void> {
    try {
      const text = await this.readFile(this.filePath);
      if (!text.trim()) return;

      const lines = text.trim().split("\n");
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as LearningRecord;
          this.records.push(record);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File doesn't exist yet -- that's fine for a fresh run
    }
  }

  /** Add a learning record from the current iteration. */
  add(record: LearningRecord): void {
    this.records.push(record);
    this.dirty = true;
  }

  /** Convenience: build and add a record from iteration results. */
  record(params: {
    runId: string;
    iteration: number;
    hypothesis: string;
    decision: Decision;
    scoreDelta: number;
    tags?: string[];
  }): void {
    this.add({
      run_id: params.runId,
      iteration: params.iteration,
      hypothesis: params.hypothesis,
      decision: params.decision,
      score_delta: params.scoreDelta,
      tags: params.tags ?? [],
      created_at: Date.now(),
    });
  }

  /** Return all records, optionally filtered by run. */
  getAll(runId?: string): LearningRecord[] {
    if (!runId) return [...this.records];
    return this.records.filter((r) => r.run_id === runId);
  }

  /** Return the most recent N records (across all runs). */
  getRecent(n: number): LearningRecord[] {
    return this.records.slice(-n);
  }

  /** Return records where the hypothesis was kept and improved score. */
  getSuccessful(minDelta = 0): LearningRecord[] {
    return this.records.filter(
      (r) => r.decision === "KEEP" && r.score_delta > minDelta,
    );
  }

  /** Return records where the hypothesis was discarded. */
  getFailed(): LearningRecord[] {
    return this.records.filter((r) => r.decision === "DISCARD");
  }

  /** Flush dirty records to the backing file (append-only). */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    // We append only the new records since last flush.  For simplicity
    // we rewrite the entire file; a production implementation would use
    // an append-only write.
    const lines = this.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await this.writeFile(this.filePath, lines);
    this.dirty = false;
  }

  /** Number of stored records. */
  get size(): number {
    return this.records.length;
  }

  // -----------------------------------------------------------------------
  // Filesystem abstraction (overridable for testing)
  // -----------------------------------------------------------------------

  protected async readFile(path: string): Promise<string> {
    // Uses Bun.file for zero-copy reads when available, falls back to
    // Node fs/promises.
    if (typeof globalThis.Bun !== "undefined") {
      return globalThis.Bun.file(path).text();
    }
    const fs = await import("node:fs/promises");
    return fs.readFile(path, "utf-8");
  }

  protected async writeFile(path: string, data: string): Promise<void> {
    if (typeof globalThis.Bun !== "undefined") {
      await globalThis.Bun.write(path, data);
      return;
    }
    const fs = await import("node:fs/promises");
    await fs.writeFile(path, data, "utf-8");
  }
}
