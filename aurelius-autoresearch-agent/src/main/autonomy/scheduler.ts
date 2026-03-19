/**
 * Autonomy Scheduler
 *
 * Cron-based scheduling system for autonomous research operations.
 * Manages recurring tasks like compliance scans, proposal reviews,
 * RFP monitoring, and artifact generation.
 */

import type { ScheduleEntry, AutonomyLevel } from "../../shared/types";

export interface ScheduleConfig {
  autonomyLevel: AutonomyLevel;
  timezone: string;
  maxConcurrentTasks: number;
}

interface ScheduledJob {
  entry: ScheduleEntry;
  timer: ReturnType<typeof setTimeout> | null;
  lastRun: number | null;
  nextRun: number | null;
  running: boolean;
}

/** Predefined autonomous operation schedules */
export const DEFAULT_SCHEDULES: ScheduleEntry[] = [
  {
    id: "compliance_scan",
    name: "Compliance Scan",
    cron: "0 */6 * * *", // Every 6 hours
    taskType: "compliance_scan",
    enabled: true,
    autonomyLevel: "supervised",
    payload: { frameworks: ["nist_800_53", "nist_800_171", "cmmc_l2"] },
  },
  {
    id: "proposal_review",
    name: "Proposal Review",
    cron: "0 9 * * 1-5", // Weekdays at 9 AM
    taskType: "proposal_review",
    enabled: true,
    autonomyLevel: "guided",
    payload: { checkReadability: true, checkCompliance: true },
  },
  {
    id: "rfp_watch",
    name: "RFP Watch",
    cron: "*/30 * * * *", // Every 30 minutes
    taskType: "rfp_watch",
    enabled: true,
    autonomyLevel: "supervised",
    payload: { sources: ["sam.gov", "local_inbox"] },
  },
  {
    id: "artifact_generation",
    name: "Artifact Generation",
    cron: "0 2 * * *", // Daily at 2 AM
    taskType: "artifact_generation",
    enabled: false,
    autonomyLevel: "fully_autonomous",
    payload: { generateMissing: true },
  },
  {
    id: "sprs_score_update",
    name: "SPRS Score Update",
    cron: "0 8 * * 1", // Weekly on Monday at 8 AM
    taskType: "sprs_score_update",
    enabled: true,
    autonomyLevel: "supervised",
    payload: {},
  },
  {
    id: "volume_generation",
    name: "Volume Generation",
    cron: "0 3 * * *", // Daily at 3 AM
    taskType: "volume_generation",
    enabled: false,
    autonomyLevel: "fully_autonomous",
    payload: { drafts: true },
  },
];

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private config: ScheduleConfig;
  private running: boolean = false;
  private onTaskTrigger: ((entry: ScheduleEntry) => Promise<void>) | null = null;

  constructor(config?: Partial<ScheduleConfig>) {
    this.config = {
      autonomyLevel: config?.autonomyLevel ?? "supervised",
      timezone: config?.timezone ?? "America/New_York",
      maxConcurrentTasks: config?.maxConcurrentTasks ?? 3,
    };
  }

  /**
   * Initialize the scheduler with default schedules.
   */
  async initialize(
    onTaskTrigger: (entry: ScheduleEntry) => Promise<void>,
  ): Promise<void> {
    this.onTaskTrigger = onTaskTrigger;

    for (const entry of DEFAULT_SCHEDULES) {
      this.registerSchedule(entry);
    }
  }

  /**
   * Start the scheduler, activating all enabled schedules.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const [, job] of this.jobs) {
      if (job.entry.enabled) {
        this.activateJob(job);
      }
    }
  }

  /**
   * Stop the scheduler and cancel all pending timers.
   */
  stop(): void {
    this.running = false;

    for (const [, job] of this.jobs) {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    }
  }

  /**
   * Register a new schedule entry.
   */
  registerSchedule(entry: ScheduleEntry): void {
    const job: ScheduledJob = {
      entry,
      timer: null,
      lastRun: null,
      nextRun: null,
      running: false,
    };

    this.jobs.set(entry.id, job);

    if (this.running && entry.enabled) {
      this.activateJob(job);
    }
  }

  /**
   * Update an existing schedule.
   */
  updateSchedule(id: string, updates: Partial<ScheduleEntry>): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    Object.assign(job.entry, updates);

    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    if (this.running && job.entry.enabled) {
      this.activateJob(job);
    }

    return true;
  }

  /**
   * Remove a schedule by ID.
   */
  removeSchedule(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.timer) {
      clearTimeout(job.timer);
    }

    this.jobs.delete(id);
    return true;
  }

  /**
   * Get all registered schedules with their current state.
   */
  getSchedules(): Array<ScheduleEntry & { lastRun: number | null; nextRun: number | null; running: boolean }> {
    return Array.from(this.jobs.values()).map((job) => ({
      ...job.entry,
      lastRun: job.lastRun,
      nextRun: job.nextRun,
      running: job.running,
    }));
  }

  /**
   * Manually trigger a scheduled task immediately.
   */
  async triggerNow(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !this.onTaskTrigger) return false;

    return this.executeJob(job);
  }

  /**
   * Check if the given autonomy level permits the scheduled task's level.
   */
  isPermitted(entry: ScheduleEntry): boolean {
    const levels: AutonomyLevel[] = ["supervised", "guided", "fully_autonomous"];
    const currentIdx = levels.indexOf(this.config.autonomyLevel);
    const requiredIdx = levels.indexOf(entry.autonomyLevel);
    return requiredIdx <= currentIdx;
  }

  /**
   * Set the global autonomy level, which filters which schedules can run.
   */
  setAutonomyLevel(level: AutonomyLevel): void {
    this.config.autonomyLevel = level;
  }

  private activateJob(job: ScheduledJob): void {
    const nextMs = this.computeNextRunMs(job.entry.cron);
    job.nextRun = Date.now() + nextMs;

    job.timer = setTimeout(async () => {
      await this.executeJob(job);

      if (this.running && job.entry.enabled) {
        this.activateJob(job);
      }
    }, nextMs);
  }

  private async executeJob(job: ScheduledJob): Promise<boolean> {
    if (!this.onTaskTrigger) return false;
    if (!this.isPermitted(job.entry)) return false;

    const runningCount = Array.from(this.jobs.values()).filter((j) => j.running).length;
    if (runningCount >= this.config.maxConcurrentTasks) return false;

    job.running = true;
    job.lastRun = Date.now();

    try {
      await this.onTaskTrigger(job.entry);
      return true;
    } catch (error) {
      console.error(`Schedule ${job.entry.id} failed:`, error);
      return false;
    } finally {
      job.running = false;
    }
  }

  /**
   * Parse a cron expression and compute milliseconds until next trigger.
   * Simplified parser supporting: minute hour dom month dow
   */
  private computeNextRunMs(cron: string): number {
    const parts = cron.split(/\s+/);
    if (parts.length < 5) {
      return 60_000; // Fallback: 1 minute
    }

    const [minutePart] = parts;

    // Handle */N minute patterns
    if (minutePart.startsWith("*/")) {
      const interval = parseInt(minutePart.slice(2), 10);
      return interval * 60_000;
    }

    // Handle fixed minute (run every hour at that minute)
    if (minutePart !== "*" && !minutePart.includes(",") && !minutePart.includes("-")) {
      const targetMinute = parseInt(minutePart, 10);
      const now = new Date();
      const currentMinute = now.getMinutes();
      let diff = targetMinute - currentMinute;
      if (diff <= 0) diff += 60;
      return diff * 60_000;
    }

    // Default: run every hour
    return 3_600_000;
  }
}
