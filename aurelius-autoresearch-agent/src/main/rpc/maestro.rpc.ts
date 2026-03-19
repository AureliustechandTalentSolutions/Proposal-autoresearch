/**
 * Maestro RPC Handler
 *
 * Manages the autonomous research loop: scheduling, status queries,
 * and orchestration of the hypothesis-modify-score cycle.
 */

import type {
  LoopStatus,
  ScheduleEntry,
  AutonomyLevel,
  MaestroCommand,
  RPCResponse,
} from "../../shared/types";
import { IPC_CHANNELS } from "../../shared/constants";

export interface MaestroLoopState {
  running: boolean;
  currentCycle: number;
  totalCycles: number;
  phase: "idle" | "hypothesis" | "modify" | "score" | "review" | "export";
  startedAt: number | null;
  lastCompletedAt: number | null;
  autonomyLevel: AutonomyLevel;
  errors: string[];
}

export class MaestroRPC {
  private state: MaestroLoopState = {
    running: false,
    currentCycle: 0,
    totalCycles: 0,
    phase: "idle",
    startedAt: null,
    lastCompletedAt: null,
    autonomyLevel: "supervised",
    errors: [],
  };

  private schedules: Map<string, ScheduleEntry> = new Map();

  /**
   * Start the autonomous research loop with a given configuration.
   */
  async startLoop(params: {
    totalCycles: number;
    autonomyLevel: AutonomyLevel;
    targetArtifact?: string;
  }): Promise<RPCResponse<LoopStatus>> {
    if (this.state.running) {
      return {
        ok: false,
        error: "Loop is already running",
      };
    }

    this.state = {
      running: true,
      currentCycle: 0,
      totalCycles: params.totalCycles,
      phase: "hypothesis",
      startedAt: Date.now(),
      lastCompletedAt: null,
      autonomyLevel: params.autonomyLevel,
      errors: [],
    };

    return {
      ok: true,
      data: this.getLoopStatus(),
    };
  }

  /**
   * Pause the loop, preserving state for resumption.
   */
  async pauseLoop(): Promise<RPCResponse<LoopStatus>> {
    if (!this.state.running) {
      return { ok: false, error: "Loop is not running" };
    }

    this.state.running = false;
    this.state.phase = "idle";

    return { ok: true, data: this.getLoopStatus() };
  }

  /**
   * Resume a paused loop from the last checkpoint.
   */
  async resumeLoop(): Promise<RPCResponse<LoopStatus>> {
    if (this.state.running) {
      return { ok: false, error: "Loop is already running" };
    }

    if (this.state.currentCycle === 0 && this.state.startedAt === null) {
      return { ok: false, error: "No loop to resume; start a new loop" };
    }

    this.state.running = true;
    this.state.phase = "hypothesis";

    return { ok: true, data: this.getLoopStatus() };
  }

  /**
   * Stop the loop entirely and reset state.
   */
  async stopLoop(): Promise<RPCResponse<void>> {
    this.state = {
      running: false,
      currentCycle: 0,
      totalCycles: 0,
      phase: "idle",
      startedAt: null,
      lastCompletedAt: null,
      autonomyLevel: "supervised",
      errors: [],
    };

    return { ok: true, data: undefined };
  }

  /**
   * Query current loop status.
   */
  async getStatus(): Promise<RPCResponse<LoopStatus>> {
    return { ok: true, data: this.getLoopStatus() };
  }

  /**
   * Advance the loop to the next phase (used by scheduler or manual step).
   */
  async advancePhase(): Promise<RPCResponse<LoopStatus>> {
    if (!this.state.running) {
      return { ok: false, error: "Loop is not running" };
    }

    const phases: MaestroLoopState["phase"][] = [
      "hypothesis",
      "modify",
      "score",
      "review",
      "export",
    ];
    const currentIndex = phases.indexOf(this.state.phase);

    if (currentIndex === phases.length - 1) {
      this.state.currentCycle++;
      this.state.lastCompletedAt = Date.now();

      if (this.state.currentCycle >= this.state.totalCycles) {
        this.state.running = false;
        this.state.phase = "idle";
      } else {
        this.state.phase = "hypothesis";
      }
    } else {
      this.state.phase = phases[currentIndex + 1];
    }

    return { ok: true, data: this.getLoopStatus() };
  }

  /**
   * Register or update a schedule entry.
   */
  async setSchedule(entry: ScheduleEntry): Promise<RPCResponse<void>> {
    this.schedules.set(entry.id, entry);
    return { ok: true, data: undefined };
  }

  /**
   * List all registered schedules.
   */
  async listSchedules(): Promise<RPCResponse<ScheduleEntry[]>> {
    return { ok: true, data: Array.from(this.schedules.values()) };
  }

  /**
   * Remove a schedule by ID.
   */
  async removeSchedule(id: string): Promise<RPCResponse<void>> {
    this.schedules.delete(id);
    return { ok: true, data: undefined };
  }

  /**
   * Execute a named command against the maestro subsystem.
   */
  async executeCommand(cmd: MaestroCommand): Promise<RPCResponse<unknown>> {
    switch (cmd.type) {
      case "start":
        return this.startLoop(cmd.params);
      case "pause":
        return this.pauseLoop();
      case "resume":
        return this.resumeLoop();
      case "stop":
        return this.stopLoop();
      case "status":
        return this.getStatus();
      case "advance":
        return this.advancePhase();
      default:
        return { ok: false, error: `Unknown command: ${(cmd as any).type}` };
    }
  }

  private getLoopStatus(): LoopStatus {
    return {
      running: this.state.running,
      currentCycle: this.state.currentCycle,
      totalCycles: this.state.totalCycles,
      phase: this.state.phase,
      startedAt: this.state.startedAt,
      lastCompletedAt: this.state.lastCompletedAt,
      autonomyLevel: this.state.autonomyLevel,
      errorCount: this.state.errors.length,
    };
  }
}
