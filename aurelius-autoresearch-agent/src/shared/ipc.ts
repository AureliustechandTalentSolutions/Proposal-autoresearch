/**
 * IPC Message Types and Helpers
 *
 * Typed inter-process communication between panels and the main process.
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
    target: "main", // Events broadcast; target is informational
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
