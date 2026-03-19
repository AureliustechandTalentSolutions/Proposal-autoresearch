/**
 * Maestro Panel - Application Logic
 *
 * TypeScript module for the Maestro research loop dashboard.
 * Connects to the main process via WebSocket IPC, renders the score
 * trajectory chart, and manages the run lifecycle.
 *
 * Note: The index.html contains an inline script version for zero-build
 * operation. This file provides a typed, importable version for use
 * when a build step (e.g., Bun bundler) is available.
 */

import type { AutonomyLevel, LoopStatus } from "../../shared/types";
import type { IterationResult } from "../../main/loop/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface NotificationData {
  title: string;
  body: string;
  priority?: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// IPC Client (panel-side WebSocket)
// ---------------------------------------------------------------------------

class MaestroIPC {
  private ws: WebSocket | null = null;
  private connected = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${location.host}/ws?panel=maestro`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000;
        this.emit("connected", null);
        resolve();
      };

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this.handleMessage(msg);
        } catch { /* ignore */ }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.emit("disconnected", null);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        if (!this.connected) reject(new Error("Connection failed"));
      };
    });
  }

  request<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected"));
        return;
      }

      const id = crypto.randomUUID();
      const msg = {
        id,
        type: "request",
        channel: "ipc:maestro",
        source: "maestro",
        target: "main",
        timestamp: Date.now(),
        method,
        payload,
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 15_000);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private emit(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch { /* ignore */ }
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "reply" && typeof msg.requestId === "string") {
      const pending = this.pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.requestId);
        if (msg.success) {
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error((msg.error as string) ?? "Request failed"));
        }
      }
      return;
    }

    if (msg.type === "event" && typeof msg.event === "string") {
      this.emit(msg.event, msg.payload);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect().catch(() => { /* retry */ });
    }, this.reconnectDelay);
  }
}

// ---------------------------------------------------------------------------
// Score Chart Renderer (SVG)
// ---------------------------------------------------------------------------

class ScoreChart {
  private svg: SVGSVGElement;
  private line: SVGPolylineElement;
  private dotsGroup: SVGGElement;
  private scores: number[] = [];

  private readonly width = 600;
  private readonly height = 200;
  private readonly padLeft = 30;
  private readonly padRight = 10;
  private readonly padTop = 5;
  private readonly padBottom = 5;

  constructor(svgId: string, lineId: string, dotsId: string) {
    this.svg = document.getElementById(svgId) as unknown as SVGSVGElement;
    this.line = document.getElementById(lineId) as unknown as SVGPolylineElement;
    this.dotsGroup = document.getElementById(dotsId) as unknown as SVGGElement;
  }

  addScore(score: number): void {
    this.scores.push(score);
    this.render();
  }

  reset(): void {
    this.scores = [];
    this.line.setAttribute("points", "");
    this.dotsGroup.innerHTML = "";
  }

  getLatest(): number | null {
    return this.scores.length > 0 ? this.scores[this.scores.length - 1] : null;
  }

  private render(): void {
    if (this.scores.length === 0) return;

    const w = this.width - this.padLeft - this.padRight;
    const h = this.height - this.padTop - this.padBottom;
    const step = this.scores.length > 1 ? w / (this.scores.length - 1) : 0;

    const points = this.scores
      .map((s, i) => {
        const x = this.padLeft + i * step;
        const y = this.padTop + (1 - s) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

    this.line.setAttribute("points", points);

    // Render dots
    this.dotsGroup.innerHTML = "";
    this.scores.forEach((s, i) => {
      const x = this.padLeft + i * step;
      const y = this.padTop + (1 - s) * h;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", x.toFixed(1));
      circle.setAttribute("cy", y.toFixed(1));
      circle.setAttribute("r", "3");

      let color = "#4299e1";
      if (i > 0) {
        color = s > this.scores[i - 1] ? "#38a169" : s < this.scores[i - 1] ? "#e53e3e" : "#4299e1";
      }
      circle.setAttribute("fill", color);

      this.dotsGroup.appendChild(circle);
    });
  }
}

// ---------------------------------------------------------------------------
// Iteration Table Renderer
// ---------------------------------------------------------------------------

class IterationTable {
  private tbody: HTMLElement;
  private countBadge: HTMLElement;
  private iterations: IterationResult[] = [];

  constructor(tbodyId: string, countBadgeId: string) {
    this.tbody = document.getElementById(tbodyId)!;
    this.countBadge = document.getElementById(countBadgeId)!;
  }

  add(iteration: IterationResult): void {
    this.iterations.push(iteration);
    this.render();
  }

  reset(): void {
    this.iterations = [];
    this.render();
  }

  private render(): void {
    this.countBadge.textContent = String(this.iterations.length);

    if (this.iterations.length === 0) {
      this.tbody.innerHTML =
        '<tr><td colspan="7" class="empty-state">No iterations yet. Start a research loop.</td></tr>';
      return;
    }

    this.tbody.innerHTML = [...this.iterations]
      .reverse()
      .map((it) => {
        const delta = it.score_after - it.score_before;
        const deltaClass =
          delta > 0.0001 ? "score--up" : delta < -0.0001 ? "score--down" : "score--neutral";
        const deltaStr = `${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`;
        const dur = `${((it.finished_at - it.started_at) / 1000).toFixed(1)}s`;
        const badgeClass = it.decision === "KEEP" ? "badge--keep" : "badge--discard";

        return `<tr>
          <td style="font-family:var(--font-mono)">${it.iteration}</td>
          <td title="${this.escHtml(it.hypothesis)}">${this.escHtml(this.truncate(it.hypothesis, 40))}</td>
          <td class="score-cell">${it.score_before.toFixed(4)}</td>
          <td class="score-cell">${it.score_after.toFixed(4)}</td>
          <td class="score-cell ${deltaClass}">${deltaStr}</td>
          <td><span class="badge ${badgeClass}">${it.decision}</span></td>
          <td style="font-family:var(--font-mono)">${dur}</td>
        </tr>`;
      })
      .join("");
  }

  private escHtml(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  private truncate(s: string, n: number): string {
    return s && s.length > n ? s.slice(0, n) + "..." : s ?? "";
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

class MaestroApp {
  private ipc: MaestroIPC;
  private chart: ScoreChart;
  private table: IterationTable;
  private selectedAutonomy: AutonomyLevel = "supervised";
  private loopStatus: LoopStatus = {
    running: false,
    currentCycle: 0,
    totalCycles: 0,
    phase: "idle",
    startedAt: null,
    lastCompletedAt: null,
    autonomyLevel: "supervised",
    errorCount: 0,
  };

  constructor() {
    this.ipc = new MaestroIPC();
    this.chart = new ScoreChart("score-chart", "score-line", "score-dots");
    this.table = new IterationTable("iteration-tbody", "iteration-count");

    this.bindControls();
    this.bindEvents();
  }

  async start(): Promise<void> {
    await this.ipc.connect();
    await this.refreshStatus();
  }

  private bindControls(): void {
    document.getElementById("btn-start")!.addEventListener("click", () => this.startLoop());
    document.getElementById("btn-pause")!.addEventListener("click", () => this.pauseLoop());
    document.getElementById("btn-stop")!.addEventListener("click", () => this.stopLoop());
    document.getElementById("btn-advance")!.addEventListener("click", () => this.advancePhase());

    document.getElementById("autonomy-selector")!.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".autonomy-btn");
      if (!btn) return;
      this.selectedAutonomy = btn.dataset.level as AutonomyLevel;
      document.querySelectorAll(".autonomy-btn").forEach((b) => {
        b.classList.toggle("autonomy-btn--active", (b as HTMLElement).dataset.level === this.selectedAutonomy);
      });
    });
  }

  private bindEvents(): void {
    this.ipc.on("connected", () => {
      (document.getElementById("conn-dot") as HTMLElement).className = "status-dot status-dot--green";
      (document.getElementById("conn-text") as HTMLElement).textContent = "connected";
    });

    this.ipc.on("disconnected", () => {
      (document.getElementById("conn-dot") as HTMLElement).className = "status-dot status-dot--red";
      (document.getElementById("conn-text") as HTMLElement).textContent = "disconnected";
    });

    this.ipc.on("loop:statusChanged", (data) => {
      this.updateStatus(data as LoopStatus);
    });

    this.ipc.on("notification", (data) => {
      this.addNotification(data as NotificationData);
    });
  }

  private async refreshStatus(): Promise<void> {
    try {
      const response = await this.ipc.request<{ data: LoopStatus }>("maestro:status");
      if (response?.data) {
        this.updateStatus(response.data);
      }
    } catch { /* ignore */ }
  }

  private async startLoop(): Promise<void> {
    const cycles = parseInt((document.getElementById("input-cycles") as HTMLInputElement).value, 10) || 10;
    const artifact = (document.getElementById("input-artifact") as HTMLInputElement).value || undefined;

    try {
      const response = await this.ipc.request<{ data: LoopStatus }>("maestro:start", {
        totalCycles: cycles,
        autonomyLevel: this.selectedAutonomy,
        targetArtifact: artifact,
      });
      if (response?.data) this.updateStatus(response.data);
      this.chart.reset();
      this.table.reset();
    } catch (err) {
      this.addNotification({ title: "Error", body: (err as Error).message });
    }
  }

  private async pauseLoop(): Promise<void> {
    try {
      const response = await this.ipc.request<{ data: LoopStatus }>("maestro:pause");
      if (response?.data) this.updateStatus(response.data);
    } catch { /* ignore */ }
  }

  private async stopLoop(): Promise<void> {
    try {
      await this.ipc.request("maestro:stop");
      this.updateStatus({
        running: false, currentCycle: 0, totalCycles: 0,
        phase: "idle", startedAt: null, lastCompletedAt: null,
        autonomyLevel: this.selectedAutonomy, errorCount: 0,
      });
    } catch { /* ignore */ }
  }

  private async advancePhase(): Promise<void> {
    try {
      const response = await this.ipc.request<{ data: LoopStatus }>("maestro:advance");
      if (response?.data) this.updateStatus(response.data);
    } catch { /* ignore */ }
  }

  private updateStatus(status: LoopStatus): void {
    this.loopStatus = status;

    const $ = (id: string) => document.getElementById(id)!;

    $("status-running").textContent = String(status.running);
    $("status-phase").textContent = status.phase;
    $("status-cycle").textContent = `${status.currentCycle}/${status.totalCycles}`;
    $("status-errors").textContent = String(status.errorCount ?? 0);
    $("status-started").textContent = status.startedAt ? new Date(status.startedAt).toLocaleTimeString() : "--";
    $("status-last").textContent = status.lastCompletedAt ? new Date(status.lastCompletedAt).toLocaleTimeString() : "--";

    $("cycle-chip").textContent = `Cycle ${status.currentCycle}/${status.totalCycles}`;
    $("phase-chip").textContent = status.phase;

    const btnStart = $("btn-start") as HTMLButtonElement;
    const btnPause = $("btn-pause") as HTMLButtonElement;
    const btnStop = $("btn-stop") as HTMLButtonElement;
    const btnAdvance = $("btn-advance") as HTMLButtonElement;

    btnStart.disabled = status.running;
    btnPause.disabled = !status.running;
    btnStop.disabled = !status.running && status.phase === "idle";
    btnAdvance.disabled = !status.running;

    // Phase indicator dots
    const phases = ["hypothesis", "modify", "score", "review", "export"];
    const phaseIdx = phases.indexOf(status.phase);
    document.querySelectorAll<HTMLElement>(".phase-dot").forEach((dot, i) => {
      dot.className = "phase-dot";
      if (status.running) {
        if (i < phaseIdx) dot.classList.add("phase-dot--done");
        else if (i === phaseIdx) dot.classList.add("phase-dot--active");
      }
    });
  }

  private addNotification(n: NotificationData): void {
    const container = document.getElementById("notification-log")!;
    const emptyState = container.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    const el = document.createElement("div");
    el.style.cssText = "padding:3px 0;border-bottom:1px solid var(--border);font-size:11px;";
    el.innerHTML = `<span style="color:var(--text-muted);font-family:var(--font-mono);font-size:10px;">${new Date().toLocaleTimeString()}</span> <strong style="color:var(--text-primary);">${n.title ?? ""}</strong> ${n.body ?? ""}`;
    container.prepend(el);

    while (container.children.length > 50) {
      container.removeChild(container.lastChild!);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const app = new MaestroApp();
  app.start().catch((err) => console.error("Maestro start failed:", err));
});
