/**
 * NemoClaw RPC Handler
 *
 * Unified RPC interface that wires together all NemoClaw security plane
 * components: sandbox management, privacy routing, model management,
 * security logging, and policy loading.
 *
 * Provides SSE (Server-Sent Events) for real-time panel updates and
 * JSON-RPC style method dispatch for actions.
 */

import { SandboxManager } from "../nemoclaw/sandbox";
import type {
  SandboxConfig,
  SandboxInstance,
  AgentTask,
  AgentResult,
} from "../nemoclaw/sandbox";
import { PrivacyRouter } from "../nemoclaw/privacy-router";
import type {
  RoutingContext,
  RoutingDecision,
  RoutingStats,
  ClassificationResult,
  InferenceResult,
} from "../nemoclaw/privacy-router";
import { ModelManager } from "../nemoclaw/model-manager";
import type {
  ModelManagerStatus,
  ModelInfo,
  GPUInfo,
  HealthCheckResult,
} from "../nemoclaw/model-manager";
import { SecurityLogger } from "../nemoclaw/security-logger";
import type {
  SecurityEvent,
  SecurityEventInput,
  SecurityStats,
} from "../nemoclaw/security-logger";
import { PolicyLoader } from "../nemoclaw/policy-loader";
import type { OpenShellPolicyType } from "../nemoclaw/policy-loader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Generic RPC response. */
export interface RPCResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** SSE client connection. */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
}

// ---------------------------------------------------------------------------
// NemoClawRPC
// ---------------------------------------------------------------------------

/**
 * Unified RPC handler for the NemoClaw security plane.
 *
 * Wires together:
 * - SandboxManager: sandbox:spawn, sandbox:execute, sandbox:destroy, sandbox:list
 * - PrivacyRouter: privacy:classify, privacy:route, privacy:route_and_infer, privacy:stats
 * - ModelManager: model:status, model:load, model:unload, model:health, model:list, model:recommend
 * - SecurityLogger: security:getEvents, security:getViolations, security:getStats, security:log
 * - PolicyLoader: policy:load, policy:validate, policy:list, policy:check_access
 *
 * @example
 * ```ts
 * const rpc = new NemoClawRPC({
 *   policyDir: "/workspace/policies/sandbox",
 *   configDir: "/workspace/config",
 *   auditDir: "/workspace/audit",
 * });
 * await rpc.initialize();
 *
 * // Handle an RPC call:
 * const result = await rpc.dispatch("sandbox:spawn", {
 *   agent_name: "researcher-1",
 *   policy_path: "level-2-guided.yaml",
 *   model_preference: "nemotron:70b-q4",
 *   timeout_seconds: 3600,
 *   on_violation: "block",
 * });
 * ```
 */
export class NemoClawRPC {
  private sandbox: SandboxManager;
  private router: PrivacyRouter;
  private models: ModelManager;
  private logger: SecurityLogger;
  private policies: PolicyLoader;
  private sse_clients: Map<string, SSEClient> = new Map();

  constructor(opts: {
    policyDir: string;
    configDir: string;
    auditDir?: string;
    minioEndpoint?: string;
    ollamaEndpoint?: string;
    dockerSocket?: string;
  }) {
    this.sandbox = new SandboxManager(opts.policyDir, opts.dockerSocket);
    this.router = new PrivacyRouter(`${opts.configDir}/privacy-router.yaml`);
    this.models = new ModelManager(
      opts.ollamaEndpoint ?? "http://localhost:11434",
    );
    this.logger = new SecurityLogger(
      opts.auditDir ?? "/workspace/audit",
      opts.minioEndpoint ?? "http://localhost:9000",
    );
    this.policies = new PolicyLoader(opts.policyDir);

    this.wireEventForwarding();
  }

  /**
   * Initialize all subsystems. Call once at startup.
   */
  async initialize(): Promise<void> {
    // Initialize model manager (GPU detection, health checks, auto-warmup).
    await this.models.initialize();

    // Load all policies and start hot-reload watcher.
    await this.policies.load_all();
    await this.policies.start_watching();

    // Log system startup event.
    this.logger.log({
      sandbox_id: "",
      agent_id: "system",
      action: "system_startup",
      resource: "nemoclaw",
      decision: "allow",
      policy_ref: "system",
      category: "system",
      description: "NemoClaw security plane initialized",
      details: {
        model_status: await this.models.get_status(),
      },
      severity: "info",
    });
  }

