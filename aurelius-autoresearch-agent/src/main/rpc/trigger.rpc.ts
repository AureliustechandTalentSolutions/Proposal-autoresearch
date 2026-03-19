/**
 * Trigger RPC Handler
 *
 * Manages the Trigger.dev v3 task queue: triggering tasks, querying status,
 * retrieving runs, and handling cancellation of in-flight work.
 *
 * Uses the Trigger.dev v3 management API via `@trigger.dev/sdk/v3`:
 *   - `tasks.trigger(taskId, payload)`     - fire-and-forget a single task
 *   - `tasks.batchTrigger(taskId, items)`  - batch trigger
 *   - `runs.retrieve(runId)`               - get run status
 *   - `runs.cancel(runId)`                 - cancel a run
 */

import { tasks, runs, configure } from "@trigger.dev/sdk/v3";
import type {
  TaskDefinition,
  TaskStatus,
  TaskResult,
  RPCResponse,
} from "../../shared/types";

// ── Local tracking type (supplements Trigger.dev server state) ──────────

export interface QueuedTask {
  id: string;
  runId: string | null;
  definition: TaskDefinition;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  enqueuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  result: TaskResult | null;
  error: string | null;
  retryCount: number;
  maxRetries: number;
}

// ── TriggerRPC class ────────────────────────────────────────────────────

export class TriggerRPC {
  private localTasks: Map<string, QueuedTask> = new Map();

  constructor(opts?: { secretKey?: string; apiUrl?: string }) {
    // Configure the Trigger.dev v3 SDK so that `tasks` and `runs` helpers
    // know which server and project to talk to.
    configure({
      secretKey: opts?.secretKey ?? process.env.TRIGGER_API_KEY,
      baseURL: opts?.apiUrl ?? process.env.TRIGGER_API_URL ?? "http://localhost:3030",
    });
  }

  // ── Enqueue ─────────────────────────────────────────────────────────

  /**
   * Trigger a new task for execution via Trigger.dev v3.
   *
   * Calls `tasks.trigger(taskType, payload)` which returns a run handle.
   */
  async enqueue(definition: TaskDefinition): Promise<RPCResponse<{ taskId: string }>> {
    const taskId = crypto.randomUUID();

    const queued: QueuedTask = {
      id: taskId,
      runId: null,
      definition,
      status: "queued",
      enqueuedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      retryCount: 0,
      maxRetries: definition.maxRetries ?? 3,
    };

    this.localTasks.set(taskId, queued);

    try {
      // Trigger.dev v3: tasks.trigger() accepts the task ID string and
      // a payload object, returning a handle with the server-assigned run ID.
      const handle = await tasks.trigger(definition.taskType, {
        taskId,
        ...definition.payload,
      });

      queued.runId = handle.id;
      queued.status = "running";
      queued.startedAt = Date.now();

      return { ok: true, data: { taskId } };
    } catch (error) {
      queued.status = "failed";
      queued.error = errorMessage(error);
      return { ok: false, error: queued.error };
    }
  }

  // ── Batch enqueue ──────────────────────────────────────────────────

  /**
   * Enqueue multiple tasks as a batch.
   *
   * Uses `tasks.batchTrigger()` when all definitions share the same
   * task type, otherwise falls back to sequential triggering.
   */
  async enqueueBatch(
    definitions: TaskDefinition[],
  ): Promise<RPCResponse<{ taskIds: string[] }>> {
    const taskIds: string[] = [];
    const errors: string[] = [];

    // Group by task type to leverage batchTrigger where possible
    const grouped = new Map<string, { taskId: string; def: TaskDefinition }[]>();
    for (const def of definitions) {
      const taskId = crypto.randomUUID();
      const group = grouped.get(def.taskType) ?? [];
      group.push({ taskId, def });
      grouped.set(def.taskType, group);

      this.localTasks.set(taskId, {
        id: taskId,
        runId: null,
        definition: def,
        status: "queued",
        enqueuedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        retryCount: 0,
        maxRetries: def.maxRetries ?? 3,
      });
    }

    for (const [taskType, items] of grouped) {
      try {
        const batchHandle = await tasks.batchTrigger(
          taskType,
          items.map((item) => ({
            payload: { taskId: item.taskId, ...item.def.payload },
          })),
        );

        // Map run handles back to local tasks
        for (let i = 0; i < items.length; i++) {
          const local = this.localTasks.get(items[i].taskId);
          if (local && batchHandle.runs[i]) {
            local.runId = batchHandle.runs[i].id;
            local.status = "running";
            local.startedAt = Date.now();
          }
          taskIds.push(items[i].taskId);
        }
      } catch (error) {
        const msg = errorMessage(error);
        for (const item of items) {
          const local = this.localTasks.get(item.taskId);
          if (local) {
            local.status = "failed";
            local.error = msg;
          }
          errors.push(msg);
        }
      }
    }

    if (errors.length > 0 && taskIds.length === 0) {
      return { ok: false, error: `All tasks failed: ${errors.join("; ")}` };
    }

    return { ok: true, data: { taskIds } };
  }

