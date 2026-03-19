/**
 * ModelStatus component.
 *
 * Displays Nemotron model status, VRAM usage, inference metrics, and GPU
 * health in the top bar. Shows loaded model details, fallback chain status,
 * and temperature warnings.
 */

import type { ModelInfo, GpuInfo } from "../app";

export class ModelStatus {
  private modelDot: HTMLElement;
  private modelText: HTMLElement;
  private gpuDot: HTMLElement;
  private gpuText: HTMLElement;
  private lastModel: ModelInfo | null = null;
  private lastGpu: GpuInfo | null = null;
  /** Tooltip element for detailed hover info. */
  private tooltip: HTMLElement | null = null;

  constructor(
    modelDot: HTMLElement,
    modelText: HTMLElement,
    gpuDot: HTMLElement,
    gpuText: HTMLElement,
  ) {
    this.modelDot = modelDot;
    this.modelText = modelText;
    this.gpuDot = gpuDot;
    this.gpuText = gpuText;

    this.createTooltips();
  }

  updateModel(info: ModelInfo): void {
    this.lastModel = info;

    // Status dot color.
    this.modelDot.className = "status-dot";
    switch (info.status) {
      case "ready":
        this.modelDot.classList.add("status-dot--green");
        break;
      case "loading":
        this.modelDot.classList.add("status-dot--yellow");
        break;
      case "error":
      case "offline":
        this.modelDot.classList.add("status-dot--red");
        break;
    }

    // Add pulse animation for loading state.
    if (info.status === "loading") {
      this.modelDot.style.animation = "pulse 1.5s infinite";
    } else {
      this.modelDot.style.animation = "";
    }

    // Text with VRAM and inference metrics.
    const parts: string[] = [`Model: ${info.status}`];

    if (info.vramTotalMb > 0) {
      const usedPct = ((info.vramUsedMb / info.vramTotalMb) * 100).toFixed(0);
      parts.push(
        `VRAM: ${formatMb(info.vramUsedMb)}/${formatMb(info.vramTotalMb)} (${usedPct}%)`,
      );
    }

    if (info.inferenceCount > 0) {
      parts.push(`${info.inferenceCount} inferences`);
      parts.push(`${info.avgLatencyMs.toFixed(0)}ms avg`);
    }

    this.modelText.textContent = parts.join(" | ");

    // Update tooltip.
    this.updateModelTooltip(info);
  }

