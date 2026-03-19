/**
 * PrivacyRouter component.
 *
 * Displays routing decisions log with color-coded route tags and a
 * pie chart showing the distribution of routing paths.
 */

import type { RoutingDecision, RoutingStats } from "../app";

const PATH_COLORS: Record<string, string> = {
  local: "#38a169",
  federated: "#4299e1",
  cloud_sanitized: "#d69e2e",
  blocked: "#e53e3e",
};

const PATH_LABELS: Record<string, string> = {
  local: "Local",
  federated: "Federated",
  cloud_sanitized: "Cloud (sanitized)",
  blocked: "Blocked",
};

const MAX_DECISIONS = 200;

export class PrivacyRouterView {
  private statsContainer: HTMLElement;
  private pieSvg: SVGSVGElement;
  private decisionsList: HTMLElement;
  private chipEl: HTMLElement;

  private stats: RoutingStats = {
    total: 0,
    byPath: {},
    blocked: 0,
    avgLatencyMs: 0,
  };

  private decisions: RoutingDecision[] = [];

  constructor(
    statsContainer: HTMLElement,
    pieSvg: SVGSVGElement,
    decisionsList: HTMLElement,
    chipEl: HTMLElement,
  ) {
    this.statsContainer = statsContainer;
    this.pieSvg = pieSvg;
    this.decisionsList = decisionsList;
    this.chipEl = chipEl;
  }

  updateStats(stats: RoutingStats): void {
    this.stats = stats;
    this.renderStats();
    this.renderPie();
    this.renderChip();
  }

  addDecision(decision: RoutingDecision): void {
    this.decisions.unshift(decision);
    if (this.decisions.length > MAX_DECISIONS) {
      this.decisions.length = MAX_DECISIONS;
    }

    // Incrementally update stats
    this.stats.total++;
    this.stats.byPath[decision.path] =
      (this.stats.byPath[decision.path] ?? 0) + 1;
    if (decision.path === "blocked") this.stats.blocked++;

    this.prependDecisionEntry(decision);
    this.renderStats();
    this.renderPie();
    this.renderChip();
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private renderStats(): void {
    const items = [
      { label: "Total", value: this.stats.total },
      { label: "Blocked", value: this.stats.blocked },
      { label: "Avg Latency", value: `${this.stats.avgLatencyMs.toFixed(0)}ms` },
    ];

    this.statsContainer.innerHTML = items
      .map(
        (item) => `
          <div class="router-stats__item">
            <div class="router-stats__value">${item.value}</div>
            <div class="router-stats__label">${item.label}</div>
          </div>
        `,
      )
      .join("");
  }

  private renderPie(): void {
    const paths = Object.entries(this.stats.byPath).filter(
      ([, count]) => count > 0,
    );

    if (paths.length === 0 || this.stats.total === 0) {
      this.pieSvg.innerHTML = `
        <circle cx="50" cy="50" r="40" fill="none" stroke="#2a2f3d" stroke-width="8" />
        <text x="50" y="53" text-anchor="middle" fill="#5c6070" font-size="8">No data</text>
      `;
      return;
    }

    let svg = "";
    let cumulative = 0;
    const cx = 50;
    const cy = 50;
    const r = 40;

    for (const [path, count] of paths) {
      const fraction = count / this.stats.total;
      const startAngle = cumulative * 2 * Math.PI - Math.PI / 2;
      cumulative += fraction;
      const endAngle = cumulative * 2 * Math.PI - Math.PI / 2;

      if (fraction >= 0.9999) {
        // Full circle
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PATH_COLORS[path] ?? "#555"}" />`;
      } else {
        const x1 = cx + r * Math.cos(startAngle);
        const y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const largeArc = fraction > 0.5 ? 1 : 0;

        svg += `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${PATH_COLORS[path] ?? "#555"}" />`;
      }
    }

    // Legend
    let legendY = 6;
    for (const [path] of paths) {
      svg += `<rect x="2" y="${legendY}" width="6" height="6" rx="1" fill="${PATH_COLORS[path] ?? "#555"}" />`;
      svg += `<text x="11" y="${legendY + 5}" fill="#8b8f9a" font-size="5">${PATH_LABELS[path] ?? path}</text>`;
      legendY += 9;
    }

    this.pieSvg.innerHTML = svg;
  }

  private renderChip(): void {
    this.chipEl.textContent = `routes: ${this.stats.total} | blocked: ${this.stats.blocked}`;
  }

  private prependDecisionEntry(decision: RoutingDecision): void {
    // Remove empty state if present
    const empty = this.decisionsList.querySelector(".empty-state");
    if (empty) empty.remove();

    const li = document.createElement("li");
    li.className = "router-decisions__entry";

    const time = formatTime(decision.timestamp);
    const routeClass = `route--${decision.path}`;

    li.innerHTML = `
      <span class="security-log__time">${time}</span>
      <span class="route-tag ${routeClass}">${decision.path}</span>
      <span>${escapeHtml(decision.model)} via ${escapeHtml(decision.sandboxId)}</span>
    `;

    this.decisionsList.insertBefore(li, this.decisionsList.firstChild);

    // Cap DOM entries
    while (this.decisionsList.children.length > MAX_DECISIONS) {
      this.decisionsList.lastChild?.remove();
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