  /**
   * Dispatch an RPC method call.
   */
  async dispatch(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<RPCResponse> {
    try {
      switch (method) {
        // --- Sandbox ---
        case "sandbox:spawn":
          return this.sandboxSpawn(params as unknown as SandboxConfig);
        case "sandbox:execute":
          return this.sandboxExecute(
            params.sandbox_id as string,
            params.task as AgentTask,
          );
        case "sandbox:destroy":
          return this.sandboxDestroy(
            params.sandbox_id as string,
            (params.reason as string) ?? "rpc_destroy",
          );
        case "sandbox:list":
        case "sandboxes.list":
          return this.sandboxList();
        case "sandbox:get":
          return this.sandboxGet(params.sandbox_id as string);
        case "sandboxes.terminate":
          return this.sandboxDestroy(
            (params.id as string) ?? (params.sandbox_id as string),
            "user_terminated",
          );

        // --- Privacy Router ---
        case "privacy:classify":
          return this.privacyClassify(params.text as string);
        case "privacy:route":
          return this.privacyRoute(params as unknown as RoutingContext);
        case "privacy:route_and_infer":
          return this.privacyRouteAndInfer(
            params.context as RoutingContext,
            params.prompt as string,
          );
        case "privacy:stats":
        case "routing.stats":
          return this.privacyStats();
        case "privacy:log":
          return this.privacyDecisionLog();

        // --- Model Manager ---
        case "model:status":
        case "model.status":
          return this.modelStatus();
        case "model:load":
          return this.modelLoad(
            params.name as string,
            params.quantization as string | undefined,
          );
        case "model:unload":
          return this.modelUnload(params.name as string);
        case "model:health":
          return this.modelHealth();
        case "model:list":
          return this.modelList();
        case "model:recommend":
          return this.modelRecommend(params.vram_mb as number | undefined);
        case "gpu.status":
          return this.gpuStatus();

        // --- Security Logger ---
        case "security:getEvents":
        case "security.recent":
          return this.securityGetEvents(params);
        case "security:getViolations":
          return this.securityGetViolations(params);
        case "security:getStats":
          return this.securityGetStats(params.since as string | undefined);
        case "security:log":
          return this.securityLog(params as unknown as SecurityEventInput);

        // --- Policy Loader ---
        case "policy:load":
          return this.policyLoad(params.name as string);
        case "policy:validate":
          return this.policyValidate(params.policy as unknown);
        case "policy:list":
        case "policies.list":
          return this.policyList();
        case "policy:check_access":
          return this.policyCheckAccess(
            params.policy_name as string,
            params.access_type as string,
            params.resource as string,
          );
        case "policies.read":
          return this.policyRead(params.path as string);
        case "policies.save":
          return this.policySave(
            params.path as string,
            params.content as string,
          );
        case "policies.reload":
          return this.policyReload();

        default:
          return { ok: false, error: `Unknown method: ${method}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Create an SSE stream for real-time event delivery.
   */
  createSSEStream(): ReadableStream {
    const clientId = crypto.randomUUID();

    return new ReadableStream({
      start: (controller) => {
        this.sse_clients.set(clientId, { id: clientId, controller });

        // Send initial connection event.
        const data = JSON.stringify({
          type: "connected",
          data: { clientId },
        });
        controller.enqueue(`data: ${data}\n\n`);
      },
      cancel: () => {
        this.sse_clients.delete(clientId);
      },
    });
  }

  /**
   * Clean up all subsystems.
   */
  async destroy(): Promise<void> {
    await this.sandbox.destroy();
    await this.logger.destroy();
    this.models.destroy();
    this.policies.destroy();

    // Close all SSE connections.
    for (const [, client] of this.sse_clients) {
      try {
        client.controller.close();
      } catch {
        // May already be closed.
      }
    }
    this.sse_clients.clear();
  }

  // -----------------------------------------------------------------------
  // SSE event broadcasting
  // -----------------------------------------------------------------------

  private broadcastSSE(eventType: string, data: unknown): void {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const [id, client] of this.sse_clients) {
      try {
        client.controller.enqueue(payload);
      } catch {
        // Client disconnected; remove it.
        this.sse_clients.delete(id);
      }
    }
  }

  /** Wire up event forwarding from subsystems to SSE. */
  private wireEventForwarding(): void {
    // Sandbox lifecycle events.
    this.sandbox.on_lifecycle((event, sb) => {
      this.broadcastSSE(`sandbox.${event}`, {
        id: sb.id,
        role: sb.agent_name,
        status: sb.status,
        spawnedAt: new Date(sb.started_at).getTime(),
        memoryMb: sb.resource_usage.memory_mb,
        maxMemoryMb: (sb.policy as any)?.resource_limits?.memory_mb ?? 512,
        cpuPercent: sb.resource_usage.cpu_percent,
        uptimeMs: Date.now() - new Date(sb.started_at).getTime(),
      });

      // Also emit lifecycle timeline event.
      this.broadcastSSE("lifecycle.event", {
        timestamp: Date.now(),
        type: event === "spawned" ? "spawn" : event === "terminated" ? "terminate" : "exec",
        sandboxId: sb.id,
        role: sb.agent_name,
        detail: sb.status,
      });
    });

    // Sandbox violations.
    this.sandbox.on_violation((v) => {
      this.logger.log({
        sandbox_id: "",
        agent_id: v.agent_name,
        action: v.type,
        resource: v.description,
        decision: v.blocked ? "deny" : "warn",
        policy_ref: `sandbox.${v.type}`,
        category: "policy_enforcement",
        description: v.description,
        details: { violation: v },
        severity: v.blocked ? "violation" : "warning",
      });
    });

    // Security events -> SSE.
    this.logger.on_event((event) => {
      this.broadcastSSE("security.event", {
        id: event.id,
        timestamp: new Date(event.timestamp).getTime(),
        severity: event.severity === "violation" ? "error" : event.severity,
        message: event.description,
        context: event.details,
        source: event.agent_id,
      });
    });

    // Privacy router decisions -> SSE.
    this.router.on_decision((decision) => {
      this.broadcastSSE("routing.decision", {
        timestamp: new Date(decision.timestamp).getTime(),
        sandboxId: "",
        model: decision.model,
        path: decision.route === "local" ? "local" : "cloud_sanitized",
        classification: decision.classification,
        transformations: decision.pii_detected,
      });
    });

    // Model manager status -> SSE.
    this.models.on_status((status) => {
      this.broadcastSSE("model.status", {
        id: "primary",
        status: status.ollama_reachable ? "ready" : "offline",
        vramUsedMb: status.gpu?.vram_used_mb ?? 0,
        vramTotalMb: status.gpu?.vram_total_mb ?? 0,
        inferenceCount: status.inference_metrics.total_calls,
        avgLatencyMs: status.inference_metrics.avg_latency_ms,
      });

      if (status.gpu) {
        this.broadcastSSE("gpu.status", {
          name: status.gpu.name,
          status: status.gpu.temperature_c > 85 ? "warn" : "ok",
          utilizationPercent: status.gpu.utilization_percent,
          temperatureC: status.gpu.temperature_c,
          vramUsedMb: status.gpu.vram_used_mb,
          vramTotalMb: status.gpu.vram_total_mb,
        });
      }
    });

    // Policy reload -> SSE.
    this.policies.on_reload((name) => {
      this.broadcastSSE("policy.changed", { name });
    });
  }

  // -----------------------------------------------------------------------
  // Sandbox RPC methods
  // -----------------------------------------------------------------------

  private async sandboxSpawn(
    config: SandboxConfig,
  ): Promise<RPCResponse<SandboxInstance>> {
    const instance = await this.sandbox.spawn(config);
    this.logger.log({
      sandbox_id: instance.id,
      agent_id: config.agent_name,
      action: "sandbox_spawn",
      resource: config.policy_path,
      decision: "allow",
      policy_ref: config.policy_path,
      category: "sandbox",
      description: `Spawned sandbox for agent "${config.agent_name}" (${instance.isolation_mode} mode)`,
      details: { config, isolation_mode: instance.isolation_mode },
      severity: "info",
    });
    return { ok: true, data: instance };
  }

  private async sandboxExecute(
    sandbox_id: string,
    task: AgentTask,
  ): Promise<RPCResponse<AgentResult>> {
    const result = await this.sandbox.execute(sandbox_id, task);
    return { ok: result.success, data: result, error: result.error };
  }

  private async sandboxDestroy(
    sandbox_id: string,
    reason: string,
  ): Promise<RPCResponse<void>> {
    await this.sandbox.terminate(sandbox_id, reason);
    return { ok: true, data: undefined };
  }

  private async sandboxList(): Promise<RPCResponse<SandboxInstance[]>> {
    const active = await this.sandbox.get_active();
    // Map to the panel's expected format.
    const mapped = active.map((s) => ({
      ...s,
      // Panel-compatible fields:
      id: s.id,
      role: s.agent_name,
      status: s.status as "running" | "terminated" | "error",
      spawnedAt: new Date(s.started_at).getTime(),
      memoryMb: s.resource_usage.memory_mb,
      maxMemoryMb: (s.policy as any)?.resource_limits?.memory_mb ?? 512,
      cpuPercent: s.resource_usage.cpu_percent,
      uptimeMs: Date.now() - new Date(s.started_at).getTime(),
    }));
    return { ok: true, data: mapped as any };
  }

  private async sandboxGet(
    sandbox_id: string,
  ): Promise<RPCResponse<SandboxInstance>> {
    const sb = this.sandbox.get_sandbox(sandbox_id);
    if (!sb) return { ok: false, error: `Sandbox ${sandbox_id} not found` };
    return { ok: true, data: sb };
  }

  // -----------------------------------------------------------------------
  // Privacy Router RPC methods
  // -----------------------------------------------------------------------

  private async privacyClassify(
    text: string,
  ): Promise<RPCResponse<ClassificationResult>> {
    const result = await this.router.classify(text);
    return { ok: true, data: result };
  }

  private async privacyRoute(
    context: RoutingContext,
  ): Promise<RPCResponse<RoutingDecision>> {
    const decision = await this.router.route(context);

    // Log the routing decision.
    this.logger.logRouting({
      sandbox_id: "",
      agent_id: "privacy_router",
      route: decision.route,
      model: decision.model,
      classification: decision.classification,
      rule_matched: decision.rule_matched,
      cui_detected: !!decision.cui_marker,
      pii_types: decision.pii_detected,
    });

    return { ok: true, data: decision };
  }

  private async privacyRouteAndInfer(
    context: RoutingContext,
    prompt: string,
  ): Promise<RPCResponse<InferenceResult>> {
    const result = await this.router.route_and_infer(context, prompt);

    // Track inference metrics.
    this.models.record_inference(
      result.latency_ms,
      !result.error,
    );

    return { ok: !result.error, data: result, error: result.error };
  }

  private async privacyStats(): Promise<RPCResponse<RoutingStats>> {
    const stats = this.router.get_stats();
    // Map to panel's expected format.
    return {
      ok: true,
      data: {
        ...stats,
        total: stats.total,
        byPath: {
          local: stats.local_count,
          cloud_sanitized: stats.cloud_count,
        },
        blocked: stats.cui_detections,
        avgLatencyMs: 0,
      } as any,
    };
  }

  private async privacyDecisionLog(): Promise<RPCResponse<RoutingDecision[]>> {
    return { ok: true, data: this.router.get_decision_log() };
  }

  // -----------------------------------------------------------------------
  // Model Manager RPC methods
  // -----------------------------------------------------------------------

  private async modelStatus(): Promise<RPCResponse<ModelManagerStatus>> {
    const status = await this.models.get_status();
    // Also return panel-compatible format.
    return {
      ok: true,
      data: {
        ...status,
        id: "primary",
        status: status.ollama_reachable ? "ready" : "offline",
        vramUsedMb: status.gpu?.vram_used_mb ?? 0,
        vramTotalMb: status.gpu?.vram_total_mb ?? 0,
        inferenceCount: status.inference_metrics.total_calls,
        avgLatencyMs: status.inference_metrics.avg_latency_ms,
      } as any,
    };
  }

  private async modelLoad(
    name: string,
    quantization?: string,
  ): Promise<RPCResponse<void>> {
    await this.models.load_model(name, quantization);
    this.logger.log({
      sandbox_id: "",
      agent_id: "model_manager",
      action: "model_load",
      resource: name,
      decision: "allow",
      policy_ref: "system.model_management",
      category: "system",
      description: `Loaded model "${name}" (quantization: ${quantization ?? "auto"})`,
      details: { name, quantization },
      severity: "info",
    });
    return { ok: true, data: undefined };
  }

  private async modelUnload(name: string): Promise<RPCResponse<void>> {
    await this.models.unload_model(name);
    return { ok: true, data: undefined };
  }

  private async modelHealth(): Promise<RPCResponse<HealthCheckResult>> {
    const result = await this.models.health_check();
    return { ok: result.healthy, data: result };
  }

  private async modelList(): Promise<RPCResponse<ModelInfo[]>> {
    const models = await this.models.list_models();
    return { ok: true, data: models };
  }

  private async modelRecommend(
    vram_mb?: number,
  ): Promise<RPCResponse> {
    const gpu = await this.models.detect_gpu();
    const vram = vram_mb ?? gpu?.vram_free_mb ?? 4096;
    const rec = await this.models.recommend_model(vram);
    return { ok: true, data: rec };
  }

  private async gpuStatus(): Promise<RPCResponse<GPUInfo | null>> {
    const gpu = await this.models.detect_gpu();
    if (!gpu) {
      return {
        ok: true,
        data: {
          name: "No GPU",
          status: "error",
          utilizationPercent: 0,
          temperatureC: 0,
          vramUsedMb: 0,
          vramTotalMb: 0,
        } as any,
      };
    }
    return {
      ok: true,
      data: {
        ...gpu,
        status: gpu.temperature_c > 85 ? "warn" : "ok",
        utilizationPercent: gpu.utilization_percent,
        temperatureC: gpu.temperature_c,
        vramUsedMb: gpu.vram_used_mb,
        vramTotalMb: gpu.vram_total_mb,
      } as any,
    };
  }

  // -----------------------------------------------------------------------
  // Security Logger RPC methods
  // -----------------------------------------------------------------------

  private async securityGetEvents(
    params: Record<string, unknown>,
  ): Promise<RPCResponse<SecurityEvent[]>> {
    const count = (params.count as number) ?? 100;
    const severity = params.severity as string | undefined;
    const category = params.category as string | undefined;
    const events = this.logger.get_recent(
      count,
      severity as any,
      category as any,
    );
    return { ok: true, data: events };
  }

  private async securityGetViolations(
    params: Record<string, unknown>,
  ): Promise<RPCResponse<SecurityEvent[]>> {
    const count = (params.count as number) ?? 50;
    const violations = this.logger.get_violations(count);
    return { ok: true, data: violations };
  }

  private async securityGetStats(
    since?: string,
  ): Promise<RPCResponse<SecurityStats>> {
    const stats = this.logger.get_stats(since);
    return { ok: true, data: stats };
  }

  private async securityLog(
    input: SecurityEventInput,
  ): Promise<RPCResponse<SecurityEvent>> {
    const event = this.logger.log(input);
    return { ok: true, data: event };
  }

  // -----------------------------------------------------------------------
  // Policy Loader RPC methods
  // -----------------------------------------------------------------------

  private async policyLoad(
    name: string,
  ): Promise<RPCResponse<OpenShellPolicyType>> {
    const policy = await this.policies.load(name);
    return { ok: true, data: policy };
  }

  private async policyValidate(
    policy: unknown,
  ): Promise<RPCResponse<{ valid: boolean; errors?: string[] }>> {
    try {
      this.policies.validate(policy);
      return { ok: true, data: { valid: true } };
    } catch (err: any) {
      const errors =
        err.errors?.map((e: any) => `${e.path.join(".")}: ${e.message}`) ?? [
          String(err),
        ];
      return { ok: true, data: { valid: false, errors } };
    }
  }

  private async policyList(): Promise<RPCResponse> {
    const policies = await this.policies.list();
    // Map to panel's expected format.
    const files = policies.map((p) => ({
      name: p.name,
      path: p.path,
    }));
    return { ok: true, data: files };
  }

  private async policyCheckAccess(
    policyName: string,
    accessType: string,
    resource: string,
  ): Promise<RPCResponse> {
    const policy = await this.policies.load(policyName);
    const result = this.policies.check_access(
      policy,
      accessType as any,
      resource,
    );

    // Log the access check.
    this.logger.logAccess({
      sandbox_id: "",
      agent_id: "policy_checker",
      action: accessType,
      resource,
      allowed: result.allowed,
      policy_ref: `${policyName}.${accessType}`,
      details: { reason: result.reason },
    });

    return { ok: true, data: result };
  }

  private async policyRead(
    path: string,
  ): Promise<RPCResponse<{ content: string }>> {
    try {
      const file = Bun.file(path);
      const content = await file.text();
      return { ok: true, data: { content } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to read policy: ${message}` };
    }
  }

  private async policySave(
    path: string,
    content: string,
  ): Promise<RPCResponse<void>> {
    try {
      // Validate the content before saving.
      const yamlLib = await import("js-yaml");
      const parsed = yamlLib.load(content);
      this.policies.validate(parsed);

      // Write the file.
      await Bun.write(path, content);

      this.logger.log({
        sandbox_id: "",
        agent_id: "policy_editor",
        action: "policy_save",
        resource: path,
        decision: "allow",
        policy_ref: "system.policy_management",
        category: "policy_enforcement",
        description: `Saved policy file: ${path}`,
        details: {},
        severity: "info",
      });

      return { ok: true, data: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to save policy: ${message}` };
    }
  }

  private async policyReload(): Promise<RPCResponse<void>> {
    this.policies.clear_cache();
    await this.policies.load_all();
    return { ok: true, data: undefined };
  }
}
