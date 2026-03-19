/**
 * Aurelius Autonomous Workbench - Main Process Entry
 *
 * Electrobun main process that initializes all five panels, sets up
 * RPC handlers, starts the autonomy scheduler, creates the system tray,
 * and manages IPC between panels.
 */

import { MaestroRPC } from "./rpc/maestro.rpc";
import { NemoClawRPC } from "./rpc/nemoclaw.rpc";
import { TriggerRPC } from "./rpc/trigger.rpc";
import { OpaRPC } from "./rpc/opa.rpc";
import { MinioRPC } from "./rpc/minio.rpc";

import { Scheduler } from "./autonomy/scheduler";
import { Watcher } from "./autonomy/watcher";
import { Governor } from "./autonomy/governor";
import { Notifier } from "./autonomy/notifier";

import type {
  PanelId,
  PanelConfig,
  AutonomyLevel,
  ScheduleEntry,
  WatcherEvent,
  OperationRequest,
} from "../shared/types";
import {
  createReply,
  createEvent,
  isRequest,
  type IPCRequest,
  type IPCEnvelope,
} from "../shared/ipc";
import {
  IPC_CHANNELS,
  PANEL_IDS,
  PANEL_TITLES,
  DEFAULT_PANEL_DIMENSIONS,
  DEFAULT_ENDPOINTS,
  WORKBENCH,
} from "../shared/constants";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const config = {
  opaEndpoint: process.env.OPA_ENDPOINT ?? DEFAULT_ENDPOINTS.OPA,
  minioEndpoint: process.env.MINIO_ENDPOINT ?? DEFAULT_ENDPOINTS.MINIO,
  minioUser: process.env.MINIO_USER ?? "aurelius",
  minioPassword: process.env.MINIO_PASSWORD ?? "changeme123",
  openshellEndpoint: process.env.OPENSHELL_ENDPOINT ?? DEFAULT_ENDPOINTS.OPENSHELL,
  autonomyConfig: (process.env.AUTONOMY_CONFIG ?? "supervised") as AutonomyLevel,
  workbenchPort: parseInt(process.env.WORKBENCH_PORT ?? String(WORKBENCH.DEFAULT_PORT), 10),
};

// ---------------------------------------------------------------------------
// Panel registry
// ---------------------------------------------------------------------------

interface Panel {
  config: PanelConfig;
  webview: unknown; // Electrobun Webview handle
}

const panels: Map<PanelId, Panel> = new Map();

// ---------------------------------------------------------------------------
// RPC handler instances
// ---------------------------------------------------------------------------

const maestroRPC = new MaestroRPC();
const nemoClawRPC = new NemoClawRPC(config.openshellEndpoint);
const triggerRPC = new TriggerRPC();
const opaRPC = new OpaRPC(config.opaEndpoint);
const minioRPC = new MinioRPC(config.minioEndpoint, config.minioUser, config.minioPassword);

// ---------------------------------------------------------------------------
// Autonomy subsystem instances
// ---------------------------------------------------------------------------

const scheduler = new Scheduler({ autonomyLevel: config.autonomyConfig });
const watcher = new Watcher({ watchDir: "./incoming/rfps" });
const governor = new Governor(config.autonomyConfig);
const notifier = new Notifier();

// ---------------------------------------------------------------------------
// Panel initialization
// ---------------------------------------------------------------------------

function buildPanelConfigs(): PanelConfig[] {
  const panelIds: PanelId[] = ["maestro", "nemoclaw", "trigger", "compliance", "workspace"];
  const baseUrl = `http://localhost:${config.workbenchPort}`;

  return panelIds.map((id) => {
    const dims = DEFAULT_PANEL_DIMENSIONS[id];
    return {
      id,
      title: PANEL_TITLES[id],
      url: `${baseUrl}/${id}`,
      width: dims.width,
      height: dims.height,
      resizable: true,
      visible: id === "maestro", // Only maestro visible by default
    };
  });
}

function initializePanels(): void {
  const configs = buildPanelConfigs();

  for (const panelConfig of configs) {
    // In production, this creates an Electrobun BrowserView
    // For now, we register the panel configuration
    panels.set(panelConfig.id, {
      config: panelConfig,
      webview: null, // Placeholder for Electrobun webview handle
    });

    console.log(`[Panel] Registered: ${panelConfig.title} (${panelConfig.url})`);
  }
}

// ---------------------------------------------------------------------------
// IPC routing
// ---------------------------------------------------------------------------

