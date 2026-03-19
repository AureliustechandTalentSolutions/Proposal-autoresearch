/**
 * IPC Message Types and Helpers
 *
 * Typed inter-process communication between panels and the main process.
 * Provides both the message envelope types and a WebSocket-based client
 * for panel-side use.
 */

import type {
  PanelId,
  LoopStatus,
  SandboxSession,
  TaskStatus,
  ComplianceScore,
  ArtifactMetadata,
  GovernorDecision,
  AutonomyLevel,
  MaestroCommand,
  SandboxConfig,
  TaskDefinition,
  PolicyQuery,
  PolicyResult,
  RPCResponse,
} from "./types";
import { IPC_CHANNELS } from "./constants";

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export interface IPCMessage<T = unknown> {
  /** Unique message ID for request/response correlation */
  id: string;
  /** Channel this message is sent on */
  channel: string;
  /** Originating panel or 'main' */
  source: PanelId | "main";
  /** Target panel or 'main' */
  target: PanelId | "main";
  /** Timestamp of message creation */
  timestamp: number;
  /** Payload */
  payload: T;
}

export interface IPCRequest<T = unknown> extends IPCMessage<T> {
  type: "request";
  method: string;
}

export interface IPCReply<T = unknown> extends IPCMessage<T> {
  type: "reply";
  requestId: string;
  success: boolean;
  error?: string;
}

export interface IPCEvent<T = unknown> extends IPCMessage<T> {
  type: "event";
  event: string;
}

export type IPCEnvelope = IPCRequest | IPCReply | IPCEvent;

// ---------------------------------------------------------------------------
// Channel-specific payloads
// ---------------------------------------------------------------------------

/** Maestro panel -> main process */
export type MaestroRequest =
  | { method: "maestro:start"; params: { totalCycles: number; autonomyLevel: AutonomyLevel } }
  | { method: "maestro:pause" }
  | { method: "maestro:resume" }
  | { method: "maestro:stop" }
  | { method: "maestro:status" }
  | { method: "maestro:advance" }
  | { method: "maestro:setSchedule"; params: { entry: unknown } }
  | { method: "maestro:listSchedules" };

/** NemoClaw panel -> main process */
export type NemoClawRequest =
  | { method: "nemoclaw:createSandbox"; params: SandboxConfig }
  | { method: "nemoclaw:execInSandbox"; params: { sessionId: string; command: string[] } }
  | { method: "nemoclaw:destroySandbox"; params: { sessionId: string } }
  | { method: "nemoclaw:listSessions" }
  | { method: "nemoclaw:queryPolicy"; params: PolicyQuery }
  | { method: "nemoclaw:getSecurityEvents"; params?: { type?: string; since?: number; limit?: number } };

/** Trigger panel -> main process */
export type TriggerRequest =
  | { method: "trigger:enqueue"; params: TaskDefinition }
  | { method: "trigger:enqueueBatch"; params: { definitions: TaskDefinition[] } }
  | { method: "trigger:getTaskStatus"; params: { taskId: string } }
  | { method: "trigger:listTasks"; params?: { status?: string; taskType?: string; limit?: number } }
  | { method: "trigger:cancelTask"; params: { taskId: string } }
  | { method: "trigger:purgeTasks"; params?: { maxAgeMs?: number } };

/** Compliance panel -> main process */
export type ComplianceRequest =
  | { method: "opa:evaluate"; params: { policyPath: string; input: Record<string, unknown> } }
  | { method: "opa:evaluateBatch"; params: { policyPaths: string[]; input: Record<string, unknown> } }
  | { method: "opa:complianceScan"; params: { input: Record<string, unknown> } }
  | { method: "opa:frameworkScore"; params: { framework: string; input: Record<string, unknown> } }
  | { method: "opa:evaluateProposal"; params: { input: Record<string, unknown> } }
  | { method: "opa:checkConstraints"; params: { operation: string; input: Record<string, unknown> } }
  | { method: "opa:healthCheck" }
  | { method: "opa:listPolicies" };

/** Workspace panel -> main process */
export type WorkspaceRequest =
  | { method: "minio:upload"; params: { bucket: string; key: string; data: string; contentType?: string } }
  | { method: "minio:download"; params: { bucket: string; key: string } }
  | { method: "minio:list"; params: { bucket: string; prefix?: string; maxKeys?: number } }
  | { method: "minio:delete"; params: { bucket: string; key: string } }
  | { method: "minio:exists"; params: { bucket: string; key: string } }
  | { method: "minio:listBuckets" };

/** Events emitted from main process -> panels */
export type MainEvent =
  | { event: "loop:statusChanged"; data: LoopStatus }
  | { event: "task:statusChanged"; data: TaskStatus }
  | { event: "compliance:scoreUpdated"; data: ComplianceScore }
  | { event: "sandbox:created"; data: SandboxSession }
  | { event: "sandbox:destroyed"; data: { sessionId: string } }
  | { event: "rfp:detected"; data: { filename: string; path: string } }
  | { event: "governor:decision"; data: GovernorDecision }
  | { event: "notification"; data: { title: string; body: string; priority: string } };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a typed IPC request message.
 */
