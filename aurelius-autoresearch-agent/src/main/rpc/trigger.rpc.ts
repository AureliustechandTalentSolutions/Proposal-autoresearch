/**
 * Trigger RPC Handler
 *
 * Manages the Trigger.dev task queue: enqueueing tasks, querying status,
 * and handling cancellation of in-flight work.
 */

import type {
  TaskDefinition,
  TaskStatus,
  TaskResult,
  RPCResponse,
} from "../../shared/types";

export interface QueuedTask {
  id: string;
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

export class TriggerRPC {
  private tasks: Map<string, QueuedTask> = new Map();
  private triggerEndpoint: string;

  constructor(triggerEndpoint: string = "http://localhost:3030") {
    this.triggerEndpoint = triggerEndpoint;
  }

  /**
   * Enqueue a new task for execution via Trigger.dev.
   */
  async enqueue(definition: TaskDefinition): Promise<RPCResponse<{ taskId: string }>> {
    const taskId = crypto.randomUUID();

    const queued: QueuedTask = {
      id: taskId,
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

    this.tasks.set(taskId, queued);

    try {
      const response = await fetch(`${this.triggerEndpoint}/api/v1/tasks/trigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: definition.taskType,
          payload: {
            taskId,
            ...definition.payload,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Trigger API error: ${response.statusText}`);
      }

      queued.status = "running";
      queued.startedAt = Date.now();

      return { ok: true, data: { taskId } };
    } catch (error) {
      queued.status = "failed";
      queued.error = error instanceof Error ? error.message : String(error);
      return { ok: false, error: queued.error };
    }
  }

  /**
   * Enqueue multiple tasks as a batch.
   */
  async enqueueBatch(
    definitions: TaskDefinition[],
  ): Promise<RPCResponse<{ taskIds: string[] }>> {
    const taskIds: string[] = [];
    const errors: string[] = [];

    for (const def of definitions) {
      const result = await this.enqueue(def);
      if (result.ok && result.data) {
        taskIds.push(result.data.taskId);
      } else {
        errors.push(result.error || "Unknown error");
      }
    }

    if (errors.length > 0 && taskIds.length === 0) {
      return { ok: false, error: `All tasks failed: ${errors.join("; ")}` };
    }

    return { ok: true, data: { taskIds } };
  }

  /**
   * Query the status of a specific task.
   */
  async getTaskStatus(taskId: string): Promise<RPCResponse<TaskStatus>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    return {
      ok: true,
      data: {
        id: task.id,
        taskType: task.definition.taskType,
        status: task.status,
        enqueuedAt: task.enqueuedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        retryCount: task.retryCount,
        maxRetries: task.maxRetries,
      },
    };
  }

  /**
   * List all tasks, optionally filtered by status.
   */
  async listTasks(params?: {
    status?: QueuedTask["status"];
    taskType?: string;
    limit?: number;
    offset?: number;
  }): Promise<RPCResponse<TaskStatus[]>> {
    let tasks = Array.from(this.tasks.values());

    if (params?.status) {
      tasks = tasks.filter((t) => t.status === params.status);
    }
    if (params?.taskType) {
      tasks = tasks.filter((t) => t.definition.taskType === params.taskType);
    }

    tasks.sort((a, b) => b.enqueuedAt - a.enqueuedAt);

    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 50;
    tasks = tasks.slice(offset, offset + limit);

    return {
      ok: true,
      data: tasks.map((t) => ({
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

  /**
   * Cancel a queued or running task.
   */
  async cancelTask(taskId: string): Promise<RPCResponse<void>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    if (task.status === "completed" || task.status === "cancelled") {
      return { ok: false, error: `Task is already ${task.status}` };
    }

    try {
      await fetch(`${this.triggerEndpoint}/api/v1/tasks/${taskId}/cancel`, {
        method: "POST",
      });
    } catch {
      // Best-effort remote cancellation
    }

    task.status = "cancelled";
    task.completedAt = Date.now();

    return { ok: true, data: undefined };
  }

  /**
   * Record a task completion callback from Trigger.dev.
   */
  async onTaskComplete(
    taskId: string,
    result: TaskResult,
  ): Promise<RPCResponse<void>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    task.status = "completed";
    task.completedAt = Date.now();
    task.result = result;

    return { ok: true, data: undefined };
  }

  /**
   * Record a task failure callback from Trigger.dev.
   */
  async onTaskFailed(
    taskId: string,
    error: string,
  ): Promise<RPCResponse<void>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { ok: false, error: `Task not found: ${taskId}` };
    }

    if (task.retryCount < task.maxRetries) {
      task.retryCount++;
      task.status = "queued";
      task.error = error;
    } else {
      task.status = "failed";
      task.completedAt = Date.now();
      task.error = error;
    }

    return { ok: true, data: undefined };
  }

  /**
   * Purge completed or failed tasks older than the given age in milliseconds.
   */
  async purgeTasks(maxAgeMs: number = 86_400_000): Promise<RPCResponse<{ purged: number }>> {
    const cutoff = Date.now() - maxAgeMs;
    let purged = 0;

    for (const [id, task] of this.tasks) {
      if (
        (task.status === "completed" || task.status === "failed" || task.status === "cancelled") &&
        (task.completedAt ?? task.enqueuedAt) < cutoff
      ) {
        this.tasks.delete(id);
        purged++;
      }
    }

    return { ok: true, data: { purged } };
  }
}
