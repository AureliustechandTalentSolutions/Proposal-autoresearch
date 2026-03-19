/**
 * Learnings store.
 *
 * Persists cross-iteration and cross-run learning records so the
 * hypothesis generator can avoid repeating failed strategies and
 * double down on successful ones.
 *
 * Supports two formats:
 * - JSON-lines (.jsonl): Default, one JSON record per line
 * - YAML (.yaml): Human-readable format for manual review
 *
 * Uses Bun.file/Bun.write when available for zero-copy I/O.
 */

import type { LearningRecord, Decision } from "./types";

// ---------------------------------------------------------------------------
// YAML serialization (lightweight, no external dependency)
// ---------------------------------------------------------------------------

function recordToYaml(r: LearningRecord): string {
  const lines = [
    `- run_id: "${r.run_id}"`,
    `  iteration: ${r.iteration}`,
    `  hypothesis: "${r.hypothesis.replace(/"/g, '\\"')}"`,
    `  decision: ${r.decision}`,
    `  score_delta: ${r.score_delta.toFixed(6)}`,
    `  tags: [${r.tags.map((t) => `"${t}"`).join(", ")}]`,
    `  created_at: ${r.created_at}`,
  ];
  return lines.join("\n");
}

function yamlToRecords(text: string): LearningRecord[] {
  // Simple YAML parser for our specific format
  const records: LearningRecord[] = [];
  const blocks = text.split(/^- /m).filter((b) => b.trim());

  for (const block of blocks) {
    try {
      const get = (key: string): string => {
        const match = block.match(new RegExp(`${key}:\\s*(.+)`));
        return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
      };

      const record: LearningRecord = {
        run_id: get("run_id"),
        iteration: parseInt(get("iteration"), 10) || 0,
        hypothesis: get("hypothesis"),
        decision: get("decision") as Decision,
        score_delta: parseFloat(get("score_delta")) || 0,
        tags: [],
        created_at: parseInt(get("created_at"), 10) || Date.now(),
      };

      // Parse tags array
      const tagsMatch = block.match(/tags:\s*\[([^\]]*)\]/);
      if (tagsMatch && tagsMatch[1]) {
        record.tags = tagsMatch[1]
          .split(",")
          .map((t) => t.trim().replace(/^["']|["']$/g, ""))
          .filter((t) => t.length > 0);
      }

      if (record.run_id && record.hypothesis) {
        records.push(record);
      }
    } catch {
      // Skip malformed blocks
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// Learnings Store
// ---------------------------------------------------------------------------

/**
 * In-memory + file-backed learnings store.
 *
 * Records are kept in memory for fast access during a run and flushed
 * to disk for persistence across runs. Supports both JSON-lines and
 * YAML formats.
 */
export class LearningsStore {
  private records: LearningRecord[] = [];
  private readonly filePath: string;
  private dirty = false;
  private format: "jsonl" | "yaml";

  constructor(filePath: string) {
    this.filePath = filePath;
    this.format = filePath.endsWith(".yaml") || filePath.endsWith(".yml") ? "yaml" : "jsonl";
  }

  /** Load existing learnings from the backing file. */
  async load(): Promise<void> {
    try {
      const text = await this.readFile(this.filePath);
      if (!text.trim()) return;

      if (this.format === "yaml") {
        this.records = yamlToRecords(text);
      } else {
        const lines = text.trim().split("\n");
        for (const line of lines) {
          try {
            const record = JSON.parse(line) as LearningRecord;
            this.records.push(record);
          } catch {
            // Skip malformed lines
          }
        }
      }

      console.log(`[Learnings] Loaded ${this.records.length} records from ${this.filePath}`);
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

  /**
   * Return strategy effectiveness: ratio of KEEP to total for each
   * unique tag, sorted by effectiveness.
   */
  getStrategyEffectiveness(): Array<{
    tag: string;
    keepCount: number;
    discardCount: number;
    totalDelta: number;
    avgDelta: number;
    effectiveness: number;
  }> {
    const tagStats = new Map<string, { keep: number; discard: number; totalDelta: number }>();

    for (const r of this.records) {
      for (const tag of r.tags) {
        const stats = tagStats.get(tag) ?? { keep: 0, discard: 0, totalDelta: 0 };
        if (r.decision === "KEEP") stats.keep++;
        else stats.discard++;
        stats.totalDelta += r.score_delta;
        tagStats.set(tag, stats);
      }
    }

    return Array.from(tagStats.entries())
      .map(([tag, stats]) => {
        const total = stats.keep + stats.discard;
        return {
          tag,
          keepCount: stats.keep,
          discardCount: stats.discard,
          totalDelta: stats.totalDelta,
          avgDelta: total > 0 ? stats.totalDelta / total : 0,
          effectiveness: total > 0 ? stats.keep / total : 0,
        };
      })
      .sort((a, b) => b.effectiveness - a.effectiveness);
  }

  /**
   * Get a summary of learnings suitable for injecting into prompts.
   */
  getSummaryForPrompt(maxEntries = 15): string {
    const recent = this.getRecent(maxEntries);
    if (recent.length === 0) return "(no prior learnings)";

    return recent
      .map(
        (r) =>
          `- [${r.decision}] delta=${r.score_delta >= 0 ? "+" : ""}${r.score_delta.toFixed(4)}: ${r.hypothesis}${r.tags.length > 0 ? ` (${r.tags.join(", ")})` : ""}`,
      )
      .join("\n");
  }

  /** Flush dirty records to the backing file. */
  async flush(): Promise<void> {
    if (!this.dirty) return;

    let data: string;
    if (this.format === "yaml") {
      data = this.records.map(recordToYaml).join("\n") + "\n";
    } else {
      data = this.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    }

    await this.writeFile(this.filePath, data);
    this.dirty = false;
    console.log(`[Learnings] Flushed ${this.records.length} records to ${this.filePath}`);
  }

  /** Number of stored records. */
  get size(): number {
    return this.records.length;
  }

  /**
   * Export all records as a YAML string (regardless of backing format).
   */
  toYaml(): string {
    return this.records.map(recordToYaml).join("\n") + "\n";
  }

  /**
   * Export all records as JSON-lines string.
   */
  toJsonl(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  }

  // -----------------------------------------------------------------------
  // Filesystem abstraction (uses Bun APIs when available)
  // -----------------------------------------------------------------------

  protected async readFile(path: string): Promise<string> {
    if (typeof globalThis.Bun !== "undefined") {
      const file = Bun.file(path);
      if (await file.exists()) {
        return file.text();
      }
      return "";
    }
    const fs = await import("node:fs/promises");
    return fs.readFile(path, "utf-8");
  }

  protected async writeFile(path: string, data: string): Promise<void> {
    if (typeof globalThis.Bun !== "undefined") {
      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        try {
          const fs = await import("node:fs/promises");
          await fs.mkdir(dir, { recursive: true });
        } catch { /* ignore */ }
      }
      await Bun.write(path, data);
      return;
    }
    const fs = await import("node:fs/promises");
    const dir = path.substring(0, path.lastIndexOf("/"));
    if (dir) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
    }
    await fs.writeFile(path, data, "utf-8");
  }
}