export function createRequest<T>(
  source: PanelId | "main",
  target: PanelId | "main",
  channel: string,
  method: string,
  payload: T,
): IPCRequest<T> {
  return {
    id: crypto.randomUUID(),
    type: "request",
    channel,
    source,
    target,
    timestamp: Date.now(),
    method,
    payload,
  };
}

/**
 * Create a typed IPC reply message.
 */
export function createReply<T>(
  request: IPCRequest,
  payload: T,
  success: boolean = true,
  error?: string,
): IPCReply<T> {
  return {
    id: crypto.randomUUID(),
    type: "reply",
    channel: request.channel,
    source: request.target as PanelId | "main",
    target: request.source,
    timestamp: Date.now(),
    requestId: request.id,
    success,
    error,
    payload,
  };
}

/**
 * Create a typed IPC event message.
 */
export function createEvent<T>(
  source: PanelId | "main",
  channel: string,
  event: string,
  payload: T,
): IPCEvent<T> {
  return {
    id: crypto.randomUUID(),
    type: "event",
    channel,
    source,
    target: "main",
    timestamp: Date.now(),
    event,
    payload,
  };
}

/**
 * Type guard for IPC requests.
 */
export function isRequest(msg: IPCEnvelope): msg is IPCRequest {
  return msg.type === "request";
}

/**
 * Type guard for IPC replies.
 */
export function isReply(msg: IPCEnvelope): msg is IPCReply {
  return msg.type === "reply";
}

/**
 * Type guard for IPC events.
 */
export function isEvent(msg: IPCEnvelope): msg is IPCEvent {
  return msg.type === "event";
}

// ---------------------------------------------------------------------------
// WebSocket IPC Client (panel-side)
// ---------------------------------------------------------------------------

/**
 * Client-side WebSocket IPC bridge for use in panel webviews.
 * Handles connection, reconnection, request/response correlation,
 * and event subscription.
 *
 * Usage (in a panel's app.ts):
 * ```
 *   const ipc = new IPCClient("maestro");
 *   await ipc.connect();
 *   const status = await ipc.request("maestro:status", {});
 *   ipc.on("loop:statusChanged", (data) => { ... });
 * ```
 */
export class IPCClient {
  private ws: WebSocket | null = null;
  private panelId: PanelId;
  private pendingRequests: Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private requestTimeout = 30000;
  private connected = false;
  private _onConnect: (() => void) | null = null;
  private _onDisconnect: (() => void) | null = null;

  constructor(panelId: PanelId) {
    this.panelId = panelId;
  }

  /**
   * Connect to the main process WebSocket server.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${location.host}/ws?panel=${this.panelId}`;

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        console.log(`[IPC] Connected as ${this.panelId}`);
        if (this._onConnect) this._onConnect();
        resolve();
      };

      this.ws.onmessage = (ev) => {
        this.handleMessage(ev.data);
      };

      this.ws.onclose = () => {
        this.connected = false;
        console.log("[IPC] Disconnected");
        if (this._onDisconnect) this._onDisconnect();
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        if (!this.connected) {
          reject(new Error("WebSocket connection failed"));
        }
      };
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Disconnected"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Send an RPC request and wait for the response.
   */
  request<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected"));
        return;
      }

      const msg = createRequest(this.panelId, "main", `ipc:${method.split(":")[0]}`, method, payload);

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(msg.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  /**
   * Subscribe to events from the main process.
   */
  on(event: string, handler: (data: unknown) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Set a callback for when the connection is established.
   */
  onConnect(fn: () => void): void {
    this._onConnect = fn;
  }

  /**
   * Set a callback for when the connection is lost.
   */
  onDisconnect(fn: () => void): void {
    this._onDisconnect = fn;
  }

  /**
   * Check if the client is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  private handleMessage(data: string): void {
    try {
      const envelope = JSON.parse(data) as IPCEnvelope;

      // Handle reply (response to a request)
      if (envelope.type === "reply") {
        const reply = envelope as IPCReply;
        const pending = this.pendingRequests.get(reply.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(reply.requestId);
          if (reply.success) {
            pending.resolve(reply.payload);
          } else {
            pending.reject(new Error(reply.error ?? "Request failed"));
          }
        }
        return;
      }

      // Handle event
      if (envelope.type === "event") {
        const event = envelope as IPCEvent;
        const handlers = this.eventHandlers.get(event.event);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(event.payload);
            } catch (err) {
              console.error(`[IPC] Event handler error for ${event.event}:`, err);
            }
          }
        }

        // Also dispatch to wildcard handlers
        const wildcardHandlers = this.eventHandlers.get("*");
        if (wildcardHandlers) {
          for (const handler of wildcardHandlers) {
            try {
              handler({ event: event.event, data: event.payload });
            } catch (err) {
              console.error("[IPC] Wildcard handler error:", err);
            }
          }
        }
        return;
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      console.log(`[IPC] Reconnecting in ${this.reconnectDelay}ms...`);
      this.connect().catch(() => {
        // Will retry via onclose handler
      });
    }, this.reconnectDelay);
  }
}
