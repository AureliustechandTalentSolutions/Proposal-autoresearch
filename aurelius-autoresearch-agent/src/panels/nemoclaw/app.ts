/**
 * NemoClaw Panel – main application entry point.
 *
 * Vanilla TypeScript with direct DOM manipulation (no framework).
 * Connects to the Bun main process via SSE for real-time updates and
 * uses RPC calls for actions (terminate sandbox, save policy, etc.).
 */

import { AgentSandbox } from "./components/AgentSandbox";
import { PolicyEditor } from "./components/PolicyEditor";
import { PrivacyRouterView } from "./components/PrivacyRouter";
import { ModelStatus } from "./components/ModelStatus";
import { SecurityLog } from "./components/SecurityLog";
import { AgentLifecycle } from "./components/AgentLifecycle";

// ---------------------------------------------------------------------------
// Types shared across components
// ---------------------------------------------------------------------------

export interface SandboxInfo {
  id: string;
  role: string;
  status: "running" | "terminated" | "error";
  spawnedAt: number;
  memoryMb: number;
  maxMemoryMb: number;
  cpuPercent: number;
  uptimeMs: number;
}

export interface SecurityEvent {
  id: string;
  timestamp: number;
  severity: "info" | "warn" | "error" | "critical";
  message: string;
  context: Record<string, unknown>;
  source?: string;
}

export interface RoutingDecision {
  timestamp: number;
  sandboxId: string;
  model: string;
  path: "local" | "federated" | "cloud_sanitized" | "blocked";
  classification: string;
  transformations: string[];
}

export interface RoutingStats {
  total: number;
  byPath: Record<string, number>;
  blocked: number;
  avgLatencyMs: number;
}

export interface ModelInfo {
  id: string;
  status: "loading" | "ready" | "error" | "offline";
  vramUsedMb: number;
  vramTotalMb: number;
  inferenceCount: number;
  avgLatencyMs: number;
}

export interface GpuInfo {
  name: string;
  status: "ok" | "warn" | "error";
  utilizationPercent: number;
  temperatureC: number;
  vramUsedMb: number;
  vramTotalMb: number;
}

export interface LifecycleEvent {
  timestamp: number;
  type: "spawn" | "exec" | "terminate" | "error";
  sandboxId: string;
  role: string;
  detail?: string;
}

