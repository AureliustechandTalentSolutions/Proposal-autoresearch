/**
 * @module model-manager
 * @description Nemotron Model Manager for NemoClaw.
 *
 * Manages local LLM models served by Ollama, including GPU detection via
 * nvidia-smi, VRAM-aware quantization selection, and health monitoring.
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
 * Curated model catalog with parameter counts (in billions) and capabilities.
 * Used for VRAM estimation when Ollama metadata is insufficient.
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

// ---------------------------------------------------------------------------
// ModelManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of locally-served LLM models via Ollama.
 *
 * @example
 * ```ts
 * const mm = new ModelManager();
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
   * Detect NVIDIA GPU information via `nvidia-smi`.
   *
   * @returns GPU information or `null` if no compatible GPU is found.
   */
  async detect_gpu(): Promise<GPUInfo | null> {
    try {
      const proc = Bun.spawn(
        [
          "nvidia-smi",
          "--query-gpu=name,memory.total,memory.used,memory.free,driver_version",
          "--format=csv,noheader,nounits",
        ],
        { stdout: "pipe", stderr: "pipe" }
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

      // Detect CUDA version separately.
      let cudaVersion = "unknown";
      try {
        const cudaProc = Bun.spawn(
          ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
          { stdout: "pipe", stderr: "pipe" }
        );
        await cudaProc.exited;
        const cudaOut = (await new Response(cudaProc.stdout).text()).trim();

        // nvidia-smi prints driver version; CUDA version is in the header.
        // Fall back to the driver version if CUDA isn't directly available.
        const headerProc = Bun.spawn(["nvidia-smi"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await headerProc.exited;
        const headerOut = await new Response(headerProc.stdout).text();
        const cudaMatch = headerOut.match(/CUDA Version:\s*([\d.]+)/);
        cudaVersion = cudaMatch ? cudaMatch[1] : cudaOut;
      } catch {
        // Swallow; cudaVersion remains "unknown".
      }

      const gpu: GPUInfo = {
        name: parts[0],
        vram_total_mb: Math.round(parseFloat(parts[1])),
        vram_used_mb: Math.round(parseFloat(parts[2])),
        vram_free_mb: Math.round(parseFloat(parts[3])),
        cuda_version: cudaVersion,
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
   *
   * @returns Array of model information objects.
   */
  async list_models(): Promise<ModelInfo[]> {
    try {
      const resp = await fetch(`${this.endpoint}/api/tags`);
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

      // Also fetch running models to determine loaded state.
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
   * If a quantization level is specified and the model name doesn't already
   * include one, the quantization suffix is appended.
   *
   * When the host GPU has insufficient VRAM for the requested quantization,
   * the method automatically selects a smaller quantization.
   *
   * @param name Model name (e.g. "nemotron").
   * @param quantization Optional quantization (e.g. "q4_K_M").
   */
  async load_model(name: string, quantization?: string): Promise<void> {
    let modelTag = name;

    // Append quantization if not already present.
    if (quantization && !name.includes(quantization)) {
      // Ollama uses the format "model:tag" where tag may include quantization.
      if (name.includes(":")) {
        modelTag = `${name}-${quantization}`;
      } else {
        modelTag = `${name}:${quantization}`;
      }
    }

    // VRAM check: if GPU is available, verify we have enough headroom.
    const gpu = this.gpu_cache !== undefined ? this.gpu_cache : await this.detect_gpu();
    if (gpu) {
      const estimatedVRAM = this.estimateVRAM(
        modelTag,
        quantization ?? this.extractQuantization(modelTag)
      );
      if (estimatedVRAM > gpu.vram_free_mb) {
        const betterQuant = this.selectQuantizationForVRAM(name, gpu.vram_free_mb);
        if (betterQuant) {
          console.warn(
            `Insufficient VRAM for ${modelTag} (~${estimatedVRAM} MB needed, ` +
              `${gpu.vram_free_mb} MB free). Downgrading to ${betterQuant}.`
          );
          modelTag = name.includes(":")
            ? `${name.split(":")[0]}:${betterQuant}`
            : `${name}:${betterQuant}`;
        }
      }
    }

    // Pull the model (no-op if already present).
    console.log(`Pulling model ${modelTag}...`);
    const pullResp = await fetch(`${this.endpoint}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelTag, stream: false }),
    });

    if (!pullResp.ok) {
      const body = await pullResp.text();
      throw new Error(`Failed to pull model ${modelTag}: ${body}`);
    }

    // Warm up the model by sending a trivial generate request.
    console.log(`Warming up model ${modelTag}...`);
    const warmupResp = await fetch(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelTag,
        prompt: "Hello",
        stream: false,
        options: { num_predict: 1 },
      }),
    });

    if (!warmupResp.ok) {
      console.warn(`Warmup for ${modelTag} returned HTTP ${warmupResp.status}`);
    }

    console.log(`Model ${modelTag} loaded and ready.`);
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
    };
  }

  /**
   * Ensure Ollama is running and at least one model is loaded.
   *
   * @throws Error if Ollama is unreachable or no models are available.
   */
  async ensure_ready(): Promise<void> {
    const reachable = await this.isOllamaReachable();
    if (!reachable) {
      throw new Error(
        `Ollama is not reachable at ${this.endpoint}. ` +
          `Ensure Ollama is running (ollama serve).`
      );
    }

    const models = await this.list_models();
    if (models.length === 0) {
      throw new Error(
        "No models available in Ollama. Pull a model first (e.g. ollama pull nemotron)."
      );
    }

    const loaded = models.filter((m) => m.loaded);
    if (loaded.length === 0) {
      // Auto-load the first available model.
      console.log(
        `No models currently loaded. Auto-loading "${models[0].name}"...`
      );
      await this.load_model(models[0].name);
    }
  }

  /**
   * Recommend the best model and quantization for a given amount of free VRAM.
   *
   * @param vram_mb Available VRAM in megabytes.
   * @returns A recommendation, or a CPU-only fallback if VRAM is too low.
   */
  async recommend_model(vram_mb: number): Promise<ModelRecommendation> {
    // Preference order: larger models with better quantization first.
    const candidates: Array<{
      name: string;
      quant: string;
      vram: number;
      params_b: number;
      capabilities: string[];
    }> = [];

    for (const entry of MODEL_CATALOG) {
      for (const [quant, bytesPerParam] of Object.entries(QUANT_BYTES_PER_PARAM)) {
        const vramEstimate = Math.round(
          (entry.params_b * 1e9 * bytesPerParam) / (1024 * 1024)
        );
        // Leave 10% headroom.
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

    // Sort: prefer more parameters, then better quantization.
    candidates.sort((a, b) => {
      if (b.params_b !== a.params_b) return b.params_b - a.params_b;
      return (QUANT_BYTES_PER_PARAM[b.quant] ?? 0) - (QUANT_BYTES_PER_PARAM[a.quant] ?? 0);
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
      const resp = await fetch(`${this.endpoint}/api/ps`);
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
    name: string
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
      (paramsB * 1e9 * bytesPerParam) / (1024 * 1024) + 500
    );
  }

  /**
   * Select the best quantization level that fits within available VRAM.
   * Returns null if no quantization fits.
   */
  private selectQuantizationForVRAM(
    name: string,
    vram_free_mb: number
  ): string | null {
    const catalog = this.lookupCatalog(name);
    const paramsB = catalog?.params_b ?? 7;

    // Try quantizations from best to worst.
    const ordered: Array<[string, number]> = Object.entries(QUANT_BYTES_PER_PARAM)
      .sort((a, b) => b[1] - a[1]); // best quality first

    for (const [quant, bytesPerParam] of ordered) {
      const estimate = Math.round(
        (paramsB * 1e9 * bytesPerParam) / (1024 * 1024) + 500
      );
      if (estimate <= vram_free_mb * 0.9) {
        return quant;
      }
    }

    return null;
  }
}
