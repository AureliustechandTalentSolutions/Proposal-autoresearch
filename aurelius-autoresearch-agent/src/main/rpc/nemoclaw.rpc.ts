/**
 * NemoClaw RPC Handler
 *
 * Manages sandboxed execution environments via Docker-in-Docker (OpenShell),
 * routes policy queries, and records security events.
 */

import type {
  SandboxSession,
  SandboxConfig,
  PolicyQuery,
  PolicyResult,
  SecurityEvent,
  RPCResponse,
} from "../../shared/types";

export interface SandboxState {
  id: string;
  containerId: string | null;
  status: "creating" | "running" | "paused" | "stopped" | "error";
  createdAt: number;
  lastActivityAt: number;
  config: SandboxConfig;
}

export class NemoClawRPC {
  private sessions: Map<string, SandboxState> = new Map();
  private securityLog: SecurityEvent[] = [];
  private openshellEndpoint: string;

  constructor(openshellEndpoint: string = "http://localhost:2376") {
    this.openshellEndpoint = openshellEndpoint;
  }

  /**
   * Create a new sandboxed execution environment.
   */
  async createSandbox(config: SandboxConfig): Promise<RPCResponse<SandboxSession>> {
    const sessionId = crypto.randomUUID();

    const state: SandboxState = {
      id: sessionId,
      containerId: null,
      status: "creating",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      config,
    };

    this.sessions.set(sessionId, state);

    try {
      const response = await fetch(`${this.openshellEndpoint}/containers/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Image: config.image || "ubuntu:22.04",
          Cmd: config.entrypoint || ["/bin/bash"],
          Tty: true,
          OpenStdin: true,
          NetworkDisabled: !config.networkAccess,
          HostConfig: {
            Memory: config.memoryLimitMb
              ? config.memoryLimitMb * 1024 * 1024
              : 512 * 1024 * 1024,
            CpuQuota: config.cpuQuota || 50000,
            ReadonlyRootfs: config.readonlyRoot ?? true,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Container creation failed: ${response.statusText}`);
      }

      const container = (await response.json()) as { Id: string };
      state.containerId = container.Id;
      state.status = "running";

      this.recordEvent({
        type: "sandbox_created",
        sessionId,
        containerId: container.Id,
        timestamp: Date.now(),
        details: { config },
      });

      return {
        ok: true,
        data: {
          id: sessionId,
          containerId: container.Id,
          status: "running",
          endpoint: `${this.openshellEndpoint}/containers/${container.Id}`,
        },
      };
    } catch (error) {
      state.status = "error";
      const message = error instanceof Error ? error.message : String(error);

      this.recordEvent({
        type: "sandbox_error",
        sessionId,
        containerId: null,
        timestamp: Date.now(),
        details: { error: message },
      });

      return { ok: false, error: message };
    }
  }

  /**
   * Execute a command inside a running sandbox.
   */
  async execInSandbox(
    sessionId: string,
    command: string[],
  ): Promise<RPCResponse<{ exitCode: number; stdout: string; stderr: string }>> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.containerId) {
      return { ok: false, error: `Session not found: ${sessionId}` };
    }

    if (session.status !== "running") {
      return { ok: false, error: `Session is not running: ${session.status}` };
    }

    try {
      const execCreate = await fetch(
        `${this.openshellEndpoint}/containers/${session.containerId}/exec`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            Cmd: command,
            AttachStdout: true,
            AttachStderr: true,
          }),
        },
      );

      if (!execCreate.ok) {
        throw new Error(`Exec creation failed: ${execCreate.statusText}`);
      }

      const exec = (await execCreate.json()) as { Id: string };

      const execStart = await fetch(
        `${this.openshellEndpoint}/exec/${exec.Id}/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Detach: false, Tty: false }),
        },
      );

      const output = await execStart.text();
      session.lastActivityAt = Date.now();

      return {
        ok: true,
        data: { exitCode: 0, stdout: output, stderr: "" },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * Destroy a sandbox and release resources.
   */
  async destroySandbox(sessionId: string): Promise<RPCResponse<void>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: `Session not found: ${sessionId}` };
    }

    if (session.containerId) {
      try {
        await fetch(
          `${this.openshellEndpoint}/containers/${session.containerId}?force=true`,
          { method: "DELETE" },
        );
      } catch {
        // Best-effort cleanup
      }
    }

    this.sessions.delete(sessionId);

    this.recordEvent({
      type: "sandbox_destroyed",
      sessionId,
      containerId: session.containerId,
      timestamp: Date.now(),
      details: {},
    });

    return { ok: true, data: undefined };
  }

  /**
   * List all active sandbox sessions.
   */
  async listSessions(): Promise<RPCResponse<SandboxSession[]>> {
    const sessions: SandboxSession[] = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      containerId: s.containerId,
      status: s.status,
      endpoint: s.containerId
        ? `${this.openshellEndpoint}/containers/${s.containerId}`
        : null,
    }));

    return { ok: true, data: sessions };
  }

  /**
   * Query an OPA policy for a given input context.
   */
  async queryPolicy(query: PolicyQuery): Promise<RPCResponse<PolicyResult>> {
    try {
      const response = await fetch(`http://localhost:8181/v1/data/${query.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: query.input }),
      });

      if (!response.ok) {
        throw new Error(`Policy query failed: ${response.statusText}`);
      }

      const result = (await response.json()) as { result: unknown };

      return {
        ok: true,
        data: {
          allowed: Boolean(result.result),
          score: typeof result.result === "number" ? result.result : undefined,
          details: result,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * Retrieve the security event log, optionally filtered.
   */
  async getSecurityEvents(params?: {
    type?: string;
    since?: number;
    limit?: number;
  }): Promise<RPCResponse<SecurityEvent[]>> {
    let events = this.securityLog;

    if (params?.type) {
      events = events.filter((e) => e.type === params.type);
    }
    if (params?.since) {
      events = events.filter((e) => e.timestamp >= params.since!);
    }
    if (params?.limit) {
      events = events.slice(-params.limit);
    }

    return { ok: true, data: events };
  }

  private recordEvent(event: SecurityEvent): void {
    this.securityLog.push(event);

    // Cap the log at 10,000 entries
    if (this.securityLog.length > 10_000) {
      this.securityLog = this.securityLog.slice(-5_000);
    }
  }
}