export interface PolicyFile {
  name: string;
  path: string;
  content?: string;
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

const RPC_BASE = "/api/nemoclaw";

async function rpc<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${RPC_BASE}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: params ?? {} }),
  });

  if (!res.ok) {
    throw new Error(`RPC ${method} failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { result?: T; error?: string };
  if (json.error) throw new Error(json.error);
  return json.result as T;
}

export { rpc };

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

class SSEConnection {
  private source: EventSource | null = null;
  private handlers = new Map<string, Set<(data: unknown) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  connect(): void {
    this.disconnect();

    this.source = new EventSource(`${RPC_BASE}/events`);

    this.source.onopen = () => {
      this.reconnectDelay = 1000;
    };

    this.source.onerror = () => {
      this.scheduleReconnect();
    };

    this.source.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; data: unknown };
        this.dispatch(msg.type, msg.data);
      } catch {
        // Ignore malformed messages
      }
    };

    // Named event types from the server
    for (const eventType of [
      "sandbox.update",
      "sandbox.spawned",
      "sandbox.terminated",
      "security.event",
      "routing.decision",
      "routing.stats",
      "model.status",
      "gpu.status",
      "lifecycle.event",
      "policy.changed",
    ]) {
      this.source.addEventListener(eventType, (ev: Event) => {
        const msgEvent = ev as MessageEvent;
        try {
          const data = JSON.parse(msgEvent.data);
          this.dispatch(eventType, data);
        } catch {
          // Ignore
        }
      });
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private dispatch(event: string, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn(data);
        } catch (err) {
          console.error(`SSE handler error for ${event}:`, err);
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }
}

// ---------------------------------------------------------------------------
// Application bootstrap
// ---------------------------------------------------------------------------

class NemoClawApp {
  private sse: SSEConnection;
  private sandboxView: AgentSandbox;
  private policyEditor: PolicyEditor;
  private routerView: PrivacyRouterView;
  private modelStatus: ModelStatus;
  private securityLog: SecurityLog;
  private lifecycle: AgentLifecycle;

  constructor() {
    this.sse = new SSEConnection();

    // Initialize component instances
    this.sandboxView = new AgentSandbox(
      document.getElementById("sandbox-grid")!,
      document.getElementById("sandbox-count")!,
    );

    this.securityLog = new SecurityLog(
      document.getElementById("security-log")!,
      document.getElementById("security-log-body")!,
      document.getElementById("log-count")!,
    );

    this.routerView = new PrivacyRouterView(
      document.getElementById("router-stats")!,
      document.getElementById("pie-svg")!,
      document.getElementById("router-decisions")!,
      document.getElementById("routing-stats-chip")!,
    );

    this.modelStatus = new ModelStatus(
      document.getElementById("model-status-dot")!,
      document.getElementById("model-status-text")!,
      document.getElementById("gpu-status-dot")!,
      document.getElementById("gpu-status-text")!,
    );

    this.lifecycle = new AgentLifecycle(
      document.getElementById("lifecycle-timeline")!,
    );

    this.policyEditor = new PolicyEditor(
      document.getElementById("policy-file-list")!,
      document.getElementById("policy-editor")! as HTMLTextAreaElement,
      document.getElementById("policy-save-btn")! as HTMLButtonElement,
      document.getElementById("policy-revert-btn")! as HTMLButtonElement,
    );

    this.bindToggle();
    this.bindSSE();
  }

  /** Start the application: connect SSE and load initial data. */
  async start(): Promise<void> {
    this.sse.connect();
    await this.loadInitialState();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private bindToggle(): void {
    const toggle = document.getElementById("policy-toggle")!;
    const body = document.getElementById("policy-body")!;
    const chevron = document.getElementById("policy-chevron")!;

    toggle.addEventListener("click", () => {
      const isOpen = body.classList.toggle("policy-panel__body--open");
      chevron.classList.toggle("policy-panel__chevron--open", isOpen);
    });
  }

  private bindSSE(): void {
    // Sandbox events
    this.sse.on("sandbox.update", (data) => {
      this.sandboxView.updateSandbox(data as SandboxInfo);
    });
    this.sse.on("sandbox.spawned", (data) => {
      this.sandboxView.addSandbox(data as SandboxInfo);
    });
    this.sse.on("sandbox.terminated", (data) => {
      const info = data as { id: string };
      this.sandboxView.removeSandbox(info.id);
    });

    // Security log
    this.sse.on("security.event", (data) => {
      this.securityLog.addEvent(data as SecurityEvent);
    });

    // Privacy router
    this.sse.on("routing.decision", (data) => {
      this.routerView.addDecision(data as RoutingDecision);
    });
    this.sse.on("routing.stats", (data) => {
      this.routerView.updateStats(data as RoutingStats);
    });

    // Model & GPU status
    this.sse.on("model.status", (data) => {
      this.modelStatus.updateModel(data as ModelInfo);
    });
    this.sse.on("gpu.status", (data) => {
      this.modelStatus.updateGpu(data as GpuInfo);
    });

    // Lifecycle
    this.sse.on("lifecycle.event", (data) => {
      this.lifecycle.addEvent(data as LifecycleEvent);
    });

    // Policy changes
    this.sse.on("policy.changed", () => {
      this.policyEditor.refreshFileList();
    });
  }

  private async loadInitialState(): Promise<void> {
    try {
      // Load all initial state in parallel
      const [sandboxes, events, stats, model, gpu, policies] =
        await Promise.allSettled([
          rpc<SandboxInfo[]>("sandboxes.list"),
          rpc<SecurityEvent[]>("security.recent", { count: 100 }),
          rpc<RoutingStats>("routing.stats"),
          rpc<ModelInfo>("model.status"),
          rpc<GpuInfo>("gpu.status"),
          rpc<PolicyFile[]>("policies.list"),
        ]);

      if (sandboxes.status === "fulfilled") {
        for (const sb of sandboxes.value) {
          this.sandboxView.addSandbox(sb);
        }
      }

      if (events.status === "fulfilled") {
        for (const ev of events.value) {
          this.securityLog.addEvent(ev);
        }
      }

      if (stats.status === "fulfilled") {
        this.routerView.updateStats(stats.value);
      }

      if (model.status === "fulfilled") {
        this.modelStatus.updateModel(model.value);
      }

      if (gpu.status === "fulfilled") {
        this.modelStatus.updateGpu(gpu.value);
      }

      if (policies.status === "fulfilled") {
        this.policyEditor.setFiles(policies.value);
      }
    } catch (err) {
      console.error("Failed to load initial state:", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const app = new NemoClawApp();
  app.start().catch((err) => console.error("App start failed:", err));
});
