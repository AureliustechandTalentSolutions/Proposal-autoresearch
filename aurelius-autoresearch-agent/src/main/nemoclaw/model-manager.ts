/**
 * @module model-manager
 * @description Nemotron Model Manager for NemoClaw.
 *
 * Manages local LLM models served by Ollama, including GPU detection via
 * nvidia-smi, VRAM-aware quantization selection, health monitoring, and
 * model warm-up. Implements a fallback chain: Nemotron -> Ollama -> CPU.
 *
 * Uses Bun-native APIs exclusively.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Information about a model available through Ollama. */
export interface ModelInfo {
  /** Model name as known to Ollama (e.g. "nemotron:70b-q4_K_M"). */
  name: string;
  /** Size on disk in gigabytes. */
  size_gb: number;
  /** Quantization level (e.g. "q4_K_M", "q8_0", "f16"). */
  quantization: string;
  /** Whether the model is currently loaded into GPU/RAM. */
  loaded: boolean;
  /** Approximate VRAM consumption when loaded, in megabytes. */
  vram_usage_mb: number;
  /** List of capability tags (e.g. ["chat", "code", "reasoning"]). */
  capabilities: string[];
}

/** Information about an NVIDIA GPU detected on the host. */
export interface GPUInfo {
  /** GPU product name (e.g. "NVIDIA RTX 4090"). */
  name: string;
  /** Total VRAM in megabytes. */
  vram_total_mb: number;
  /** Currently used VRAM in megabytes. */
  vram_used_mb: number;
  /** Free VRAM in megabytes. */
  vram_free_mb: number;
  /** CUDA driver version string. */
  cuda_version: string;
  /** GPU temperature in Celsius (0 if unavailable). */
  temperature_c: number;
  /** GPU utilization percentage (0-100). */
  utilization_percent: number;
}

/** Overall status of the model manager and Ollama service. */
export interface ModelManagerStatus {
  /** Whether the Ollama API is reachable. */
  ollama_reachable: boolean;
  /** Ollama API endpoint URL. */
  endpoint: string;
  /** Detected GPU information (null if no GPU). */
  gpu: GPUInfo | null;
  /** Number of models available locally. */
  models_available: number;
  /** Number of models currently loaded. */
  models_loaded: number;
  /** Active fallback level in the chain. */
  active_fallback: "nemotron" | "ollama" | "cpu";
  /** Inference metrics. */
  inference_metrics: InferenceMetrics;
}

/** Recommendation result from VRAM-based model selection. */
export interface ModelRecommendation {
  /** Recommended model name. */
  name: string;
  /** Recommended quantization level. */
  quantization: string;
  /** Estimated VRAM consumption in megabytes. */
  estimated_vram_mb: number;
  /** Explanation of the recommendation. */
  rationale: string;
}

/** Health check result. */
export interface HealthCheckResult {
  /** Whether the endpoint is healthy. */
  healthy: boolean;
  /** Latency in milliseconds. */
  latency_ms: number;
  /** Error message if unhealthy. */
  error?: string;
  /** Timestamp of the check. */
  timestamp: string;
}

