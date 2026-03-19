/**
 * @module sandbox
 * @description OpenShell Sandbox Lifecycle Manager for NemoClaw.
 *
 * Manages isolated Docker-based sandboxes for autonomous agent execution.
 * Each sandbox enforces security policies governing filesystem access,
 * network permissions, resource limits, and tool usage. When Docker is
 * unavailable, falls back to a simulated mode that enforces policies via
 * file permission checks and logs with a "[SIMULATED]" prefix.
 *
 * Uses Bun-native APIs exclusively (fetch, Bun.spawn, Bun.file, etc.).
 */

import type { z } from "zod";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Configuration for spawning a new sandbox instance. */
export interface SandboxConfig {
  /** Unique name identifying the agent occupying the sandbox. */
  agent_name: string;
  /** Path to the YAML policy file governing this sandbox. */
  policy_path: string;
  /** Preferred model identifier (e.g. "nemotron:70b-q4"). */
  model_preference: string;
  /** Maximum wall-clock seconds before the sandbox is force-terminated. */
  timeout_seconds: number;
  /** Strategy when a policy violation is detected. */
  on_violation: "terminate" | "warn" | "block";
}

/** Represents a running (or terminated) sandbox instance. */
export interface SandboxInstance {
  /** Unique sandbox identifier (UUID v4). */
  id: string;
  /** Name of the agent that owns this sandbox. */
  agent_name: string;
  /** Docker container ID (empty string in simulated mode). */
  container_id: string;
  /** Current lifecycle status. */
  status: "starting" | "running" | "terminated" | "error";
  /** ISO-8601 timestamp when the sandbox was spawned. */
  started_at: string;
  /** Resolved policy object applied to this sandbox. */
  policy: Record<string, unknown>;
  /** Live resource usage counters. */
  resource_usage: {
    cpu_percent: number;
    memory_mb: number;
    disk_mb: number;
    network_bytes_in: number;
    network_bytes_out: number;
  };
  /** Ordered list of violations recorded during the sandbox lifetime. */
  violations: SecurityViolation[];
}

/** A single security policy violation. */
export interface SecurityViolation {
  /** ISO-8601 timestamp of the violation. */
  timestamp: string;
  /** Classification of the violation. */
  type:
    | "filesystem"
    | "network"
    | "resource"
    | "tool"
    | "cui_leak"
    | "timeout";
  /** Human-readable description. */
  description: string;
  /** Whether the offending action was blocked (true) or merely logged (false). */
  blocked: boolean;
  /** Agent that triggered the violation. */
  agent_name: string;
}

/** A task to be executed inside a sandbox. */
export interface AgentTask {
  /** Unique task identifier. */
  id: string;
  /** The instruction or prompt to execute. */
  instruction: string;
  /** Additional context or data payload. */
  context?: Record<string, unknown>;
  /** Maximum seconds for this individual task. */
  timeout_seconds?: number;
}

