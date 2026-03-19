/**
 * PrivacyRouter component.
 *
 * Displays routing decisions log with color-coded route tags, classification
 * breakdown, CUI/PII detection indicators, and a pie chart showing the
 * distribution of routing paths. Supports filtering by route type.
 */

import type { RoutingDecision, RoutingStats } from "../app";

const PATH_COLORS: Record<string, string> = {
  local: "#38a169",
  federated: "#4299e1",
  cloud_sanitized: "#d69e2e",
  blocked: "#e53e3e",
  cloud: "#d69e2e",
};

const PATH_LABELS: Record<string, string> = {
  local: "Local",
  federated: "Federated",
  cloud_sanitized: "Cloud (sanitized)",
  blocked: "Blocked",
  cloud: "Cloud",
};

const CLASSIFICATION_COLORS: Record<string, string> = {
  public: "#38a169",
  internal: "#4299e1",
  sensitive: "#d69e2e",
  cui: "#e53e3e",
  classified: "#9b2c2c",
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
  private activeFilter: string | null = null;

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

    this.injectFilterControls();
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

    // Incrementally update stats.
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
    const localCount = this.stats.byPath["local"] ?? 0;
    const cloudCount =
      (this.stats.byPath["cloud_sanitized"] ?? 0) +
      (this.stats.byPath["cloud"] ?? 0);
    const blockedCount = this.stats.blocked ?? 0;

    const items = [
      { label: "Total", value: String(this.stats.total), color: "" },
      { label: "Local", value: String(localCount), color: "var(--green)" },
      { label: "Cloud", value: String(cloudCount), color: "var(--yellow)" },
      {
        label: "Blocked",
        value: String(blockedCount),
        color: blockedCount > 0 ? "var(--accent-red)" : "",
      },
      {
        label: "Avg Latency",
        value: `${(this.stats.avgLatencyMs ?? 0).toFixed(0)}ms`,
        color: "",
      },
    ];

    this.statsContainer.innerHTML = items
      .map(
        (item) => `
          <div class="router-stats__item">
            <div class="router-stats__value" style="${item.color ? `color:${item.color}` : ""}">${item.value}</div>
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
        <text x="50" y="50" text-anchor="middle" dominant-baseline="middle" fill="#5c6070" font-size="7">No data</text>
      `;
      return;
    }

    let svg = "";
    let cumulative = 0;
    const cx = 50;
    const cy = 50;
    const r = 36;

    for (const [path, count] of paths) {
      const fraction = count / this.stats.total;
      const startAngle = cumulative * 2 * Math.PI - Math.PI / 2;
      cumulative += fraction;
      const endAngle = cumulative * 2 * Math.PI - Math.PI / 2;
      const color = PATH_COLORS[path] ?? "#555";

      if (fraction >= 0.9999) {
        svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`;
      } else {
        const x1 = cx + r * Math.cos(startAngle);
        const y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const largeArc = fraction > 0.5 ? 1 : 0;

        svg += `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}" />`;
      }
    }

    // Center text showing total.
    svg += `<circle cx="${cx}" cy="${cy}" r="20" fill="var(--bg-primary)" />`;
    svg += `<text x="${cx}" y="${cy - 3}" text-anchor="middle" fill="var(--text-primary)" font-size="10" font-weight="700">${this.stats.total}</text>`;
    svg += `<text x="${cx}" y="${cy + 7}" text-anchor="middle" fill="var(--text-muted)" font-size="5">routes</text>`;

    // Legend.
    let legendY = 6;
    for (const [path] of paths) {
      const color = PATH_COLORS[path] ?? "#555";
      const label = PATH_LABELS[path] ?? path;
      const count = this.stats.byPath[path] ?? 0;
      const pct = ((count / this.stats.total) * 100).toFixed(0);
      svg += `<rect x="2" y="${legendY}" width="6" height="6" rx="1" fill="${color}" />`;
      svg += `<text x="11" y="${legendY + 5}" fill="#8b8f9a" font-size="4.5">${label} (${pct}%)</text>`;
      legendY += 9;
    }

    this.pieSvg.innerHTML = svg;
  }

  private renderChip(): void {
    const localCount = this.stats.byPath["local"] ?? 0;
    const blocked = this.stats.blocked ?? 0;
    this.chipEl.textContent = `routes: ${this.stats.total} | local: ${localCount} | blocked: ${blocked}`;
  }

  private prependDecisionEntry(decision: RoutingDecision): void {
    // Check filter.
    if (this.activeFilter && decision.path !== this.activeFilter) return;

    // Remove empty state if present.
    const empty = this.decisionsList.querySelector(".empty-state");
    if (empty) empty.remove();

    const li = document.createElement("li");
    li.className = "router-decisions__entry";

    const time = formatTime(decision.timestamp);
    const routeClass = `route--${decision.path}`;

    // Classification indicator.
    const classColor =
      CLASSIFICATION_COLORS[decision.classification ?? "public"] ?? "#555";
    const classTag = decision.classification
      ? `<span style="font-family:var(--font-mono);font-size:8px;padding:0 3px;border-radius:2px;background:${classColor}22;color:${classColor}">${decision.classification}</span>`
      : "";

    // PII/CUI indicators.
    let indicators = "";
    if (decision.transformations && decision.transformations.length > 0) {
      const piiCount = decision.transformations.length;
      indicators += `<span style="font-size:8px;color:var(--yellow)" title="PII types: ${decision.transformations.join(", ")}">PII:${piiCount}</span>`;
    }

    li.innerHTML = `
      <span class="security-log__time">${time}</span>
      <span class="route-tag ${routeClass}">${decision.path}</span>
      ${classTag}
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(decision.model)}</span>
      ${indicators}
    `;

    this.decisionsList.insertBefore(li, this.decisionsList.firstChild);

    // Cap DOM entries.
    while (this.decisionsList.children.length > MAX_DECISIONS) {
      this.decisionsList.lastChild?.remove();
    }
  }

  private injectFilterControls(): void {
    // Find the panel header for the privacy router.
    const panel = this.statsContainer.closest(".panel");
    const header = panel?.querySelector(".panel__header");
    if (!header) return;

    const filterContainer = document.createElement("div");
    filterContainer.style.cssText =
      "display:flex;gap:3px;align-items:center;";

    const routes = ["all", "local", "cloud_sanitized", "blocked"];
    for (const route of routes) {
      const btn = document.createElement("button");
      btn.textContent = route === "all" ? "all" : (PATH_LABELS[route] ?? route);
      btn.style.cssText = `
        font-size:8px;padding:1px 4px;border:1px solid var(--border);border-radius:2px;
        background:transparent;color:var(--text-muted);cursor:pointer;
      `;
      if (route !== "all") {
        btn.style.borderColor = PATH_COLORS[route] ?? "var(--border)";
      }
      btn.addEventListener("click", () => {
        this.activeFilter = route === "all" ? null : route;
        this.rerenderDecisions();
        filterContainer
          .querySelectorAll("button")
          .forEach(
            (b) => ((b as HTMLElement).style.background = "transparent"),
          );
        btn.style.background = "var(--bg-input)";
      });
      filterContainer.appendChild(btn);
    }

    header.appendChild(filterContainer);
  }

  private rerenderDecisions(): void {
    this.decisionsList.innerHTML = "";
    const filtered = this.activeFilter
      ? this.decisions.filter((d) => d.path === this.activeFilter)
      : this.decisions;

    if (filtered.length === 0) {
      this.decisionsList.innerHTML =
        '<li class="empty-state">No routing decisions match filter</li>';
      return;
    }

    // Re-add in reverse order (newest at top).
    for (const decision of filtered) {
      this.prependDecisionEntry(decision);
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
