/**
 * AgentLifecycle component.
 *
 * Renders an agent spawn/run/terminate timeline with colored dots
 * indicating event type, human-readable timestamps, and uptime tracking.
 * Shows active sandbox count and allows filtering by event type.
 */

import type { LifecycleEvent } from "../app";

const DOT_CLASSES: Record<string, string> = {
  spawn: "timeline__dot--spawn",
  exec: "timeline__dot--exec",
  terminate: "timeline__dot--terminate",
  error: "timeline__dot--terminate",
};

const EVENT_LABELS: Record<string, string> = {
  spawn: "Spawned",
  exec: "Executing",
  terminate: "Terminated",
  error: "Error",
};

const EVENT_ICONS: Record<string, string> = {
  spawn: "+",
  exec: ">",
  terminate: "x",
  error: "!",
};

const MAX_EVENTS = 300;

export class AgentLifecycle {
  private container: HTMLElement;
  private events: LifecycleEvent[] = [];
  private initialized = false;
  /** Track active sandboxes by ID. */
  private activeSandboxes: Map<string, { role: string; startedAt: number }> =
    new Map();
  /** Uptime refresh timer. */
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.startUptimeRefresh();
  }

  addEvent(event: LifecycleEvent): void {
    // Clear placeholder on first event.
    if (!this.initialized) {
      this.container.innerHTML = "";
      this.initialized = true;
    }

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
      const first = this.container.querySelector(".timeline__event");
      if (first) first.remove();
    }

    // Track active sandboxes.
    if (event.type === "spawn") {
      this.activeSandboxes.set(event.sandboxId, {
        role: event.role,
        startedAt: event.timestamp,
      });
    } else if (event.type === "terminate" || event.type === "error") {
      this.activeSandboxes.delete(event.sandboxId);
    }

    this.appendEvent(event);
    this.updateSummary();
  }

  /**
   * Get list of currently active sandbox IDs.
   */
  getActiveSandboxIds(): string[] {
    return Array.from(this.activeSandboxes.keys());
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private appendEvent(event: LifecycleEvent): void {
    const el = document.createElement("div");
    el.className = "timeline__event";
    el.dataset.sandboxId = event.sandboxId;
    el.dataset.eventType = event.type;

    const dotClass = DOT_CLASSES[event.type] ?? "";
    const label = EVENT_LABELS[event.type] ?? event.type;
    const icon = EVENT_ICONS[event.type] ?? "-";
    const time = formatTime(event.timestamp);
    const detail = event.detail ? ` -- ${escapeHtml(event.detail)}` : "";

    el.innerHTML = `
      <div class="timeline__dot ${dotClass}" title="${event.type}"></div>
      <div class="timeline__time">${time}</div>
      <div class="timeline__text">
        <strong>${label}</strong>
        <span style="color:var(--text-secondary)">${escapeHtml(event.role)}</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${escapeHtml(event.sandboxId.substring(0, 8))}</span>
        ${detail}
      </div>
    `;

    // Error events get a red background.
    if (event.type === "error") {
      el.style.background = "rgba(229, 62, 62, 0.06)";
      el.style.borderRadius = "3px";
      el.style.padding = "6px 0 12px 20px";
    }

    this.container.appendChild(el);

    // Scroll timeline to bottom.
    const parent = this.container.parentElement;
    if (parent) {
      parent.scrollTop = parent.scrollHeight;
    }
  }

  private updateSummary(): void {
    // Find or create the summary bar above the timeline.
    let summary = this.container.parentElement?.querySelector(
      ".lifecycle-summary",
    ) as HTMLElement | null;

    if (!summary && this.container.parentElement) {
      summary = document.createElement("div");
      summary.className = "lifecycle-summary";
      summary.style.cssText =
        "display:flex;gap:12px;padding:6px 0;margin-bottom:8px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border);";
      this.container.parentElement.insertBefore(summary, this.container);
    }

    if (summary) {
      const activeCount = this.activeSandboxes.size;
      const totalSpawns = this.events.filter((e) => e.type === "spawn").length;
      const totalTerms = this.events.filter(
        (e) => e.type === "terminate",
      ).length;
      const totalErrors = this.events.filter((e) => e.type === "error").length;

      summary.innerHTML = `
        <span>Active: <strong style="color:var(--green)">${activeCount}</strong></span>
        <span>Spawned: <strong>${totalSpawns}</strong></span>
        <span>Terminated: <strong>${totalTerms}</strong></span>
        ${totalErrors > 0 ? `<span>Errors: <strong style="color:var(--accent-red)">${totalErrors}</strong></span>` : ""}
      `;
    }
  }

  private startUptimeRefresh(): void {
    // Refresh uptime displays every 10 seconds.
    this.uptimeTimer = setInterval(() => {
      const now = Date.now();
      for (const [sandboxId, info] of this.activeSandboxes) {
        const uptimeEl = this.container.querySelector(
          `[data-sandbox-id="${sandboxId}"] .timeline__uptime`,
        );
        if (uptimeEl) {
          (uptimeEl as HTMLElement).textContent = formatUptime(
            now - info.startedAt,
          );
        }
      }
    }, 10_000);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function escapeHtml(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}
