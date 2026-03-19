/**
 * File Watcher
 *
 * Monitors the incoming RFPs directory for new files and triggers
 * appropriate processing pipelines when documents arrive.
 */

import { watch, type FSWatcher } from "fs";
import { readdir, stat } from "fs/promises";
import { join, extname, basename } from "path";
import type { WatcherEvent, RPCResponse } from "../../shared/types";

export interface WatcherConfig {
  /** Directory to monitor for incoming RFPs */
  watchDir: string;
  /** File extensions to process */
  extensions: string[];
  /** Polling interval in ms (fallback when native watch unavailable) */
  pollIntervalMs: number;
  /** Debounce window to avoid duplicate events */
  debounceMs: number;
  /** Whether to process existing files on startup */
  processExisting: boolean;
}

const DEFAULT_CONFIG: WatcherConfig = {
  watchDir: "./incoming/rfps",
  extensions: [".pdf", ".docx", ".doc", ".txt", ".xlsx", ".zip"],
  pollIntervalMs: 5_000,
  debounceMs: 1_000,
  processExisting: false,
};

export class Watcher {
  private config: WatcherConfig;
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private knownFiles: Set<string> = new Set();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running: boolean = false;
  private onFileDetected: ((event: WatcherEvent) => Promise<void>) | null = null;
  private eventLog: WatcherEvent[] = [];

  constructor(config?: Partial<WatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the watcher with a callback for detected files.
   */
  async initialize(
    onFileDetected: (event: WatcherEvent) => Promise<void>,
  ): Promise<void> {
    this.onFileDetected = onFileDetected;

    // Scan existing files to populate the known set
    await this.scanDirectory();
  }

  /**
   * Start watching the configured directory.
   */
  async start(): Promise<RPCResponse<void>> {
    if (this.running) {
      return { ok: false, error: "Watcher is already running" };
    }

    this.running = true;

    try {
      // Try native fs.watch first
      this.fsWatcher = watch(this.config.watchDir, { recursive: false }, (eventType, filename) => {
        if (filename && eventType === "rename") {
          this.handleFileChange(filename);
        }
      });

      this.fsWatcher.on("error", () => {
        // Fallback to polling if native watch fails
        this.startPolling();
      });
    } catch {
      // Native watch not available, use polling
      this.startPolling();
    }

    if (this.config.processExisting) {
      await this.processExistingFiles();
    }

    return { ok: true, data: undefined };
  }

  /**
   * Stop the watcher.
   */
  stop(): RPCResponse<void> {
    this.running = false;

    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    return { ok: true, data: undefined };
  }

  /**
   * Get the current watcher status.
   */
  getStatus(): {
    running: boolean;
    watchDir: string;
    knownFileCount: number;
    recentEvents: WatcherEvent[];
  } {
    return {
      running: this.running,
      watchDir: this.config.watchDir,
      knownFileCount: this.knownFiles.size,
      recentEvents: this.eventLog.slice(-20),
    };
  }

  /**
   * Manually trigger a rescan of the watch directory.
   */
  async rescan(): Promise<RPCResponse<{ newFiles: string[] }>> {
    const before = new Set(this.knownFiles);
    await this.scanDirectory();
    const newFiles = Array.from(this.knownFiles).filter((f) => !before.has(f));
    return { ok: true, data: { newFiles } };
  }

  /**
   * Update watcher configuration (restarts if running).
   */
  async updateConfig(updates: Partial<WatcherConfig>): Promise<RPCResponse<void>> {
    const wasRunning = this.running;

    if (wasRunning) {
      this.stop();
    }

    Object.assign(this.config, updates);

    if (wasRunning) {
      return this.start();
    }

    return { ok: true, data: undefined };
  }

  private async scanDirectory(): Promise<void> {
    try {
      const entries = await readdir(this.config.watchDir);
      for (const entry of entries) {
        const ext = extname(entry).toLowerCase();
        if (this.config.extensions.includes(ext)) {
          this.knownFiles.add(entry);
        }
      }
    } catch {
      // Directory may not exist yet; that is acceptable
    }
  }

  private async processExistingFiles(): Promise<void> {
    for (const filename of this.knownFiles) {
      await this.emitEvent(filename, "existing");
    }
  }

  private handleFileChange(filename: string): void {
    const ext = extname(filename).toLowerCase();
    if (!this.config.extensions.includes(ext)) return;

    // Debounce rapid events for the same file
    const existing = this.debounceTimers.get(filename);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filename);
      const isNew = !this.knownFiles.has(filename);
      this.knownFiles.add(filename);

      if (isNew) {
        await this.emitEvent(filename, "created");
      } else {
        await this.emitEvent(filename, "modified");
      }
    }, this.config.debounceMs);

    this.debounceTimers.set(filename, timer);
  }

  private startPolling(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      try {
        const entries = await readdir(this.config.watchDir);
        for (const entry of entries) {
          const ext = extname(entry).toLowerCase();
          if (!this.config.extensions.includes(ext)) continue;

          if (!this.knownFiles.has(entry)) {
            this.knownFiles.add(entry);
            await this.emitEvent(entry, "created");
          }
        }
      } catch {
        // Directory may not exist yet
      }
    }, this.config.pollIntervalMs);
  }

  private async emitEvent(
    filename: string,
    type: "created" | "modified" | "existing",
  ): Promise<void> {
    const filePath = join(this.config.watchDir, filename);
    let fileSize = 0;

    try {
      const fileStat = await stat(filePath);
      fileSize = fileStat.size;
    } catch {
      // File may have been removed
    }

    const event: WatcherEvent = {
      type,
      filename,
      filePath,
      fileSize,
      extension: extname(filename).toLowerCase(),
      detectedAt: Date.now(),
    };

    this.eventLog.push(event);
    if (this.eventLog.length > 1_000) {
      this.eventLog = this.eventLog.slice(-500);
    }

    if (this.onFileDetected) {
      try {
        await this.onFileDetected(event);
      } catch (error) {
        console.error(`Watcher callback error for ${filename}:`, error);
      }
    }
  }
}