  // ── Status ─────────────────────────────────────────────────────────

  /**
   * Query the status of a specific task.
   *
   * First checks the Trigger.dev server via `runs.retrieve()`, then
   * falls back to local state.
   */
  async getTaskStatus(taskId: string): Promise<RPCResponse<TaskStatus>> {
    const local = this.localTasks.get(taskId);
    if (!local) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    // If we have a server-side run ID, refresh from the Trigger.dev API
    if (local.runId) {
      try {
        const run = await runs.retrieve(local.runId);
        local.status = mapRunStatus(run.status);
        if (run.startedAt) local.startedAt = new Date(run.startedAt).getTime();
        if (run.finishedAt) local.completedAt = new Date(run.finishedAt).getTime();
      } catch {
        // Fall back to local state if the server is unreachable
      }
    }

    return {
      ok: true,
      data: {
        id: local.id,
        taskType: local.definition.taskType,
        status: local.status,
        enqueuedAt: local.enqueuedAt,
        startedAt: local.startedAt,
        completedAt: local.completedAt,
        retryCount: local.retryCount,
        maxRetries: local.maxRetries,
      },
    };
  }

  // ── List ───────────────────────────────────────────────────────────

  /**
   * List all tasks, optionally filtered by status.
   */
  async listTasks(params?: {
    status?: QueuedTask["status"];
    taskType?: string;
    limit?: number;
    offset?: number;
  }): Promise<RPCResponse<TaskStatus[]>> {
    let taskList = Array.from(this.localTasks.values());

    if (params?.status) {
      taskList = taskList.filter((t) => t.status === params.status);
    }
    if (params?.taskType) {
      taskList = taskList.filter((t) => t.definition.taskType === params.taskType);
    }

    taskList.sort((a, b) => b.enqueuedAt - a.enqueuedAt);

    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 50;
    taskList = taskList.slice(offset, offset + limit);

    return {
      ok: true,
      data: taskList.map((t) => ({
        id: t.id,
        taskType: t.definition.taskType,
        status: t.status,
        enqueuedAt: t.enqueuedAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        retryCount: t.retryCount,
        maxRetries: t.maxRetries,
      })),
    };
  }

  // ── Cancel ─────────────────────────────────────────────────────────

  /**
   * Cancel a queued or running task.
   *
   * Calls `runs.cancel()` on the Trigger.dev server.
   */
  async cancelTask(taskId: string): Promise<RPCResponse<void>> {
    const local = this.localTasks.get(taskId);
    if (!local) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    if (local.status === "completed" || local.status === "cancelled") {
      return { ok: false, error: `Task is already ${local.status}` };
    }

    // Cancel on the Trigger.dev server
    if (local.runId) {
      try {
        await runs.cancel(local.runId);
      } catch {
        // Best-effort remote cancellation
      }
    }

    local.status = "cancelled";
    local.completedAt = Date.now();

    return { ok: true, data: undefined };
  }

  // ── Callbacks ──────────────────────────────────────────────────────

  /**
   * Record a task completion callback from Trigger.dev.
   */
  async onTaskComplete(taskId: string, result: TaskResult): Promise<RPCResponse<void>> {
    const local = this.localTasks.get(taskId);
    if (!local) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    local.status = "completed";
    local.completedAt = Date.now();
    local.result = result;

    return { ok: true, data: undefined };
  }

  /**
   * Record a task failure callback from Trigger.dev.
   */
  async onTaskFailed(taskId: string, error: string): Promise<RPCResponse<void>> {
    const local = this.localTasks.get(taskId);
    if (!local) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    if (local.retryCount < local.maxRetries) {
      local.retryCount++;
      local.status = "queued";
      local.error = error;
    } else {
      local.status = "failed";
      local.completedAt = Date.now();
      local.error = error;
    }

    return { ok: true, data: undefined };
  }

  // ── Purge ──────────────────────────────────────────────────────────

  /**
   * Purge completed or failed tasks older than the given age in milliseconds.
   */
  async purgeTasks(maxAgeMs: number = 86_400_000): Promise<RPCResponse<{ purged: number }>> {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;

    for (const [id, task] of this.localTasks) {
      if (
        (task.status === "completed" || task.status === "failed" || task.status === "cancelled") &&
        (task.completedAt ?? task.enqueuedAt) < cutoff
      ) {
        this.localTasks.delete(id);
        purged++;
      }
    }

    return { ok: true, data: { purged } };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Map a Trigger.dev v3 run status string to our local status enum.
 */
function mapRunStatus(
  serverStatus: string,
): QueuedTask["status"] {
  switch (serverStatus) {
    case "QUEUED":
    case "PENDING":
    case "WAITING":
      return "queued";
    case "EXECUTING":
    case "REATTEMPTING":
      return "running";
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "CRASHED":
    case "SYSTEM_FAILURE":
    case "TIMED_OUT":
    case "INTERRUPTED":
      return "failed";
    case "CANCELED":
    case "CANCELLED":
      return "cancelled";
    default:
      return "running";
  }
}
