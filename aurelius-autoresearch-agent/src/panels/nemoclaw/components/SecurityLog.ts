/**
 * SecurityLog component.
 *
 * Real-time scrolling security events with color-coded severity:
 *   green  = info (granted)
 *   yellow = warn (denied / policy warning)
 *   red    = error / critical (violation / breach)
 *
 * Supports filtering by severity level, text search, and auto-scroll
 * with manual override when the user scrolls up.
 */

import type { SecurityEvent } from "../app";

const MAX_ENTRIES = 500;

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  warn: 1,
  warning: 1,
  error: 2,
  critical: 3,
  violation: 3,
};

export class SecurityLog {
  private list: HTMLElement;
  private scrollContainer: HTMLElement;
  private badge: HTMLElement;
  private count = 0;
  private autoScroll = true;
  private activeFilter: string | null = null;
  private searchQuery = "";
  private events: SecurityEvent[] = [];

  constructor(
    list: HTMLElement,
    scrollContainer: HTMLElement,
    badge: HTMLElement,
  ) {
    this.list = list;
    this.scrollContainer = scrollContainer;
    this.badge = badge;

    this.bindScroll();
    this.injectFilterControls();
  }

  addEvent(event: SecurityEvent): void {
    // Remove empty state on first event
    if (this.count === 0) {
      const empty = this.list.querySelector(".empty-state");
      if (empty) empty.remove();
    }

    this.count++;
    this.events.push(event);
    if (this.events.length > MAX_ENTRIES) {
      this.events.shift();
    }

    this.badge.textContent = String(this.count);
    this.updateBadgeSeverity(event);

    // Check if this event passes the current filter.
    if (!this.passesFilter(event)) return;

    this.appendEventDOM(event);

    // Cap DOM entries
    while (this.list.children.length > MAX_ENTRIES) {
      this.list.firstChild?.remove();
    }

    // Auto-scroll to bottom if user hasn't scrolled up
    if (this.autoScroll) {
      this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
    }
  }

  /** Set severity filter. Pass null to show all. */
  setFilter(severity: string | null): void {
    this.activeFilter = severity;
    this.rerender();
  }

  /** Set text search query. */
  setSearch(query: string): void {
    this.searchQuery = query.toLowerCase();
    this.rerender();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private appendEventDOM(event: SecurityEvent): void {
    const li = document.createElement("li");
    li.className = "security-log__entry";
    li.dataset.eventId = event.id;

    const severityLabel = event.severity === "warning" ? "warn" : event.severity;
    const severityClass = `severity--${severityLabel}`;
    const time = formatTime(event.timestamp);

    // Build the source tag if present.
    const sourceTag = event.source
      ? `<span style="font-family:var(--font-mono);font-size:9px;color:var(--text-muted);margin-left:4px">[${escapeHtml(event.source)}]</span>`
      : "";

    li.innerHTML = `
      <span class="security-log__severity ${severityClass}">${severityLabel}</span>
      <span class="security-log__time">${time}</span>
      <span class="security-log__msg">${escapeHtml(event.message)}${sourceTag}</span>
    `;

    // For critical events, add background highlight.
    if (event.severity === "critical" || event.severity === "violation") {
      li.style.background = "rgba(229, 62, 62, 0.08)";
      li.style.borderLeft = "3px solid var(--accent-red)";
      li.style.paddingLeft = "8px";
    }

    // Click to expand details.
    if (event.context && Object.keys(event.context).length > 0) {
      li.style.cursor = "pointer";
      li.addEventListener("click", () => {
        const existing = li.querySelector(".security-log__details");
        if (existing) {
          existing.remove();
          return;
        }
        const details = document.createElement("div");
        details.className = "security-log__details";
        details.style.cssText =
          "font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:4px;white-space:pre-wrap;word-break:break-all;padding:4px;background:var(--bg-input);border-radius:3px;";
        details.textContent = JSON.stringify(event.context, null, 2);
        li.appendChild(details);
      });
    }

    this.list.appendChild(li);
  }

  private passesFilter(event: SecurityEvent): boolean {
    if (this.activeFilter) {
      const normalized =
        event.severity === "warning" ? "warn" : event.severity;
      if (normalized !== this.activeFilter) return false;
    }
    if (this.searchQuery) {
      if (!event.message.toLowerCase().includes(this.searchQuery)) {
        return false;
      }
    }
    return true;
  }

  private rerender(): void {
    this.list.innerHTML = "";
    const filtered = this.events.filter((e) => this.passesFilter(e));
    if (filtered.length === 0) {
      this.list.innerHTML =
        '<li class="empty-state">No events match the current filter</li>';
      return;
    }
    for (const event of filtered) {
      this.appendEventDOM(event);
    }
    if (this.autoScroll) {
      this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
    }
  }

  private updateBadgeSeverity(event: SecurityEvent): void {
    // Make badge red if critical events exist.
    if (
      event.severity === "critical" ||
      event.severity === "violation" ||
      event.severity === "error"
    ) {
      this.badge.style.background = "var(--accent-red)";
      this.badge.style.color = "#fff";
    }
  }

  private bindScroll(): void {
    this.scrollContainer.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.scrollContainer;
      // Consider "at bottom" if within 40px of the end
      this.autoScroll = scrollHeight - scrollTop - clientHeight < 40;
    });
  }

  private injectFilterControls(): void {
    // Find the panel header for the security log.
    const header = this.scrollContainer.parentElement?.querySelector(
      ".panel__header",
    );
    if (!header) return;

    const filterContainer = document.createElement("div");
    filterContainer.style.cssText =
      "display:flex;gap:4px;align-items:center;margin-left:8px;";

    const severities = ["all", "info", "warn", "error", "critical"];
    for (const sev of severities) {
      const btn = document.createElement("button");
      btn.textContent = sev;
      btn.style.cssText =
        "font-size:9px;padding:1px 5px;border:1px solid var(--border);border-radius:2px;background:transparent;color:var(--text-muted);cursor:pointer;";
      btn.addEventListener("click", () => {
        this.setFilter(sev === "all" ? null : sev);
        // Update active state.
        filterContainer
          .querySelectorAll("button")
          .forEach(
            (b) =>
              ((b as HTMLElement).style.background = "transparent"),
          );
        btn.style.background = "var(--bg-input)";
      });
      filterContainer.appendChild(btn);
    }

    header.appendChild(filterContainer);
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
