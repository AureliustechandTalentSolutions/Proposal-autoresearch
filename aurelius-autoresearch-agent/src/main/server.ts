/**
 * Panel Server & Router
 *
 * Bun.serve()-based HTTP/WebSocket server that serves the five panel
 * webviews and provides real-time IPC between panels and the main process.
 *
 * Routes:
 *   /maestro, /nemoclaw, /trigger, /compliance, /workspace  -> Panel HTML
 *   /ws                                                       -> WebSocket IPC
 *   /api/events                                               -> SSE stream
 *   /api/status                                               -> JSON status
 *   /panels/<panel>/<asset>                                   -> Static assets
 */

import { join, extname } from "path";
import type { Server, ServerWebSocket } from "bun";
import type { PanelId } from "../shared/types";
import type { IPCEnvelope, IPCRequest } from "../shared/ipc";
import { isRequest } from "../shared/ipc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelServerConfig {
  port: number;
  hostname?: string;
  panelsDir: string;
  onIPCMessage: (envelope: IPCEnvelope, ws: ServerWebSocket<WSData>) => Promise<void>;
  onWSConnect?: (panelId: PanelId, ws: ServerWebSocket<WSData>) => void;
  onWSDisconnect?: (panelId: PanelId, ws: ServerWebSocket<WSData>) => void;
}

export interface WSData {
  panelId: PanelId | null;
  connectedAt: number;
}

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".ts": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const VALID_PANELS: Set<string> = new Set([
  "maestro",
  "nemoclaw",
  "trigger",
  "compliance",
  "workspace",
]);

// ---------------------------------------------------------------------------
// SSE client registry
// ---------------------------------------------------------------------------

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  panelId: PanelId | "all";
  connectedAt: number;
}

const sseClients: Map<string, SSEClient> = new Map();

/**
 * Broadcast an SSE event to all connected clients (or a specific panel).
 */
