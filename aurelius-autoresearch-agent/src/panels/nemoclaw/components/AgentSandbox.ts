/**
 * AgentSandbox component.
 *
 * Renders active sandbox cards with resource usage bars, isolation mode
 * indicators, violation counts, uptime tracking, and a terminate button.
 * Supports in-place updates for resource bars without full re-render.
 */

import type { SandboxInfo } from "../app";
import { rpc } from "../app";

export class AgentSandbox {
  private container: HTMLElement;
  private badge: HTMLElement;
  private sandboxes = new Map<string, SandboxInfo>();
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement, badge: HTMLElement) {
    this.container = container;
    this.badge = badge;
    this.startUptimeRefresh();
  }

  addSandbox(info: SandboxInfo): void {
    this.sandboxes.set(info.id, info);
    this.render();
  }

  updateSandbox(info: SandboxInfo): void {
    if (this.sandboxes.has(info.id)) {
      this.sandboxes.set(info.id, info);
      this.updateCard(info);
    } else {
      this.addSandbox(info);
    }
  }

  removeSandbox(id: string): void {
    this.sandboxes.delete(id);
    this.render();
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  private render(): void {
    this.badge.textContent = String(this.sandboxes.size);

    if (this.sandboxes.size === 0) {
      this.container.innerHTML =
        '<div class="empty-state">No active sandboxes</div>';
      return;
    }

    this.container.innerHTML = "";

    // Sort by spawn time (newest first).
    const sorted = Array.from(this.sandboxes.values()).sort(
      (a, b) => b.spawnedAt - a.spawnedAt,
    );

    for (const info of sorted) {
      this.container.appendChild(this.createCard(info));
    }
  }

  private createCard(info: SandboxInfo): HTMLElement {
    const card = document.createElement("div");
    card.className = "sandbox-card";
    card.dataset.sandboxId = info.id;

    const statusClass =
      info.status === "running"
        ? "sandbox-card__status--running"
        : "sandbox-card__status--error";

    const memPercent =
      info.maxMemoryMb > 0
        ? Math.min(100, (info.memoryMb / info.maxMemoryMb) * 100)
        : 0;

    const uptime = formatUptime(info.uptimeMs);

    // Memory bar color based on usage.
    const memColor =
      memPercent > 90
        ? "var(--accent-red)"
        : memPercent > 70
          ? "var(--yellow)"
          : "var(--blue)";

    // CPU bar color.
    const cpuColor =
      info.cpuPercent > 90
        ? "var(--accent-red)"
        : info.cpuPercent > 70
          ? "var(--yellow)"
          : "var(--purple)";

    card.innerHTML = `
      <div class="sandbox-card__head">
        <div>
          <div class="sandbox-card__role">${escapeHtml(info.role)}</div>
          <div class="sandbox-card__id">${escapeHtml(info.id.substring(0, 12))}</div>
        </div>
        <span class="sandbox-card__status ${statusClass}">${info.status}</span>
      </div>
      <div class="resource-bar">
        <div class="resource-bar__label">
          <span>Memory</span>
          <span>${info.memoryMb.toFixed(0)} / ${info.maxMemoryMb} MB</span>
        </div>
        <div class="resource-bar__track">
          <div class="resource-bar__fill"
               style="width:${memPercent.toFixed(1)}%;background:${memColor}"
               data-bar="mem"></div>
        </div>
      </div>
      <div class="resource-bar">
        <div class="resource-bar__label">
          <span>CPU</span>
          <span>${info.cpuPercent.toFixed(1)}%</span>
        </div>
        <div class="resource-bar__track">
          <div class="resource-bar__fill"
               style="width:${Math.min(100, info.cpuPercent).toFixed(1)}%;background:${cpuColor}"
               data-bar="cpu"></div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:4px;">
        <span data-uptime="${info.spawnedAt}">Uptime: ${uptime}</span>
        <span style="font-family:var(--font-mono)">${(info as any).isolation_mode ?? "process"}</span>
      </div>
      <button class="btn-terminate" data-action="terminate" data-id="${escapeHtml(info.id)}">
        Terminate
      </button>
    `;

    // Bind terminate button.
    const btn = card.querySelector(
      '[data-action="terminate"]',
    ) as HTMLButtonElement;
    btn.addEventListener("click", () => this.handleTerminate(info.id, btn));

    return card;
  }

  /** Update an existing card's resource bars in-place (avoids full re-render). */
  private updateCard(info: SandboxInfo): void {
    const card = this.container.querySelector(
      `[data-sandbox-id="${info.id}"]`,
    ) as HTMLElement | null;

    if (!card) {
      this.render();
      return;
    }

    const memPercent =
      info.maxMemoryMb > 0
        ? Math.min(100, (info.memoryMb / info.maxMemoryMb) * 100)
        : 0;

    const memBar = card.querySelector(
      '[data-bar="mem"]',
    ) as HTMLElement | null;
    if (memBar) {
      memBar.style.width = `${memPercent.toFixed(1)}%`;
      memBar.style.background =
        memPercent > 90
          ? "var(--accent-red)"
          : memPercent > 70
            ? "var(--yellow)"
            : "var(--blue)";
    }

    const cpuBar = card.querySelector(
      '[data-bar="cpu"]',
    ) as HTMLElement | null;
    if (cpuBar) {
      cpuBar.style.width = `${Math.min(100, info.cpuPercent).toFixed(1)}%`;
      cpuBar.style.background =
        info.cpuPercent > 90
          ? "var(--accent-red)"
          : info.cpuPercent > 70
            ? "var(--yellow)"
            : "var(--purple)";
    }

    // Update memory label.
    const memLabels = card.querySelectorAll(".resource-bar__label span");
    if (memLabels.length >= 4) {
      memLabels[1].textContent = `${info.memoryMb.toFixed(0)} / ${info.maxMemoryMb} MB`;
      memLabels[3].textContent = `${info.cpuPercent.toFixed(1)}%`;
    }

    // Update status indicator.
    const statusEl = card.querySelector(
      ".sandbox-card__status",
    ) as HTMLElement | null;
    if (statusEl) {
      statusEl.textContent = info.status;
      statusEl.className = `sandbox-card__status ${
        info.status === "running"
          ? "sandbox-card__status--running"
          : "sandbox-card__status--error"
      }`;
    }
  }

  private async handleTerminate(
    id: string,
    btn: HTMLButtonElement,
  ): Promise<void> {
    btn.disabled = true;
    btn.textContent = "Terminating...";

    try {
      await rpc("sandboxes.terminate", { id });
      this.removeSandbox(id);
    } catch (err) {
      console.error("Terminate failed:", err);
      btn.textContent = "Terminate (failed)";
      btn.disabled = false;
    }
  }

  /** Periodically refresh uptime displays. */
  private startUptimeRefresh(): void {
    this.uptimeTimer = setInterval(() => {
      const now = Date.now();
      const uptimeEls = this.container.querySelectorAll("[data-uptime]");
      for (const el of uptimeEls) {
        const startedAt = parseInt(
          (el as HTMLElement).dataset.uptime ?? "0",
          10,
        );
        if (startedAt > 0) {
          (el as HTMLElement).textContent = `Uptime: ${formatUptime(now - startedAt)}`;
        }
      }
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
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