/** Inference performance metrics. */
export interface InferenceMetrics {
  /** Total number of inference calls. */
  total_calls: number;
  /** Number of successful calls. */
  successful_calls: number;
  /** Number of failed calls. */
  failed_calls: number;
  /** Average latency in milliseconds. */
  avg_latency_ms: number;
  /** Total tokens generated (if available). */
  total_tokens: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Known model families and their approximate per-parameter VRAM requirements
 * at different quantization levels (in bytes per parameter).
 */
const QUANT_BYTES_PER_PARAM: Record<string, number> = {
  f16: 2.0,
  q8_0: 1.0,
  q6_K: 0.75,
  q5_K_M: 0.625,
  q4_K_M: 0.5,
  q4_0: 0.5,
  q3_K_M: 0.375,
  q2_K: 0.25,
};

/**
 * VRAM thresholds for automatic quantization selection.
 * - < 8 GB: q4 quantization
 * - 8-16 GB: q8 quantization
 * - > 16 GB: FP16
 */
const VRAM_QUANT_THRESHOLDS = [
  { max_vram_gb: 8, quantization: "q4_K_M" },
  { max_vram_gb: 16, quantization: "q8_0" },
  { max_vram_gb: Infinity, quantization: "f16" },
] as const;

/**
 * Curated model catalog with parameter counts (in billions) and capabilities.
 */
const MODEL_CATALOG: Array<{
  pattern: RegExp;
  params_b: number;
  capabilities: string[];
}> = [
  {
    pattern: /nemotron.*70b/i,
    params_b: 70,
    capabilities: ["chat", "code", "reasoning", "tool_use"],
  },
  {
    pattern: /nemotron.*22b/i,
    params_b: 22,
    capabilities: ["chat", "code", "reasoning"],
  },
  {
    pattern: /nemotron.*8b/i,
    params_b: 8,
    capabilities: ["chat", "code"],
  },
  {
    pattern: /llama.*70b/i,
    params_b: 70,
    capabilities: ["chat", "code", "reasoning"],
  },
  {
    pattern: /llama.*13b/i,
    params_b: 13,
    capabilities: ["chat", "code"],
  },
  {
    pattern: /llama.*8b/i,
    params_b: 8,
    capabilities: ["chat", "code"],
  },
  {
    pattern: /codellama/i,
    params_b: 34,
    capabilities: ["code"],
  },
  {
    pattern: /mistral.*7b/i,
    params_b: 7,
    capabilities: ["chat", "code"],
  },
  {
    pattern: /mixtral/i,
    params_b: 47,
    capabilities: ["chat", "code", "reasoning"],
  },
  {
    pattern: /qwen.*72b/i,
    params_b: 72,
    capabilities: ["chat", "code", "reasoning"],
  },
  {
    pattern: /deepseek.*coder/i,
    params_b: 33,
    capabilities: ["code"],
  },
];

/** Health check poll interval (30 seconds). */
const HEALTH_POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of locally-served LLM models via Ollama.
 * Implements the fallback chain: Nemotron -> Ollama (generic) -> CPU inference.
 *
 * @example
 * ```ts
 * const mm = new ModelManager();
 * await mm.initialize();
 * const gpu = await mm.detect_gpu();
 * if (gpu) {
 *   const rec = await mm.recommend_model(gpu.vram_free_mb);
 *   await mm.load_model(rec.name, rec.quantization);
 * }
 * const status = await mm.get_status();
 * ```
 */
export class ModelManager {
  /** Ollama API base URL. */
  private readonly endpoint: string;
  /** Cached GPU info (null = not yet detected, undefined = no GPU). */
  private gpu_cache: GPUInfo | null | undefined = undefined;
  /** Health check polling timer. */
  private health_timer: Timer | null = null;
  /** Latest health check results for each endpoint. */
  private health_history: HealthCheckResult[] = [];
  /** Inference performance metrics. */
  private metrics: InferenceMetrics = {
    total_calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    avg_latency_ms: 0,
    total_tokens: 0,
  };
  /** Active fallback level. */
  private active_fallback: "nemotron" | "ollama" | "cpu" = "ollama";
  /** Whether the manager has been initialized. */
  private initialized = false;
  /** Event handlers for status changes. */
  private status_handlers: Array<(status: ModelManagerStatus) => void> = [];

  /**
   * @param endpoint Ollama API base URL. Defaults to `http://localhost:11434`.
   */
  constructor(endpoint: string = "http://localhost:11434") {
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialize the model manager: detect GPU, check Ollama, warm up models.
   * Should be called once at startup.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log("[ModelManager] Initializing...");

    // Detect GPU.
    const gpu = await this.detect_gpu();
    if (gpu) {
      console.log(
        `[ModelManager] GPU detected: ${gpu.name} (${gpu.vram_total_mb} MB VRAM, CUDA ${gpu.cuda_version})`,
      );
    } else {
      console.log("[ModelManager] No GPU detected; will use CPU inference.");
    }

    // Check Ollama availability and determine fallback level.
    const ollamaOk = await this.isOllamaReachable();
    if (ollamaOk) {
      // Check if Nemotron models are available.
      const models = await this.list_models();
      const hasNemotron = models.some((m) => /nemotron/i.test(m.name));
      this.active_fallback = hasNemotron ? "nemotron" : "ollama";

      // Auto warm-up: ensure at least one model is loaded.
      const loaded = models.filter((m) => m.loaded);
      if (loaded.length === 0 && models.length > 0) {
        // Pick the best model based on VRAM.
        const vramFree = gpu?.vram_free_mb ?? 4096;
        const rec = await this.recommend_model(vramFree);
        console.log(
          `[ModelManager] Auto-loading model: ${rec.name} (${rec.rationale})`,
        );
        try {
          await this.load_model(rec.name, rec.quantization);
        } catch (err) {
          console.warn("[ModelManager] Auto-load failed:", err);
        }
      }
    } else {
      this.active_fallback = "cpu";
      console.warn(
        "[ModelManager] Ollama not reachable; falling back to CPU inference.",
      );
    }

    // Start health check polling.
    this.startHealthPolling();

    this.initialized = true;
    console.log(
      `[ModelManager] Ready (fallback chain active: ${this.active_fallback})`,
    );
  }

