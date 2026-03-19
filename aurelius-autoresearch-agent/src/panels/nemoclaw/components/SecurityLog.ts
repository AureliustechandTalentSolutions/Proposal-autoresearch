/**
 * SecurityLog component.
 *
 * Real-time scrolling security events with color-coded severity:
 *   green  = info (granted)
 *   yellow = warn (denied)
 *   red    = error / critical (violation)
 */

import type { SecurityEvent } from "../app";

const MAX_ENTRIES = 500;

export class SecurityLog {
  private list: HTMLElement;
  private scrollContainer: HTMLElement;
  private badge: HTMLElement;
  private count = 0;
  private autoScroll = true;

  constructor(
    list: HTMLElement,
    scrollContainer: HTMLElement,
    badge: HTMLElement,
  ) {
    this.list = list;
    this.scrollContainer = scrollContainer;
    this.badge = badge;

    this.bindScroll();
  }

  addEvent(event: SecurityEvent): void {
    // Remove empty state on first event
    if (this.count === 0) {
      const empty = this.list.querySelector(".empty-state");
      if (empty) empty.remove();
    }

    this.count++;
    this.badge.textContent = String(this.count);

    const li = document.createElement("li");
    li.className = "security-log__entry";

    const severityClass = `severity--${event.severity}`;
    const time = formatTime(event.timestamp);

    li.innerHTML = `
      <span class="security-log__severity ${severityClass}">${event.severity}</span>
      <span class="security-log__time">${time}</span>
      <span class="security-log__msg">${escapeHtml(event.message)}</span>
    `;

    // For critical events, add a subtle pulse animation
    if (event.severity === "critical") {
      li.style.animation = "none";
      li.style.background = "rgba(229, 62, 62, 0.08)";
    }

    this.list.appendChild(li);

    // Cap DOM entries
    while (this.list.children.length > MAX_ENTRIES) {
      this.list.firstChild?.remove();
    }

    // Auto-scroll to bottom if user hasn't scrolled up
    if (this.autoScroll) {
      this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private bindScroll(): void {
    this.scrollContainer.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.scrollContainer;
      // Consider "at bottom" if within 40px of the end
      this.autoScroll = scrollHeight - scrollTop - clientHeight < 40;
    });
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