export function broadcastSSE(
  event: string,
  data: unknown,
  targetPanel?: PanelId,
): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoder = new TextEncoder();
  const encoded = encoder.encode(payload);

  for (const [id, client] of sseClients) {
    if (targetPanel && client.panelId !== "all" && client.panelId !== targetPanel) {
      continue;
    }
    try {
      client.controller.enqueue(encoded);
    } catch {
      // Client disconnected; clean up
      sseClients.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket client registry
// ---------------------------------------------------------------------------

const wsClients: Map<string, ServerWebSocket<WSData>> = new Map();

/**
 * Send a message to a specific panel's WebSocket connections.
 */
export function sendToPanel(panelId: PanelId, message: unknown): void {
  const payload = JSON.stringify(message);
  for (const [, ws] of wsClients) {
    if (ws.data.panelId === panelId && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

/**
 * Broadcast a message to all connected WebSocket clients.
 */
export function broadcastWS(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const [, ws] of wsClients) {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

/**
 * Get the count of active WebSocket connections.
 */
export function getWSClientCount(): number {
  return wsClients.size;
}

/**
 * Get the count of active SSE connections.
 */
export function getSSEClientCount(): number {
  return sseClients.size;
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export function createPanelServer(config: PanelServerConfig): Server {
  const { port, hostname, panelsDir, onIPCMessage, onWSConnect, onWSDisconnect } = config;

  const server = Bun.serve<WSData>({
    port,
    hostname: hostname ?? "localhost",

    // -----------------------------------------------------------------------
    // HTTP request handler
    // -----------------------------------------------------------------------
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // -- WebSocket upgrade --
      if (path === "/ws") {
        const panelParam = url.searchParams.get("panel") as PanelId | null;
        const upgraded = server.upgrade(req, {
          data: {
            panelId: panelParam && VALID_PANELS.has(panelParam) ? panelParam : null,
            connectedAt: Date.now(),
          },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // -- SSE endpoint --
      if (path === "/api/events") {
        const panelParam = (url.searchParams.get("panel") ?? "all") as PanelId | "all";
        const clientId = crypto.randomUUID();

        const stream = new ReadableStream({
          start(controller) {
            sseClients.set(clientId, {
              id: clientId,
              controller,
              panelId: panelParam,
              connectedAt: Date.now(),
            });

            // Send initial keepalive
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            sseClients.delete(clientId);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // -- Status API --
      if (path === "/api/status") {
        return Response.json({
          ok: true,
          wsClients: wsClients.size,
          sseClients: sseClients.size,
          uptime: process.uptime(),
          timestamp: Date.now(),
        });
      }

      // -- Panel routes --
      const panelMatch = path.match(/^\/(maestro|nemoclaw|trigger|compliance|workspace)\/?$/);
      if (panelMatch) {
        const panelId = panelMatch[1];
        const htmlPath = join(panelsDir, panelId, "index.html");
        const file = Bun.file(htmlPath);
        if (await file.exists()) {
          return new Response(file, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response(`Panel '${panelId}' not found`, { status: 404 });
      }

      // -- Static asset serving for panels --
      if (path.startsWith("/panels/")) {
        const assetPath = join(panelsDir, path.replace("/panels/", ""));
        const file = Bun.file(assetPath);
        if (await file.exists()) {
          const ext = extname(assetPath);
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          return new Response(file, {
            headers: { "Content-Type": contentType },
          });
        }
        return new Response("Not found", { status: 404 });
      }

      // -- Root redirect --
      if (path === "/" || path === "") {
        return Response.redirect(`http://${hostname ?? "localhost"}:${port}/maestro`, 302);
      }

      // -- Favicon --
      if (path === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    },

    // -----------------------------------------------------------------------
    // WebSocket handlers
    // -----------------------------------------------------------------------
    websocket: {
      open(ws) {
        const connId = crypto.randomUUID();
        (ws as any).__connId = connId;
        wsClients.set(connId, ws);

        console.log(
          `[WS] Connected: panel=${ws.data.panelId ?? "unknown"} id=${connId.slice(0, 8)}`,
        );

        if (ws.data.panelId && onWSConnect) {
          onWSConnect(ws.data.panelId, ws);
        }

        // Send welcome message
        ws.send(
          JSON.stringify({
            type: "event",
            event: "connected",
            source: "main",
            timestamp: Date.now(),
            payload: { panelId: ws.data.panelId },
          }),
        );
      },

      async message(ws, message) {
        try {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          const envelope = JSON.parse(text) as IPCEnvelope;

          // Auto-set source from WS panel identity if not specified
          if (ws.data.panelId && !envelope.source) {
            (envelope as any).source = ws.data.panelId;
          }

          // Identify panel from incoming message if WS didn't specify
          if (!ws.data.panelId && envelope.source && envelope.source !== "main") {
            ws.data.panelId = envelope.source as PanelId;
          }

          await onIPCMessage(envelope, ws);
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "reply",
              success: false,
              error: `Invalid message: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: Date.now(),
            }),
          );
        }
      },

      close(ws) {
        const connId = (ws as any).__connId as string;
        if (connId) {
          wsClients.delete(connId);
        }

        console.log(`[WS] Disconnected: panel=${ws.data.panelId ?? "unknown"}`);

        if (ws.data.panelId && onWSDisconnect) {
          onWSDisconnect(ws.data.panelId, ws);
        }
      },

      drain(ws) {
        // Backpressure relief - no action needed
      },
    },
  });

  console.log(`[Server] Panel server listening on http://${hostname ?? "localhost"}:${port}`);

  // SSE keepalive interval (every 30s)
  setInterval(() => {
    const encoder = new TextEncoder();
    const keepalive = encoder.encode(": keepalive\n\n");
    for (const [id, client] of sseClients) {
      try {
        client.controller.enqueue(keepalive);
      } catch {
        sseClients.delete(id);
      }
    }
  }, 30_000);

  return server;
}
