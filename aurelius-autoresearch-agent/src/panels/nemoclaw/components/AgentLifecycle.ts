/**
 * AgentLifecycle component.
 *
 * Renders an agent spawn/run/terminate timeline with colored dots
 * indicating event type and human-readable timestamps.
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

const MAX_EVENTS = 300;

export class AgentLifecycle {
  private container: HTMLElement;
  private events: LifecycleEvent[] = [];
  private initialized = false;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  addEvent(event: LifecycleEvent): void {
    // Clear placeholder on first event
    if (!this.initialized) {
      this.container.innerHTML = "";
      this.initialized = true;
    }

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
      // Remove oldest DOM node
      const first = this.container.querySelector(".timeline__event");
      if (first) first.remove();
    }

    this.appendEvent(event);
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private appendEvent(event: LifecycleEvent): void {
    const el = document.createElement("div");
    el.className = "timeline__event";

    const dotClass = DOT_CLASSES[event.type] ?? "";
    const label = EVENT_LABELS[event.type] ?? event.type;
    const time = formatTime(event.timestamp);
    const detail = event.detail ? ` -- ${escapeHtml(event.detail)}` : "";

    el.innerHTML = `
      <div class="timeline__dot ${dotClass}"></div>
      <div class="timeline__time">${time}</div>
      <div class="timeline__text">
        <strong>${label}</strong>
        <span style="color:var(--text-secondary)">${escapeHtml(event.role)}</span>
        <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)">${escapeHtml(event.sandboxId)}</span>
        ${detail}
      </div>
    `;

    this.container.appendChild(el);

    // Scroll timeline to bottom
    const parent = this.container.parentElement;
    if (parent) {
      parent.scrollTop = parent.scrollHeight;
    }
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

function escapeHtml(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}