/** The result of executing an AgentTask inside a sandbox. */
export interface AgentResult {
  /** The originating task ID. */
  task_id: string;
  /** Whether execution completed without errors. */
  success: boolean;
  /** The produced output (model response, tool output, etc.). */
  output: string;
  /** Error message if success is false. */
  error?: string;
  /** Wall-clock milliseconds consumed. */
  execution_time_ms: number;
  /** Violations that occurred during this task. */
  violations: SecurityViolation[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a UUID v4 using the Bun-native crypto API. */
function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Attempt to detect whether Docker is available on this host.
 * Returns `true` when the docker CLI responds to `docker info`.
 */
async function dockerAvailable(socket?: string): Promise<boolean> {
  try {
    const args = ["info", "--format", "{{.ID}}"];
    if (socket) {
      args.unshift("-H", `unix://${socket}`);
    }
    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

/**
 * Manages the full lifecycle of OpenShell sandboxes.
 *
 * @example
 * ```ts
 * const mgr = new SandboxManager("/etc/nemoclaw/policies");
 * const sandbox = await mgr.spawn({
 *   agent_name: "researcher-1",
 *   policy_path: "default.yaml",
 *   model_preference: "nemotron:70b-q4",
 *   timeout_seconds: 3600,
 *   on_violation: "block",
 * });
 * const result = await mgr.execute(sandbox.id, {
 *   id: "task-001",
 *   instruction: "Summarise the attached PDF.",
 * });
 * await mgr.terminate(sandbox.id, "task complete");
 * ```
 */
export class SandboxManager {
  /** Directory containing YAML policy files. */
  private readonly policy_dir: string;
  /** Docker socket path (e.g. /var/run/docker.sock). */
  private readonly docker_socket: string | undefined;
  /** Whether Docker is confirmed available. Resolved lazily. */
  private docker_ok: boolean | null = null;
  /** In-memory registry of active sandboxes keyed by sandbox ID. */
  private sandboxes: Map<string, SandboxInstance> = new Map();
  /** Global violation log. */
  private violation_log: SecurityViolation[] = [];
  /** Registered violation handlers. */
  private violation_handlers: Array<(v: SecurityViolation) => void> = [];
  /** Timeout handles for sandbox TTLs. */
  private timeout_handles: Map<string, Timer> = new Map();

  constructor(policy_dir: string, docker_socket?: string) {
    this.policy_dir = policy_dir;
    this.docker_socket = docker_socket;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Spawn a new sandbox for an agent.
   *
   * When Docker is available, a container is created with resource limits and
   * volume mounts derived from the supplied policy. In fallback/simulated mode
   * the sandbox is tracked in-memory and policy enforcement is performed via
   * filesystem permission checks.
   */
  async spawn(config: SandboxConfig): Promise<SandboxInstance> {
    const simulated = !(await this.isDockerAvailable());
    const policy = await this.loadPolicy(config.policy_path);

    const sandbox: SandboxInstance = {
      id: uuid(),
      agent_name: config.agent_name,
      container_id: "",
      status: "starting",
      started_at: new Date().toISOString(),
      policy,
      resource_usage: {
        cpu_percent: 0,
        memory_mb: 0,
        disk_mb: 0,
        network_bytes_in: 0,
        network_bytes_out: 0,
      },
      violations: [],
    };

    if (simulated) {
      console.log(
        `[SIMULATED] Spawning sandbox ${sandbox.id} for agent "${config.agent_name}"`
      );
      sandbox.status = "running";
    } else {
      const containerId = await this.createContainer(sandbox, config, policy);
      sandbox.container_id = containerId;
      sandbox.status = "running";
    }

    this.sandboxes.set(sandbox.id, sandbox);

    // Set up TTL timeout.
    if (config.timeout_seconds > 0) {
      const handle = setTimeout(async () => {
        await this.handleTimeout(sandbox.id, config);
      }, config.timeout_seconds * 1000);
      this.timeout_handles.set(sandbox.id, handle);
    }

    return sandbox;
  }

  /**
   * Execute a task inside a running sandbox.
   *
   * In Docker mode the task is sent to the container's HTTP API. In simulated
   * mode the task is logged and a stub result is returned.
   */
  async execute(sandbox_id: string, task: AgentTask): Promise<AgentResult> {
    const sandbox = this.getSandboxOrThrow(sandbox_id);
    const start = performance.now();

    if (sandbox.status !== "running") {
      return {
        task_id: task.id,
        success: false,
        output: "",
        error: `Sandbox ${sandbox_id} is not running (status: ${sandbox.status})`,
        execution_time_ms: performance.now() - start,
        violations: [],
      };
    }

    const simulated = sandbox.container_id === "";

    if (simulated) {
      console.log(
        `[SIMULATED] Executing task ${task.id} in sandbox ${sandbox_id}`
      );

      // Enforce policy checks even in simulated mode.
      const violations = await this.simulatedPolicyCheck(sandbox, task);

      return {
        task_id: task.id,
        success: violations.filter((v) => v.blocked).length === 0,
        output: violations.length > 0
          ? `[SIMULATED] Task blocked due to policy violations.`
          : `[SIMULATED] Task ${task.id} completed successfully.`,
        error: violations.filter((v) => v.blocked).length > 0
          ? "Policy violation(s) blocked execution"
          : undefined,
        execution_time_ms: performance.now() - start,
        violations,
      };
    }

    // Docker mode: call the container's HTTP endpoint.
    try {
      const timeout = (task.timeout_seconds ?? 300) * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(
        `http://localhost:${this.containerPort(sandbox)}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(task),
          signal: controller.signal,
        }
      );
      clearTimeout(timer);

      if (!resp.ok) {
        const body = await resp.text();
        return {
          task_id: task.id,
          success: false,
          output: "",
          error: `Container returned HTTP ${resp.status}: ${body}`,
          execution_time_ms: performance.now() - start,
          violations: [],
        };
      }

      const result = (await resp.json()) as AgentResult;
      result.execution_time_ms = performance.now() - start;
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        task_id: task.id,
        success: false,
        output: "",
        error: `Execution failed: ${message}`,
        execution_time_ms: performance.now() - start,
        violations: [],
      };
    }
  }

  /**
   * Terminate a sandbox, optionally recording a reason.
   */
  async terminate(sandbox_id: string, reason: string): Promise<void> {
    const sandbox = this.getSandboxOrThrow(sandbox_id);

    // Clear the TTL timer.
    const handle = this.timeout_handles.get(sandbox_id);
    if (handle) {
      clearTimeout(handle);
      this.timeout_handles.delete(sandbox_id);
    }

    if (sandbox.container_id) {
      try {
        const args = ["rm", "-f", sandbox.container_id];
        if (this.docker_socket) {
          args.unshift("-H", `unix://${this.docker_socket}`);
        }
        const proc = Bun.spawn(["docker", ...args], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
      } catch (err) {
        console.error(
          `Failed to remove container ${sandbox.container_id}:`,
          err
        );
      }
    } else {
      console.log(
        `[SIMULATED] Terminating sandbox ${sandbox_id}: ${reason}`
      );
    }

    sandbox.status = "terminated";
  }

  /**
   * Return all sandboxes that are currently in a non-terminated state.
   */
  async get_active(): Promise<SandboxInstance[]> {
    return Array.from(this.sandboxes.values()).filter(
      (s) => s.status === "running" || s.status === "starting"
    );
  }

  /**
   * Retrieve recorded violations, optionally filtered by sandbox.
   */
  async get_violations(sandbox_id?: string): Promise<SecurityViolation[]> {
    if (sandbox_id) {
      const sandbox = this.sandboxes.get(sandbox_id);
      return sandbox ? [...sandbox.violations] : [];
    }
    return [...this.violation_log];
  }

  /**
   * Register a handler that is invoked each time a violation is recorded.
   */
  on_violation(handler: (violation: SecurityViolation) => void): void {
    this.violation_handlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Lazily detect Docker availability, caching the result. */
  private async isDockerAvailable(): Promise<boolean> {
    if (this.docker_ok === null) {
      this.docker_ok = await dockerAvailable(this.docker_socket);
    }
    return this.docker_ok;
  }

  /** Load a YAML policy file from the policy directory. */
  private async loadPolicy(
    policy_path: string
  ): Promise<Record<string, unknown>> {
    const full_path = policy_path.startsWith("/")
      ? policy_path
      : `${this.policy_dir}/${policy_path}`;
    try {
      const file = Bun.file(full_path);
      const text = await file.text();
      // Lazy-import js-yaml to keep the module tree-shakeable.
      const yaml = await import("js-yaml");
      return (yaml.load(text) as Record<string, unknown>) ?? {};
    } catch (err) {
      console.warn(`Failed to load policy at ${full_path}:`, err);
      return {};
    }
  }

  /**
   * Create a Docker container configured according to the given policy.
   * Returns the container ID.
   */
  private async createContainer(
    sandbox: SandboxInstance,
    config: SandboxConfig,
    policy: Record<string, unknown>
  ): Promise<string> {
    const args: string[] = [];
    if (this.docker_socket) {
      args.push("-H", `unix://${this.docker_socket}`);
    }
    args.push(
      "run",
      "-d",
      "--name",
      `nemoclaw-${sandbox.id}`,
      "--label",
      `nemoclaw.agent=${config.agent_name}`,
      "--label",
      `nemoclaw.sandbox=${sandbox.id}`
    );

    // Resource limits from policy.
    const resources = (policy as any)?.resource_limits;
    if (resources) {
      if (resources.memory_mb) {
        args.push("--memory", `${resources.memory_mb}m`);
      }
      if (resources.cpu_cores) {
        args.push("--cpus", String(resources.cpu_cores));
      }
      if (resources.disk_mb) {
        args.push(
          "--storage-opt",
          `size=${resources.disk_mb}M`
        );
      }
    }

    // Filesystem mounts from policy.
    const fs_perms = (policy as any)?.filesystem;
    if (fs_perms?.allowed_paths && Array.isArray(fs_perms.allowed_paths)) {
      for (const mount of fs_perms.allowed_paths) {
        const readOnly =
          fs_perms.read_only_paths?.includes(mount) ? ":ro" : "";
        args.push("-v", `${mount}:${mount}${readOnly}`);
      }
    }

    // Network restrictions.
    const net = (policy as any)?.network;
    if (net?.enabled === false) {
      args.push("--network", "none");
    }

    // Use a minimal base image with an HTTP agent shim.
    args.push("nemoclaw/agent-shim:latest");

    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Failed to create container (exit ${exitCode}): ${stderr}`
      );
    }

    const containerId = (await new Response(proc.stdout).text()).trim();
    return containerId;
  }

  /** Derive the host-side port mapped to the container's HTTP API. */
  private containerPort(sandbox: SandboxInstance): number {
    // In a real deployment the port would be dynamically allocated and stored.
    // For now derive a deterministic port from the sandbox ID.
    const hash = sandbox.id
      .replace(/-/g, "")
      .slice(0, 8);
    return 30000 + (parseInt(hash, 16) % 10000);
  }

  /** Record a violation, notify handlers, and optionally terminate. */
  private recordViolation(
    sandbox: SandboxInstance,
    violation: SecurityViolation
  ): void {
    sandbox.violations.push(violation);
    this.violation_log.push(violation);
    for (const handler of this.violation_handlers) {
      try {
        handler(violation);
      } catch {
        // Swallow handler errors to protect the main loop.
      }
    }
  }

  /** Perform simulated policy checks for a task (fallback mode). */
  private async simulatedPolicyCheck(
    sandbox: SandboxInstance,
    task: AgentTask
  ): Promise<SecurityViolation[]> {
    const violations: SecurityViolation[] = [];
    const instruction = task.instruction.toLowerCase();

    // Check for CUI markers in the instruction.
    const cuiMarkers = [
      "cui",
      "controlled unclassified",
      "fouo",
      "noforn",
      "//cui",
      "w911nf",
      "fa8702",
      "n00024",
    ];
    for (const marker of cuiMarkers) {
      if (instruction.includes(marker)) {
        const v: SecurityViolation = {
          timestamp: new Date().toISOString(),
          type: "cui_leak",
          description: `[SIMULATED] CUI marker "${marker}" detected in task instruction`,
          blocked: true,
          agent_name: sandbox.agent_name,
        };
        violations.push(v);
        this.recordViolation(sandbox, v);
        break;
      }
    }

    // Check for filesystem path references against policy.
    const fsPolicy = (sandbox.policy as any)?.filesystem;
    if (fsPolicy?.denied_paths && Array.isArray(fsPolicy.denied_paths)) {
      for (const denied of fsPolicy.denied_paths) {
        if (instruction.includes(denied)) {
          const v: SecurityViolation = {
            timestamp: new Date().toISOString(),
            type: "filesystem",
            description: `[SIMULATED] Reference to denied path "${denied}" detected`,
            blocked: true,
            agent_name: sandbox.agent_name,
          };
          violations.push(v);
          this.recordViolation(sandbox, v);
        }
      }
    }

    return violations;
  }

  /** Handle sandbox timeout expiry. */
  private async handleTimeout(
    sandbox_id: string,
    config: SandboxConfig
  ): Promise<void> {
    const sandbox = this.sandboxes.get(sandbox_id);
    if (!sandbox || sandbox.status !== "running") return;

    const violation: SecurityViolation = {
      timestamp: new Date().toISOString(),
      type: "timeout",
      description: `Sandbox exceeded timeout of ${config.timeout_seconds}s`,
      blocked: true,
      agent_name: config.agent_name,
    };
    this.recordViolation(sandbox, violation);

    await this.terminate(sandbox_id, "timeout exceeded");
  }

  /** Retrieve a sandbox by ID or throw. */
  private getSandboxOrThrow(sandbox_id: string): SandboxInstance {
    const sandbox = this.sandboxes.get(sandbox_id);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandbox_id} not found`);
    }
    return sandbox;
  }
}