async function handleIPCMessage(envelope: IPCEnvelope): Promise<void> {
  if (!isRequest(envelope)) return;

  const request = envelope as IPCRequest;
  const [domain, method] = request.method.split(":");

  let response: unknown;

  try {
    // Governor check for non-read operations
    const readOnlyMethods = new Set(["status", "list", "get", "health", "listSchedules", "listSessions", "getSecurityEvents", "listTasks", "getTaskStatus", "listPolicies", "healthCheck", "listBuckets"]);
    const isReadOnly = readOnlyMethods.has(method) || method.startsWith("list") || method.startsWith("get");

    if (!isReadOnly) {
      const decision = await governor.evaluate({
        operation: request.method,
        source: request.source,
        context: request.payload as Record<string, unknown>,
      });

      if (!decision.allowed) {
        const reply = createReply(request, null, false, decision.reason);
        broadcastToPanel(request.source as PanelId, reply);
        return;
      }
    }

    // Route to appropriate RPC handler
    switch (domain) {
      case "maestro":
        response = await routeMaestro(method, request.payload);
        break;
      case "nemoclaw":
        response = await routeNemoClaw(method, request.payload);
        break;
      case "trigger":
        response = await routeTrigger(method, request.payload);
        break;
      case "opa":
        response = await routeOpa(method, request.payload);
        break;
      case "minio":
        response = await routeMinio(method, request.payload);
        break;
      default:
        response = { ok: false, error: `Unknown domain: ${domain}` };
    }

    const reply = createReply(request, response, true);
    broadcastToPanel(request.source as PanelId, reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reply = createReply(request, null, false, message);
    broadcastToPanel(request.source as PanelId, reply);
  }
}

async function routeMaestro(method: string, payload: unknown): Promise<unknown> {
  const p = payload as Record<string, unknown>;
  switch (method) {
    case "start":
      return maestroRPC.startLoop(p as any);
    case "pause":
      return maestroRPC.pauseLoop();
    case "resume":
      return maestroRPC.resumeLoop();
    case "stop":
      return maestroRPC.stopLoop();
    case "status":
      return maestroRPC.getStatus();
    case "advance":
      return maestroRPC.advancePhase();
    case "setSchedule":
      return maestroRPC.setSchedule(p.entry as ScheduleEntry);
    case "listSchedules":
      return maestroRPC.listSchedules();
    case "removeSchedule":
      return maestroRPC.removeSchedule(p.id as string);
    default:
      return { ok: false, error: `Unknown maestro method: ${method}` };
  }
}

async function routeNemoClaw(method: string, payload: unknown): Promise<unknown> {
  const p = payload as Record<string, unknown>;
  switch (method) {
    case "createSandbox":
      return nemoClawRPC.createSandbox(p as any);
    case "execInSandbox":
      return nemoClawRPC.execInSandbox(p.sessionId as string, p.command as string[]);
    case "destroySandbox":
      return nemoClawRPC.destroySandbox(p.sessionId as string);
    case "listSessions":
      return nemoClawRPC.listSessions();
    case "queryPolicy":
      return nemoClawRPC.queryPolicy(p as any);
    case "getSecurityEvents":
      return nemoClawRPC.getSecurityEvents(p as any);
    default:
      return { ok: false, error: `Unknown nemoclaw method: ${method}` };
  }
}

async function routeTrigger(method: string, payload: unknown): Promise<unknown> {
  const p = payload as Record<string, unknown>;
  switch (method) {
    case "enqueue":
      return triggerRPC.enqueue(p as any);
    case "enqueueBatch":
      return triggerRPC.enqueueBatch(p.definitions as any);
    case "getTaskStatus":
      return triggerRPC.getTaskStatus(p.taskId as string);
    case "listTasks":
      return triggerRPC.listTasks(p as any);
    case "cancelTask":
      return triggerRPC.cancelTask(p.taskId as string);
    case "purgeTasks":
      return triggerRPC.purgeTasks(p.maxAgeMs as number | undefined);
    default:
      return { ok: false, error: `Unknown trigger method: ${method}` };
  }
}

async function routeOpa(method: string, payload: unknown): Promise<unknown> {
  const p = payload as Record<string, unknown>;
  switch (method) {
    case "evaluate":
      return opaRPC.evaluate(p as any);
    case "evaluateBatch":
      return opaRPC.evaluateBatch(p as any);
    case "complianceScan":
      return opaRPC.runComplianceScan(p.input as Record<string, unknown>);
    case "frameworkScore":
      return opaRPC.getFrameworkScore(p.framework as string, p.input as Record<string, unknown>);
    case "evaluateProposal":
      return opaRPC.evaluateProposal(p.input as Record<string, unknown>);
    case "checkConstraints":
      return opaRPC.checkConstraints(p.operation as string, p.input as Record<string, unknown>);
    case "healthCheck":
      return opaRPC.healthCheck();
    case "listPolicies":
      return opaRPC.listPolicies();
    default:
      return { ok: false, error: `Unknown opa method: ${method}` };
  }
}

async function routeMinio(method: string, payload: unknown): Promise<unknown> {
  const p = payload as Record<string, unknown>;
  switch (method) {
    case "upload":
      return minioRPC.upload(p as any);
    case "download":
      return minioRPC.download(p as any);
    case "list":
      return minioRPC.list(p as any);
    case "delete":
      return minioRPC.delete(p as any);
    case "exists":
      return minioRPC.exists(p as any);
    case "listBuckets":
      return minioRPC.listBuckets();
    case "ensureBucket":
      return minioRPC.ensureBucket(p.bucket as string);
    case "presignUrl":
      return minioRPC.presignUrl(p as any);
    default:
      return { ok: false, error: `Unknown minio method: ${method}` };
  }
}

function broadcastToPanel(panelId: PanelId, message: unknown): void {
  const panel = panels.get(panelId);
  if (panel?.webview) {
    // In production: panel.webview.postMessage(message)
    console.log(`[IPC] -> ${panelId}:`, JSON.stringify(message).slice(0, 200));
  }
}

function broadcastToAll(message: unknown): void {
  for (const [id] of panels) {
    broadcastToPanel(id, message);
  }
}

// ---------------------------------------------------------------------------
// Autonomy subsystem setup
// ---------------------------------------------------------------------------

async function initializeAutonomy(): Promise<void> {
  // Governor callbacks
  governor.setCallbacks({
    onApprovalRequired: async (request: OperationRequest) => {
      notifier.notifyApprovalRequired(
        request.operation,
        `Source: ${request.source}`,
      );
      // In production, this shows a modal and waits for user input
      // For now, auto-approve in guided/fully_autonomous modes
      return governor.getLevel() !== "supervised";
    },
    onNotification: (message: string, operation: string) => {
      notifier.notify({
        title: "Governor",
        body: message,
        category: "system",
        priority: "normal",
      });
    },
  });

  // Scheduler setup
  await scheduler.initialize(async (entry: ScheduleEntry) => {
    console.log(`[Scheduler] Triggering: ${entry.name}`);
    await triggerRPC.enqueue({
      taskType: entry.taskType,
      payload: entry.payload,
    });
    notifier.notify({
      title: "Scheduled Task",
      body: `Started: ${entry.name}`,
      category: "task_complete",
      priority: "low",
    });
  });

  // Watcher setup
  await watcher.initialize(async (event: WatcherEvent) => {
    console.log(`[Watcher] Detected: ${event.filename} (${event.type})`);
    notifier.notifyRfpDetected(event.filename, "local_inbox");

    broadcastToAll(
      createEvent("main", IPC_CHANNELS.WORKSPACE, "rfp:detected", {
        filename: event.filename,
        path: event.filePath,
      }),
    );
  });

  // Notification listener to broadcast to panels
  notifier.addListener("panel-broadcast", (notification) => {
    broadcastToAll(
      createEvent("main", IPC_CHANNELS.NOTIFICATIONS, "notification", {
        title: notification.title,
        body: notification.body,
        priority: notification.priority,
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createSystemTray(): void {
  // In production, this creates a native system tray icon with Electrobun
  console.log(`[Tray] ${WORKBENCH.APP_NAME} v${WORKBENCH.VERSION}`);
  console.log("[Tray] System tray initialized");

  // Tray menu items (conceptual):
  // - Show/Hide Maestro Panel
  // - Show/Hide NemoClaw Panel
  // - Show/Hide Trigger Panel
  // - Show/Hide Compliance Panel
  // - Show/Hide Workspace Panel
  // - ---
  // - Autonomy Level: [Supervised | Guided | Fully Autonomous]
  // - ---
  // - Start Research Loop
  // - Pause Research Loop
  // - ---
  // - Notifications (badge count)
  // - ---
  // - Quit
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[Boot] ${WORKBENCH.APP_NAME} v${WORKBENCH.VERSION}`);
  console.log(`[Boot] Autonomy level: ${config.autonomyConfig}`);
  console.log(`[Boot] Workbench port: ${config.workbenchPort}`);

  // Step 1: Initialize panels
  initializePanels();

  // Step 2: Set up RPC handlers (implicit via routing in handleIPCMessage)
  console.log("[Boot] RPC handlers registered");

  // Step 3: Initialize autonomy subsystem
  await initializeAutonomy();
  console.log("[Boot] Autonomy subsystem initialized");

  // Step 4: Start the scheduler
  scheduler.start();
  console.log("[Boot] Scheduler started");

  // Step 5: Start the file watcher
  await watcher.start();
  console.log("[Boot] File watcher started");

  // Step 6: Create system tray
  createSystemTray();

  // Step 7: Health checks
  const opaHealth = await opaRPC.healthCheck();
  console.log(`[Boot] OPA health: ${opaHealth.data?.healthy ? "OK" : "UNAVAILABLE"}`);

  console.log("[Boot] Aurelius Autonomous Workbench is ready");
}

// Run
main().catch((error) => {
  console.error("[Fatal]", error);
  process.exit(1);
});

// Exports for testing
export {
  handleIPCMessage,
  maestroRPC,
  nemoClawRPC,
  triggerRPC,
  opaRPC,
  minioRPC,
  scheduler,
  watcher,
  governor,
  notifier,
};