  /**
   * Detect NVIDIA GPU information via `nvidia-smi`.
   *
   * @returns GPU information or `null` if no compatible GPU is found.
   */
  async detect_gpu(): Promise<GPUInfo | null> {
    try {
      const proc = Bun.spawn(
        [
          "nvidia-smi",
          "--query-gpu=name,memory.total,memory.used,memory.free,driver_version,temperature.gpu,utilization.gpu",
          "--format=csv,noheader,nounits",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        this.gpu_cache = null;
        return null;
      }

      const output = (await new Response(proc.stdout).text()).trim();
      if (!output) {
        this.gpu_cache = null;
        return null;
      }

      // Take the first GPU if multiple are present.
      const firstLine = output.split("\n")[0];
      const parts = firstLine.split(",").map((s) => s.trim());

      if (parts.length < 5) {
        this.gpu_cache = null;
        return null;
      }

      // Detect CUDA version from nvidia-smi header output.
      let cudaVersion = "unknown";
      try {
        const headerProc = Bun.spawn(["nvidia-smi"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await headerProc.exited;
        const headerOut = await new Response(headerProc.stdout).text();
        const cudaMatch = headerOut.match(/CUDA Version:\s*([\d.]+)/);
        cudaVersion = cudaMatch ? cudaMatch[1] : parts[4] ?? "unknown";
      } catch {
        cudaVersion = parts[4] ?? "unknown";
      }

      const gpu: GPUInfo = {
        name: parts[0],
        vram_total_mb: Math.round(parseFloat(parts[1])),
        vram_used_mb: Math.round(parseFloat(parts[2])),
        vram_free_mb: Math.round(parseFloat(parts[3])),
        cuda_version: cudaVersion,
        temperature_c: parseFloat(parts[5] ?? "0") || 0,
        utilization_percent: parseFloat(parts[6] ?? "0") || 0,
      };

      this.gpu_cache = gpu;
      return gpu;
    } catch {
      this.gpu_cache = null;
      return null;
    }
  }

  /**
   * List all models available through the Ollama API.
   */
  async list_models(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        throw new Error(`Ollama API returned HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as {
        models?: Array<{
          name: string;
          size: number;
          details?: {
            quantization_level?: string;
            families?: string[];
          };
        }>;
      };

      if (!data.models) return [];

      const loadedNames = await this.getLoadedModelNames();

      return data.models.map((m) => {
        const quantization =
          m.details?.quantization_level ??
          this.extractQuantization(m.name);
        const size_gb = m.size / (1024 * 1024 * 1024);
        const catalog = this.lookupCatalog(m.name);

        return {
          name: m.name,
          size_gb: Math.round(size_gb * 100) / 100,
          quantization,
          loaded: loadedNames.has(m.name),
          vram_usage_mb: this.estimateVRAM(m.name, quantization),
          capabilities: catalog?.capabilities ?? ["chat"],
        };
      });
    } catch (err) {
      console.error("Failed to list Ollama models:", err);
      return [];
    }
  }

  /**
   * Load (pull and warm up) a model in Ollama.
   *
   * When the host GPU has insufficient VRAM for the requested quantization,
   * the method automatically selects a smaller quantization.
   */
  async load_model(name: string, quantization?: string): Promise<void> {
    let modelTag = name;

    // Append quantization if not already present.
    if (quantization && !name.includes(quantization)) {
      if (name.includes(":")) {
        modelTag = `${name}-${quantization}`;
      } else {
        modelTag = `${name}:${quantization}`;
      }
    }

    // VRAM check: if GPU is available, verify we have enough headroom.
    const gpu =
      this.gpu_cache !== undefined ? this.gpu_cache : await this.detect_gpu();
    if (gpu) {
      const estimatedVRAM = this.estimateVRAM(
        modelTag,
        quantization ?? this.extractQuantization(modelTag),
      );
      if (estimatedVRAM > gpu.vram_free_mb) {
        const betterQuant = this.selectQuantizationForVRAM(
          name,
          gpu.vram_free_mb,
        );
        if (betterQuant) {
          console.warn(
            `Insufficient VRAM for ${modelTag} (~${estimatedVRAM} MB needed, ` +
              `${gpu.vram_free_mb} MB free). Downgrading to ${betterQuant}.`,
          );
          modelTag = name.includes(":")
            ? `${name.split(":")[0]}:${betterQuant}`
            : `${name}:${betterQuant}`;
        }
      }
    }

    // Pull the model (no-op if already present).
    console.log(`[ModelManager] Pulling model ${modelTag}...`);
    const pullResp = await fetch(`${this.endpoint}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelTag, stream: false }),
      signal: AbortSignal.timeout(600_000), // 10 min timeout for large model pulls.
    });

    if (!pullResp.ok) {
      const body = await pullResp.text();
      throw new Error(`Failed to pull model ${modelTag}: ${body}`);
    }

    // Warm up the model by sending a trivial generate request.
    console.log(`[ModelManager] Warming up model ${modelTag}...`);
    try {
      const warmupResp = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelTag,
          prompt: "Hello",
          stream: false,
          options: { num_predict: 1 },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!warmupResp.ok) {
        console.warn(
          `[ModelManager] Warmup for ${modelTag} returned HTTP ${warmupResp.status}`,
        );
      } else {
        console.log(`[ModelManager] Model ${modelTag} loaded and warmed up.`);
      }
    } catch (err) {
      console.warn(`[ModelManager] Warmup for ${modelTag} failed:`, err);
    }
  }

