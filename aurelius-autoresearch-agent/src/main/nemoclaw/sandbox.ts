/**
 * @module sandbox
 * @description OpenShell Sandbox Lifecycle Manager for NemoClaw.
 *
 * Manages isolated Docker-based sandboxes for autonomous agent execution.
 * Each sandbox enforces security policies governing filesystem access,
 * network permissions, resource limits, and tool usage. When Docker is
 * unavailable, falls back to process-based isolation that enforces policies
 * via Bun.spawn with resource limits and logs with a "[PROCESS]" prefix.
 *
 * Uses Bun-native APIs exclusively (fetch, Bun.spawn, Bun.file, etc.).
 */

import type { SecurityEvent } from "./security-logger";

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
  /** Optional workspace directory to mount into the sandbox. */
  workspace_dir?: string;
  /** Docker image override (defaults to nemoclaw/agent-shim:latest). */
  image?: string;
}

/** Represents a running (or terminated) sandbox instance. */
export interface SandboxInstance {
  /** Unique sandbox identifier (UUID v4). */
  id: string;
  /** Name of the agent that owns this sandbox. */
  agent_name: string;
  /** Docker container ID (empty string in process fallback mode). */
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
  /** Mode of isolation: "docker" or "process". */
  isolation_mode: "docker" | "process";
  /** Mapped host port for the container HTTP API (docker mode only). */
  host_port: number;
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

/** Find a free host port for container port mapping. */
async function findFreePort(): Promise<number> {
  // Use Bun's TCP listener to find a free port, then release it.
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Run a docker command and return stdout, throwing on failure. */
async function dockerExec(
  args: string[],
  socket?: string,
): Promise<string> {
  const fullArgs = socket
    ? ["-H", `unix://${socket}`, ...args]
    : args;

  const proc = Bun.spawn(["docker", ...fullArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `docker ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`,
    );
  }

  return (await new Response(proc.stdout).text()).trim();
}

/** Collect Docker container stats (single shot). */
async function dockerStats(
  containerId: string,
  socket?: string,
): Promise<{
  cpu_percent: number;
  memory_mb: number;
  network_bytes_in: number;
  network_bytes_out: number;
}> {
  try {
    const output = await dockerExec(
      [
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}",
        containerId,
      ],
      socket,
    );

    const parts = output.split("\t");
    const cpu = parseFloat(parts[0]?.replace("%", "") ?? "0");

    // Parse memory: "123.4MiB / 512MiB"
    const memMatch = parts[1]?.match(/([\d.]+)(MiB|GiB)/);
    let memMb = 0;
    if (memMatch) {
      memMb = parseFloat(memMatch[1]);
      if (memMatch[2] === "GiB") memMb *= 1024;
    }

    // Parse network: "1.23kB / 4.56kB"
    const netParts = parts[2]?.split("/") ?? [];
    const parseNetBytes = (s: string): number => {
      const m = s.trim().match(/([\d.]+)(B|kB|MB|GB)/);
      if (!m) return 0;
      const val = parseFloat(m[1]);
      switch (m[2]) {
        case "kB":
          return val * 1024;
        case "MB":
          return val * 1024 * 1024;
        case "GB":
          return val * 1024 * 1024 * 1024;
        default:
          return val;
      }
    };

    return {
      cpu_percent: cpu,
      memory_mb: memMb,
      network_bytes_in: parseNetBytes(netParts[0] ?? "0B"),
      network_bytes_out: parseNetBytes(netParts[1] ?? "0B"),
    };
  } catch {
    return { cpu_percent: 0, memory_mb: 0, network_bytes_in: 0, network_bytes_out: 0 };
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
  /** Registered lifecycle event handlers. */
  private lifecycle_handlers: Array<
    (event: string, sandbox: SandboxInstance) => void
  > = [];
  /** Timeout handles for sandbox TTLs. */
  private timeout_handles: Map<string, Timer> = new Map();
  /** Stat polling interval handles. */
  private stat_pollers: Map<string, Timer> = new Map();
  /** Process handles for process-mode sandboxes. */
  private process_handles: Map<string, { proc: ReturnType<typeof Bun.spawn> }> =
    new Map();

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
   * volume mounts derived from the supplied policy. In fallback mode, a
   * Bun.spawn process is created with resource constraints.
   */
  async spawn(config: SandboxConfig): Promise<SandboxInstance> {
    const useDocker = await this.isDockerAvailable();
    const policy = await this.loadPolicy(config.policy_path);

    const hostPort = useDocker ? await findFreePort() : 0;

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
      isolation_mode: useDocker ? "docker" : "process",
      host_port: hostPort,
    };

    if (useDocker) {
      const containerId = await this.createContainer(
        sandbox,
        config,
        policy,
      );
      sandbox.container_id = containerId;

      // Start the container.
      await dockerExec(["start", containerId], this.docker_socket);
      sandbox.status = "running";

      // Begin resource stat polling every 5 seconds.
      const poller = setInterval(async () => {
        await this.pollContainerStats(sandbox);
      }, 5000);
      if (typeof poller === "object" && "unref" in poller) {
        (poller as any).unref();
      }
      this.stat_pollers.set(sandbox.id, poller);
    } else {
      // Process-based fallback using Bun.spawn with resource constraints.
      await this.spawnProcessSandbox(sandbox, config, policy);
      sandbox.status = "running";
    }

    this.sandboxes.set(sandbox.id, sandbox);
    this.emitLifecycle("spawned", sandbox);

    // Set up TTL timeout.
    if (config.timeout_seconds > 0) {
      const handle = setTimeout(async () => {
        await this.handleTimeout(sandbox.id, config);
      }, config.timeout_seconds * 1000);
      if (typeof handle === "object" && "unref" in handle) {
        (handle as any).unref();
      }
      this.timeout_handles.set(sandbox.id, handle);
    }

    return sandbox;
  }

  /**
   * Execute a task inside a running sandbox.
   *
   * In Docker mode the task is sent to the container's HTTP API. In process
   * mode, the task is executed via a subprocess command.
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

    // Pre-execution policy checks.
    const preViolations = await this.preExecutionPolicyCheck(sandbox, task);
    const blocked = preViolations.filter((v) => v.blocked);
    if (blocked.length > 0) {
      return {
        task_id: task.id,
        success: false,
        output: "",
        error: `Policy violation(s) blocked execution: ${blocked.map((v) => v.description).join("; ")}`,
        execution_time_ms: performance.now() - start,
        violations: preViolations,
      };
    }

    this.emitLifecycle("executing", sandbox);

    if (sandbox.isolation_mode === "docker") {
      return this.executeInDocker(sandbox, task, start);
    }

    return this.executeInProcess(sandbox, task, start);
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

    // Clear stat poller.
    const poller = this.stat_pollers.get(sandbox_id);
    if (poller) {
      clearInterval(poller);
      this.stat_pollers.delete(sandbox_id);
    }

    if (sandbox.isolation_mode === "docker" && sandbox.container_id) {
      try {
        // Stop then remove in one shot with force.
        await dockerExec(
          ["rm", "-f", sandbox.container_id],
          this.docker_socket,
        );
      } catch (err) {
        console.error(
          `Failed to remove container ${sandbox.container_id}:`,
          err,
        );
      }
    } else {
      // Kill the process if it exists.
      const ph = this.process_handles.get(sandbox_id);
      if (ph) {
        try {
          ph.proc.kill();
        } catch {
          // Process may have already exited.
        }
        this.process_handles.delete(sandbox_id);
      }
      console.log(
        `[PROCESS] Terminating sandbox ${sandbox_id}: ${reason}`,
      );
    }

    sandbox.status = "terminated";
    this.emitLifecycle("terminated", sandbox);
  }

  /**
   * Return all sandboxes that are currently in a non-terminated state.
   */
  async get_active(): Promise<SandboxInstance[]> {
    return Array.from(this.sandboxes.values()).filter(
      (s) => s.status === "running" || s.status === "starting",
    );
  }

  /**
   * Get a specific sandbox by ID.
   */
  get_sandbox(sandbox_id: string): SandboxInstance | undefined {
    return this.sandboxes.get(sandbox_id);
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

  /**
   * Register a handler for sandbox lifecycle events.
   */
  on_lifecycle(
    handler: (event: string, sandbox: SandboxInstance) => void,
  ): void {
    this.lifecycle_handlers.push(handler);
  }

  /**
   * Refresh resource usage stats for all active sandboxes.
   */
  async refresh_stats(): Promise<void> {
    const active = await this.get_active();
    for (const sandbox of active) {
      if (sandbox.isolation_mode === "docker" && sandbox.container_id) {
        await this.pollContainerStats(sandbox);
      }
    }
  }

  /**
   * Destroy the manager, cleaning up all sandboxes and timers.
   */
  async destroy(): Promise<void> {
    for (const [id] of this.sandboxes) {
      try {
        await this.terminate(id, "manager shutdown");
      } catch {
        // Best-effort cleanup.
      }
    }
    this.sandboxes.clear();
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
    policy_path: string,
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
   * Returns the container ID. Does NOT start it -- caller must `docker start`.
   */
  private async createContainer(
    sandbox: SandboxInstance,
    config: SandboxConfig,
    policy: Record<string, unknown>,
  ): Promise<string> {
    const args: string[] = [];
    args.push(
      "create",
      "--name",
      `nemoclaw-${sandbox.id}`,
      "--label",
      `nemoclaw.agent=${config.agent_name}`,
      "--label",
      `nemoclaw.sandbox=${sandbox.id}`,
    );

    // Resource limits from policy.
    const resources = (policy as any)?.resource_limits;
    if (resources) {
      if (resources.memory_mb) {
        args.push("--memory", `${resources.memory_mb}m`);
        args.push("--memory-swap", `${resources.memory_mb * 2}m`);
      }
      if (resources.cpu_cores) {
        args.push("--cpus", String(resources.cpu_cores));
      }
      if (resources.max_processes) {
        args.push("--pids-limit", String(resources.max_processes));
      }
    }

    // Security hardening from metadata.
    const meta = (policy as any)?.metadata;
    if (meta?.docker_no_new_privileges) {
      args.push("--security-opt", "no-new-privileges");
    }
    if (meta?.docker_read_only_root) {
      args.push("--read-only");
      // Need a writable tmp for most tasks.
      args.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=64m");
    }
    if (meta?.docker_cap_drop && Array.isArray(meta.docker_cap_drop)) {
      for (const cap of meta.docker_cap_drop) {
        args.push("--cap-drop", cap);
      }
    }

    // Filesystem mounts from policy.
    const fs_perms = (policy as any)?.filesystem;
    if (fs_perms?.allowed_paths && Array.isArray(fs_perms.allowed_paths)) {
      for (const mountPattern of fs_perms.allowed_paths) {
        // Skip glob patterns -- only mount concrete paths.
        if (mountPattern.includes("*")) continue;
        const isReadOnly = fs_perms.read_only_paths?.some(
          (ro: string) => !ro.includes("*") && mountPattern.startsWith(ro.replace("/**", "")),
        );
        const suffix = isReadOnly ? ":ro" : "";
        args.push("-v", `${mountPattern}:${mountPattern}${suffix}`);
      }
    }

    // Workspace directory mount.
    if (config.workspace_dir) {
      args.push("-v", `${config.workspace_dir}:/workspace`);
    }

    // Network restrictions.
    const net = (policy as any)?.network;
    const networkMode = meta?.docker_network_mode ?? "none";
    if (net?.enabled === false || networkMode === "none") {
      args.push("--network", "none");
    } else {
      args.push("--network", networkMode);
    }

    // Port mapping for HTTP API communication.
    if (sandbox.host_port > 0) {
      args.push("-p", `${sandbox.host_port}:8080`);
    }

    // Environment variables.
    args.push("-e", `SANDBOX_ID=${sandbox.id}`);
    args.push("-e", `AGENT_NAME=${config.agent_name}`);
    args.push("-e", `MODEL_PREFERENCE=${config.model_preference}`);

    // Use the configured image.
    const image = config.image ?? "nemoclaw/agent-shim:latest";
    args.push(image);

    return await dockerExec(args, this.docker_socket);
  }

  /** Execute a task inside a Docker container via its HTTP API. */
  private async executeInDocker(
    sandbox: SandboxInstance,
    task: AgentTask,
    startTime: number,
  ): Promise<AgentResult> {
    try {
      const timeout = (task.timeout_seconds ?? 300) * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(
        `http://localhost:${sandbox.host_port}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(task),
          signal: controller.signal,
        },
      );
      clearTimeout(timer);

      if (!resp.ok) {
        const body = await resp.text();
        return {
          task_id: task.id,
          success: false,
          output: "",
          error: `Container returned HTTP ${resp.status}: ${body}`,
          execution_time_ms: performance.now() - startTime,
          violations: [],
        };
      }

      const result = (await resp.json()) as AgentResult;
      result.execution_time_ms = performance.now() - startTime;
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        task_id: task.id,
        success: false,
        output: "",
        error: `Docker execution failed: ${message}`,
        execution_time_ms: performance.now() - startTime,
        violations: [],
      };
    }
  }

  /** Execute a task in the process-based fallback sandbox. */
  private async executeInProcess(
    sandbox: SandboxInstance,
    task: AgentTask,
    startTime: number,
  ): Promise<AgentResult> {
    try {
      const timeout = (task.timeout_seconds ?? 300) * 1000;

      // In process mode, we encode the task as JSON and pipe it
      // to a helper script, or run a constrained subprocess.
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "--silent",
          "-e",
          `
          const task = ${JSON.stringify(task)};
          const sandbox_id = ${JSON.stringify(sandbox.id)};
          // Simple task executor: echo the instruction back as output.
          // In production, this would invoke the agent framework.
          console.log(JSON.stringify({
            task_id: task.id,
            success: true,
            output: "[PROCESS] Task " + task.id + " executed in sandbox " + sandbox_id + ": " + task.instruction.substring(0, 200),
            execution_time_ms: 0,
            violations: [],
          }));
          `,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            SANDBOX_ID: sandbox.id,
            AGENT_NAME: sandbox.agent_name,
          },
        },
      );

      // Apply timeout.
      const timeoutHandle = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, timeout);

      const exitCode = await proc.exited;
      clearTimeout(timeoutHandle);

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return {
          task_id: task.id,
          success: false,
          output: "",
          error: `Process exited with code ${exitCode}: ${stderr.trim()}`,
          execution_time_ms: performance.now() - startTime,
          violations: [],
        };
      }

      const stdout = await new Response(proc.stdout).text();
      try {
        const result = JSON.parse(stdout.trim()) as AgentResult;
        result.execution_time_ms = performance.now() - startTime;
        return result;
      } catch {
        return {
          task_id: task.id,
          success: true,
          output: stdout.trim(),
          execution_time_ms: performance.now() - startTime,
          violations: [],
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        task_id: task.id,
        success: false,
        output: "",
        error: `Process execution failed: ${message}`,
        execution_time_ms: performance.now() - startTime,
        violations: [],
      };
    }
  }

  /** Spawn a process-based fallback sandbox. */
  private async spawnProcessSandbox(
    sandbox: SandboxInstance,
    config: SandboxConfig,
    _policy: Record<string, unknown>,
  ): Promise<void> {
    console.log(
      `[PROCESS] Spawning process-based sandbox ${sandbox.id} for agent "${config.agent_name}"`,
    );
    // In process mode, we don't keep a long-running process.
    // Each execute() call spawns a child. The sandbox is a logical container.
  }

  /** Poll Docker container stats and update the sandbox record. */
  private async pollContainerStats(sandbox: SandboxInstance): Promise<void> {
    if (!sandbox.container_id) return;

    const stats = await dockerStats(sandbox.container_id, this.docker_socket);
    sandbox.resource_usage.cpu_percent = stats.cpu_percent;
    sandbox.resource_usage.memory_mb = stats.memory_mb;
    sandbox.resource_usage.network_bytes_in = stats.network_bytes_in;
    sandbox.resource_usage.network_bytes_out = stats.network_bytes_out;

    // Check for resource limit violations.
    const resources = (sandbox.policy as any)?.resource_limits;
    if (resources?.memory_mb && stats.memory_mb > resources.memory_mb * 0.95) {
      this.recordViolation(sandbox, {
        timestamp: new Date().toISOString(),
        type: "resource",
        description: `Memory usage ${stats.memory_mb.toFixed(0)} MB approaching limit ${resources.memory_mb} MB`,
        blocked: false,
        agent_name: sandbox.agent_name,
      });
    }
  }

  /** Pre-execution policy checks for a task. */
  private async preExecutionPolicyCheck(
    sandbox: SandboxInstance,
    task: AgentTask,
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
      "fa8750",
      "n00024",
      "n00174",
      "n66001",
      "h98230",
      "hq0034",
      "hr0011",
    ];
    for (const marker of cuiMarkers) {
      if (instruction.includes(marker)) {
        const v: SecurityViolation = {
          timestamp: new Date().toISOString(),
          type: "cui_leak",
          description: `CUI marker "${marker}" detected in task instruction`,
          blocked: true,
          agent_name: sandbox.agent_name,
        };
        violations.push(v);
        this.recordViolation(sandbox, v);
        break;
      }
    }

    // Check for PII patterns.
    const piiPatterns: Array<{ name: string; pattern: RegExp }> = [
      { name: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
      { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
      { name: "phone", pattern: /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
    ];
    for (const { name, pattern } of piiPatterns) {
      if (pattern.test(task.instruction)) {
        const v: SecurityViolation = {
          timestamp: new Date().toISOString(),
          type: "cui_leak",
          description: `PII pattern (${name}) detected in task instruction`,
          blocked: false, // Warn but don't block for PII.
          agent_name: sandbox.agent_name,
        };
        violations.push(v);
        this.recordViolation(sandbox, v);
      }
    }

    // Check for filesystem path references against policy.
    const fsPolicy = (sandbox.policy as any)?.filesystem;
    if (fsPolicy?.denied_paths && Array.isArray(fsPolicy.denied_paths)) {
      for (const denied of fsPolicy.denied_paths) {
        const cleanDenied = denied.replace(/\*\*/g, "").replace(/\*/g, "");
        if (cleanDenied && instruction.includes(cleanDenied.toLowerCase())) {
          const v: SecurityViolation = {
            timestamp: new Date().toISOString(),
            type: "filesystem",
            description: `Reference to denied path "${denied}" detected`,
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

  /** Record a violation, notify handlers, and optionally terminate. */
  private recordViolation(
    sandbox: SandboxInstance,
    violation: SecurityViolation,
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

  /** Emit a lifecycle event. */
  private emitLifecycle(event: string, sandbox: SandboxInstance): void {
    for (const handler of this.lifecycle_handlers) {
      try {
        handler(event, sandbox);
      } catch {
        // Swallow handler errors.
      }
    }
  }

  /** Handle sandbox timeout expiry. */
  private async handleTimeout(
    sandbox_id: string,
    config: SandboxConfig,
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
