/**
 * ModelStatus component.
 *
 * Displays Nemotron model status and VRAM usage in the top bar.
 * Also manages the GPU status indicator.
 */

import type { ModelInfo, GpuInfo } from "../app";

export class ModelStatus {
  private modelDot: HTMLElement;
  private modelText: HTMLElement;
  private gpuDot: HTMLElement;
  private gpuText: HTMLElement;

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
  }

  updateModel(info: ModelInfo): void {
    // Status dot color
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

    // Text
    const vram =
      info.vramTotalMb > 0
        ? ` | VRAM: ${formatMb(info.vramUsedMb)}/${formatMb(info.vramTotalMb)}`
        : "";

    const latency =
      info.inferenceCount > 0
        ? ` | ${info.avgLatencyMs.toFixed(0)}ms avg`
        : "";

    this.modelText.textContent = `Model: ${info.status}${vram}${latency}`;
  }

  updateGpu(info: GpuInfo): void {
    // Status dot
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

    const temp = info.temperatureC > 0 ? ` | ${info.temperatureC}C` : "";
    const util = `${info.utilizationPercent.toFixed(0)}%`;
    const vram = `${formatMb(info.vramUsedMb)}/${formatMb(info.vramTotalMb)}`;

    this.gpuText.textContent = `GPU: ${util}${temp} | ${vram}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${mb.toFixed(0)}M`;
}