  /**
   * Unload a model from memory (free VRAM).
   */
  async unload_model(name: string): Promise<void> {
    try {
      // Ollama does not have a direct unload API.
      // Sending a generate with keep_alive=0 tells Ollama to unload.
      await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: name,
          keep_alive: 0,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`[ModelManager] Unloaded model ${name}`);
    } catch (err) {
      console.warn(`[ModelManager] Failed to unload ${name}:`, err);
    }
  }

  /**
   * Get the overall status of the model manager.
   */
  async get_status(): Promise<ModelManagerStatus> {
    const ollamaOk = await this.isOllamaReachable();
    const gpu =
      this.gpu_cache !== undefined ? this.gpu_cache : await this.detect_gpu();
    let modelsAvailable = 0;
    let modelsLoaded = 0;

    if (ollamaOk) {
      const models = await this.list_models();
      modelsAvailable = models.length;
      modelsLoaded = models.filter((m) => m.loaded).length;
    }

    return {
      ollama_reachable: ollamaOk,
      endpoint: this.endpoint,
      gpu,
      models_available: modelsAvailable,
      models_loaded: modelsLoaded,
      active_fallback: this.active_fallback,
      inference_metrics: { ...this.metrics },
    };
  }

  /**
   * Perform a health check against the Ollama endpoint.
   */
  async health_check(): Promise<HealthCheckResult> {
    const start = performance.now();
    try {
      const resp = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      const latency = performance.now() - start;
      const result: HealthCheckResult = {
        healthy: resp.ok,
        latency_ms: latency,
        error: resp.ok ? undefined : `HTTP ${resp.status}`,
        timestamp: new Date().toISOString(),
      };

      this.health_history.push(result);
      if (this.health_history.length > 100) {
        this.health_history = this.health_history.slice(-50);
      }

      return result;
    } catch (err: unknown) {
      const latency = performance.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      const result: HealthCheckResult = {
        healthy: false,
        latency_ms: latency,
        error: message,
        timestamp: new Date().toISOString(),
      };
      this.health_history.push(result);
      return result;
    }
  }

  /**
   * Get health check history.
   */
  get_health_history(): HealthCheckResult[] {
    return [...this.health_history];
  }

  /**
   * Ensure Ollama is running and at least one model is loaded.
   * Falls back through the chain if Ollama is not available.
   */
  async ensure_ready(): Promise<void> {
    const reachable = await this.isOllamaReachable();
    if (!reachable) {
      // Try the fallback chain.
      console.warn(
        "[ModelManager] Ollama not reachable. Attempting fallback...",
      );

      // Try starting Ollama via Bun.spawn.
      try {
        const proc = Bun.spawn(["ollama", "serve"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        // Detach -- don't await.
        // Give it a moment to start.
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const nowReachable = await this.isOllamaReachable();
        if (nowReachable) {
          console.log("[ModelManager] Ollama started successfully.");
          this.active_fallback = "ollama";
        } else {
          console.warn(
            "[ModelManager] Ollama failed to start; falling back to CPU.",
          );
          this.active_fallback = "cpu";
        }
      } catch {
        console.warn(
          "[ModelManager] Cannot start Ollama; falling back to CPU.",
        );
        this.active_fallback = "cpu";
        return;
      }
    }

    const models = await this.list_models();
    if (models.length === 0) {
      console.warn(
        "[ModelManager] No models available. Pull a model first (e.g. ollama pull nemotron).",
      );
      return;
    }

    const loaded = models.filter((m) => m.loaded);
    if (loaded.length === 0) {
      // Auto-load the best available model.
      const gpu =
        this.gpu_cache !== undefined
          ? this.gpu_cache
          : await this.detect_gpu();
      const vram = gpu?.vram_free_mb ?? 4096;
      const rec = await this.recommend_model(vram);
      console.log(
        `[ModelManager] No models loaded. Auto-loading "${rec.name}"...`,
      );
      await this.load_model(rec.name, rec.quantization);
    }
  }

  /**
   * Recommend the best model and quantization for a given amount of free VRAM.
   * Uses the VRAM threshold strategy: <8GB->Q4, 8-16GB->Q8, >16GB->FP16.
   */
  async recommend_model(vram_mb: number): Promise<ModelRecommendation> {
    const vram_gb = vram_mb / 1024;

    // Select quantization based on VRAM thresholds.
    let targetQuant = "q4_K_M";
    for (const threshold of VRAM_QUANT_THRESHOLDS) {
      if (vram_gb < threshold.max_vram_gb) {
        targetQuant = threshold.quantization;
        break;
      }
    }

    // Find the largest model that fits.
    const candidates: Array<{
      name: string;
      quant: string;
      vram: number;
      params_b: number;
      capabilities: string[];
    }> = [];

    const bytesPerParam =
      QUANT_BYTES_PER_PARAM[targetQuant] ?? QUANT_BYTES_PER_PARAM["q4_K_M"]!;

    for (const entry of MODEL_CATALOG) {
      const vramEstimate = Math.round(
        (entry.params_b * 1e9 * bytesPerParam) / (1024 * 1024) + 500,
      );
      // Leave 10% headroom.
      if (vramEstimate <= vram_mb * 0.9) {
        candidates.push({
          name: entry.pattern.source.replace(/[\\^$.*+?()[\]{}|]/g, ""),
          quant: targetQuant,
          vram: vramEstimate,
          params_b: entry.params_b,
          capabilities: entry.capabilities,
        });
      }
    }

    // Also try lower quantizations for larger models.
    for (const entry of MODEL_CATALOG) {
      for (const [quant, bpp] of Object.entries(QUANT_BYTES_PER_PARAM)) {
        if (quant === targetQuant) continue;
        const vramEstimate = Math.round(
          (entry.params_b * 1e9 * bpp) / (1024 * 1024) + 500,
        );
        if (vramEstimate <= vram_mb * 0.9) {
          candidates.push({
            name: entry.pattern.source.replace(/[\\^$.*+?()[\]{}|]/g, ""),
            quant,
            vram: vramEstimate,
            params_b: entry.params_b,
            capabilities: entry.capabilities,
          });
        }
      }
    }

    if (candidates.length === 0) {
      return {
        name: "nemotron:8b-q2_K",
        quantization: "q2_K",
        estimated_vram_mb: 2000,
        rationale: `Only ${vram_mb} MB VRAM available; recommending smallest quantization for CPU/partial offload`,
      };
    }

    // Sort: prefer more parameters first, then better quantization.
    candidates.sort((a, b) => {
      if (b.params_b !== a.params_b) return b.params_b - a.params_b;
      return (
        (QUANT_BYTES_PER_PARAM[b.quant] ?? 0) -
        (QUANT_BYTES_PER_PARAM[a.quant] ?? 0)
      );
    });

    const best = candidates[0];
    return {
      name: `nemotron:${best.params_b}b-${best.quant}`,
      quantization: best.quant,
      estimated_vram_mb: best.vram,
      rationale:
        `Selected ${best.params_b}B parameter model with ${best.quant} quantization ` +
        `(~${best.vram} MB VRAM, ${Math.round((best.vram / vram_mb) * 100)}% of available). ` +
        `Capabilities: ${best.capabilities.join(", ")}`,
    };
  }

  /**
   * Record an inference call for metrics tracking.
   */
  record_inference(latency_ms: number, success: boolean, tokens?: number): void {
    this.metrics.total_calls++;
    if (success) {
      this.metrics.successful_calls++;
    } else {
      this.metrics.failed_calls++;
    }
    if (tokens) {
      this.metrics.total_tokens += tokens;
    }

    // Rolling average for latency.
    this.metrics.avg_latency_ms =
      (this.metrics.avg_latency_ms * (this.metrics.total_calls - 1) +
        latency_ms) /
      this.metrics.total_calls;
  }

  /**
   * Register a handler for status update events.
   */
  on_status(handler: (status: ModelManagerStatus) => void): void {
    this.status_handlers.push(handler);
  }

  /**
   * Refresh GPU stats (re-query nvidia-smi).
   */
  async refresh_gpu(): Promise<GPUInfo | null> {
    this.gpu_cache = undefined;
    return this.detect_gpu();
  }

  /**
   * Stop health polling and clean up timers.
   */
  destroy(): void {
    if (this.health_timer) {
      clearInterval(this.health_timer);
      this.health_timer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Check whether the Ollama API is reachable. */
  private async isOllamaReachable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Fetch the set of currently loaded (running) model names. */
  private async getLoadedModelNames(): Promise<Set<string>> {
    try {
      const resp = await fetch(`${this.endpoint}/api/ps`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return new Set();

      const data = (await resp.json()) as {
        models?: Array<{ name: string }>;
      };
      return new Set((data.models ?? []).map((m) => m.name));
    } catch {
      return new Set();
    }
  }

  /** Extract quantization info from a model tag string. */
  private extractQuantization(name: string): string {
    for (const quant of Object.keys(QUANT_BYTES_PER_PARAM)) {
      if (name.toLowerCase().includes(quant.toLowerCase())) {
        return quant;
      }
    }
    return "q4_K_M"; // reasonable default
  }

  /** Look up a model in the curated catalog. */
  private lookupCatalog(
    name: string,
  ): (typeof MODEL_CATALOG)[number] | undefined {
    return MODEL_CATALOG.find((entry) => entry.pattern.test(name));
  }

  /** Estimate VRAM usage for a model at a given quantization. */
  private estimateVRAM(name: string, quantization: string): number {
    const catalog = this.lookupCatalog(name);
    const paramsB = catalog?.params_b ?? 7; // default to 7B
    const bytesPerParam =
      QUANT_BYTES_PER_PARAM[quantization] ??
      QUANT_BYTES_PER_PARAM["q4_K_M"]!;

    // VRAM = parameters * bytes_per_param + overhead (~500 MB)
    return Math.round(
      (paramsB * 1e9 * bytesPerParam) / (1024 * 1024) + 500,
    );
  }

  /**
   * Select the best quantization level that fits within available VRAM.
   */
  private selectQuantizationForVRAM(
    name: string,
    vram_free_mb: number,
  ): string | null {
    const catalog = this.lookupCatalog(name);
    const paramsB = catalog?.params_b ?? 7;

    // Try quantizations from best to worst quality.
    const ordered: Array<[string, number]> = Object.entries(
      QUANT_BYTES_PER_PARAM,
    ).sort((a, b) => b[1] - a[1]);

    for (const [quant, bytesPerParam] of ordered) {
      const estimate = Math.round(
        (paramsB * 1e9 * bytesPerParam) / (1024 * 1024) + 500,
      );
      if (estimate <= vram_free_mb * 0.9) {
        return quant;
      }
    }

    return null;
  }

  /** Start periodic health check polling. */
  private startHealthPolling(): void {
    this.health_timer = setInterval(async () => {
      const result = await this.health_check();

      // Update fallback level based on health.
      if (!result.healthy && this.active_fallback !== "cpu") {
        console.warn(
          "[ModelManager] Health check failed; considering fallback adjustment.",
        );
      }

      // Emit status update.
      if (this.status_handlers.length > 0) {
        try {
          const status = await this.get_status();
          for (const handler of this.status_handlers) {
            handler(status);
          }
        } catch {
          // Swallow errors in status emission.
        }
      }
    }, HEALTH_POLL_INTERVAL_MS);

    if (
      this.health_timer &&
      typeof this.health_timer === "object" &&
      "unref" in this.health_timer
    ) {
      (this.health_timer as any).unref();
    }
  }
}