  updateGpu(info: GpuInfo): void {
    this.lastGpu = info;

    // Status dot.
    this.gpuDot.className = "status-dot";
    switch (info.status) {
      case "ok":
        this.gpuDot.classList.add("status-dot--green");
        break;
      case "warn":
        this.gpuDot.classList.add("status-dot--yellow");
        break;
      case "error":
        this.gpuDot.classList.add("status-dot--red");
        break;
    }

    // Build GPU status text.
    const parts: string[] = [];

    if (info.name && info.name !== "No GPU") {
      // Abbreviate GPU name.
      const shortName = info.name
        .replace("NVIDIA ", "")
        .replace("GeForce ", "");
      parts.push(`GPU: ${shortName}`);
    } else {
      parts.push("GPU: none");
    }

    const util = `${info.utilizationPercent.toFixed(0)}%`;
    parts.push(util);

    if (info.temperatureC > 0) {
      const tempColor =
        info.temperatureC > 85
          ? "color:var(--accent-red)"
          : info.temperatureC > 75
            ? "color:var(--yellow)"
            : "";
      parts.push(`${info.temperatureC}C`);

      // Temperature warning in the dot.
      if (info.temperatureC > 85) {
        this.gpuDot.classList.remove(
          "status-dot--green",
          "status-dot--yellow",
        );
        this.gpuDot.classList.add("status-dot--red");
        this.gpuDot.title = `GPU temperature critical: ${info.temperatureC}C`;
      }
    }

    const vram = `${formatMb(info.vramUsedMb)}/${formatMb(info.vramTotalMb)}`;
    parts.push(vram);

    this.gpuText.textContent = parts.join(" | ");

    // Update tooltip.
    this.updateGpuTooltip(info);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private createTooltips(): void {
    // Add hover tooltips for detailed info.
    const modelParent = this.modelDot.parentElement;
    if (modelParent) {
      modelParent.style.position = "relative";
      modelParent.style.cursor = "help";

      const tip = document.createElement("div");
      tip.className = "status-tooltip";
      tip.style.cssText = `
        display:none;position:absolute;top:100%;left:0;z-index:100;
        background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);
        padding:8px 10px;min-width:200px;font-size:10px;color:var(--text-secondary);
        box-shadow:var(--shadow);white-space:nowrap;margin-top:4px;
      `;
      modelParent.appendChild(tip);
      this.tooltip = tip;

      modelParent.addEventListener("mouseenter", () => {
        tip.style.display = "block";
      });
      modelParent.addEventListener("mouseleave", () => {
        tip.style.display = "none";
      });
    }
  }

  private updateModelTooltip(info: ModelInfo): void {
    if (!this.tooltip) return;

    const lines: string[] = [
      `<strong>Model Status</strong>`,
      `ID: ${info.id ?? "primary"}`,
      `Status: ${info.status}`,
    ];

    if (info.vramTotalMb > 0) {
      const usedPct = ((info.vramUsedMb / info.vramTotalMb) * 100).toFixed(1);
      lines.push(
        `VRAM: ${formatMb(info.vramUsedMb)} / ${formatMb(info.vramTotalMb)} (${usedPct}%)`,
      );

      // VRAM usage bar.
      const pct = Math.min(100, (info.vramUsedMb / info.vramTotalMb) * 100);
      const barColor =
        pct > 90
          ? "var(--accent-red)"
          : pct > 70
            ? "var(--yellow)"
            : "var(--blue)";
      lines.push(
        `<div style="height:4px;background:var(--bg-input);border-radius:2px;margin:2px 0;">` +
          `<div style="height:100%;width:${pct.toFixed(1)}%;background:${barColor};border-radius:2px;"></div>` +
          `</div>`,
      );
    }

    if (info.inferenceCount > 0) {
      lines.push(`Inferences: ${info.inferenceCount}`);
      lines.push(`Avg latency: ${info.avgLatencyMs.toFixed(0)}ms`);
    }

    this.tooltip.innerHTML = lines.join("<br>");
  }

  private updateGpuTooltip(info: GpuInfo): void {
    // Find or create GPU tooltip.
    const gpuParent = this.gpuDot.parentElement;
    if (!gpuParent) return;

    let gpuTip = gpuParent.querySelector(
      ".status-tooltip",
    ) as HTMLElement | null;
    if (!gpuTip) {
      gpuParent.style.position = "relative";
      gpuParent.style.cursor = "help";

      gpuTip = document.createElement("div");
      gpuTip.className = "status-tooltip";
      gpuTip.style.cssText = `
        display:none;position:absolute;top:100%;left:0;z-index:100;
        background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);
        padding:8px 10px;min-width:200px;font-size:10px;color:var(--text-secondary);
        box-shadow:var(--shadow);white-space:nowrap;margin-top:4px;
      `;
      gpuParent.appendChild(gpuTip);

      gpuParent.addEventListener("mouseenter", () => {
        gpuTip!.style.display = "block";
      });
      gpuParent.addEventListener("mouseleave", () => {
        gpuTip!.style.display = "none";
      });
    }

    const lines: string[] = [
      `<strong>GPU Status</strong>`,
      `Name: ${info.name}`,
      `Utilization: ${info.utilizationPercent.toFixed(0)}%`,
    ];

    if (info.temperatureC > 0) {
      const tempColor =
        info.temperatureC > 85
          ? "var(--accent-red)"
          : info.temperatureC > 75
            ? "var(--yellow)"
            : "var(--green)";
      lines.push(
        `Temperature: <span style="color:${tempColor}">${info.temperatureC}C</span>`,
      );
    }

    lines.push(
      `VRAM: ${formatMb(info.vramUsedMb)} / ${formatMb(info.vramTotalMb)}`,
    );

    // VRAM bar.
    if (info.vramTotalMb > 0) {
      const pct = Math.min(
        100,
        (info.vramUsedMb / info.vramTotalMb) * 100,
      );
      const barColor =
        pct > 90
          ? "var(--accent-red)"
          : pct > 70
            ? "var(--yellow)"
            : "var(--blue)";
      lines.push(
        `<div style="height:4px;background:var(--bg-input);border-radius:2px;margin:2px 0;">` +
          `<div style="height:100%;width:${pct.toFixed(1)}%;background:${barColor};border-radius:2px;"></div>` +
          `</div>`,
      );
    }

    // Utilization bar.
    const utilPct = Math.min(100, info.utilizationPercent);
    const utilColor =
      utilPct > 90
        ? "var(--accent-red)"
        : utilPct > 70
          ? "var(--yellow)"
          : "var(--purple)";
    lines.push(
      `<div style="height:4px;background:var(--bg-input);border-radius:2px;margin:2px 0;">` +
        `<div style="height:100%;width:${utilPct.toFixed(1)}%;background:${utilColor};border-radius:2px;"></div>` +
        `</div>`,
    );

    gpuTip.innerHTML = lines.join("<br>");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${mb.toFixed(0)}M`;
}
