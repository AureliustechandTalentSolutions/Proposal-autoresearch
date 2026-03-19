/**
 * @module privacy-router
 * @description Privacy Router for NemoClaw.
 *
 * Evaluates routing rules to determine whether an inference request should be
 * processed locally (Ollama / Nemotron) or in the cloud (Anthropic API).
 * CUI (Controlled Unclassified Information) markers and PII (Personally
 * Identifiable Information) are detected automatically. CUI forces local
 * routing regardless of any other rules; PII elevates sensitivity level.
 *
 * Routes requests to actual LLM endpoints via HTTP fetch.
 * Loads detection patterns and routing rules from config/privacy-router.yaml.
 *
 * Uses Bun-native APIs exclusively.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Condition predicate for a routing rule. All specified fields must match. */
export interface RoutingCondition {
  /** Required privacy mode ("local" | "cloud" | "hybrid"). */
  mode?: string;
  /** Glob or substring match against the task description. */
  task?: string;
  /** Minimum data sensitivity level (1-5) that triggers this rule. */
  data_sensitivity?: number;
  /** If true, rule matches when the context contains past-performance data. */
  contains_past_performance?: boolean;
  /** If true, rule matches when CUI markers are detected. */
  contains_cui_markers?: boolean;
}

/** A single routing rule evaluated in priority order. */
export interface RoutingRule {
  /** Human-readable label for the rule. */
  name: string;
  /** Numeric priority; lower values are evaluated first. */
  priority: number;
  /** Condition predicate. */
  condition: RoutingCondition;
  /** Target route when the condition matches. */
  route: "local" | "cloud";
  /** Model identifier to use for this route. */
  model: string;
}

/** The outcome of evaluating the routing rules for a request. */
export interface RoutingDecision {
  /** The name of the rule that matched (or "cui_safety_override"). */
  rule_matched: string;
  /** Selected route. */
  route: "local" | "cloud";
  /** Model identifier. */
  model: string;
  /** Human-readable explanation. */
  rationale: string;
  /** ISO-8601 timestamp when the decision was made. */
  timestamp: string;
  /** Classification level assigned to the request. */
  classification: ClassificationLevel;
  /** PII types detected in the payload (empty if none). */
  pii_detected: string[];
  /** CUI marker detected in the payload (null if none). */
  cui_marker: string | null;
}

/** Context provided to the router for each inference request. */
export interface RoutingContext {
  /** Privacy mode requested by the caller. */
  mode?: string;
  /** Task description or prompt summary. */
  task?: string;
  /** Data sensitivity level (1-5). */
  data_sensitivity?: number;
  /** Whether the payload references past performance information. */
  contains_past_performance?: boolean;
  /** Raw text payload to scan for CUI/PII markers. */
  payload?: string;
}

/** Aggregate routing statistics. */
export interface RoutingStats {
  total: number;
  local_count: number;
  cloud_count: number;
  local_percent: number;
  cloud_percent: number;
  /** Counts by classification level. */
  by_classification: Record<string, number>;
  /** Total PII detections. */
  pii_detections: number;
  /** Total CUI detections. */
  cui_detections: number;
}

/** Classification levels for data sensitivity. */
export type ClassificationLevel =
  | "public"
  | "internal"
  | "sensitive"
  | "cui"
  | "classified";

/** Result from classifying a text payload. */
export interface ClassificationResult {
  level: ClassificationLevel;
  sensitivity: number;
  cui_marker: string | null;
  pii_types: string[];
  rationale: string;
}

/** Result from routing and executing an inference request. */
export interface InferenceResult {
  decision: RoutingDecision;
  response: string;
  latency_ms: number;
  endpoint: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// CUI detection
// ---------------------------------------------------------------------------

/**
 * Default CUI literal markers. Overridden by config file if present.
 */
const DEFAULT_CUI_MARKERS: string[] = [
  "CUI",
  "CONTROLLED UNCLASSIFIED",
  "FOUO",
  "FOR OFFICIAL USE ONLY",
  "NOFORN",
  "//CUI",
  "CUI//SP-CTI",
  "CUI//SP-EXPT",
  "DISTRIBUTION STATEMENT B",
  "DISTRIBUTION STATEMENT C",
  "DISTRIBUTION STATEMENT D",
  "DISTRIBUTION STATEMENT E",
  "DISTRIBUTION STATEMENT F",
];

/**
 * Default DoD contract number patterns that imply CUI.
 */
const DEFAULT_CONTRACT_PATTERNS: RegExp[] = [
  /\bW911NF[-\s]?\d/i,
  /\bFA8702[-\s]?\d/i,
  /\bFA8750[-\s]?\d/i,
  /\bN00024[-\s]?\d/i,
  /\bN00174[-\s]?\d/i,
  /\bN66001[-\s]?\d/i,
  /\bDAAB07[-\s]?\d/i,
  /\bH98230[-\s]?\d/i,
  /\bHQ0034[-\s]?\d/i,
  /\bHR0011[-\s]?\d/i,
];

// ---------------------------------------------------------------------------
// PII detection
// ---------------------------------------------------------------------------

/** Default PII detection patterns. */
const DEFAULT_PII_PATTERNS: Record<string, RegExp> = {
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  phone_us:
    /\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  credit_card:
    /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/,
  dob: /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/,
  address:
    /\b\d{1,5}\s+[A-Za-z]+(?:\s+[A-Za-z]+)*\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Pl|Place|Way|Cir|Circle)\b/i,
  passport: /\b[A-Z]\d{8}\b/,
  itar: /\bITAR\b/,
  ear: /\bEAR\b/,
};

// ---------------------------------------------------------------------------
// Router configuration file shape
// ---------------------------------------------------------------------------

interface RouterConfig {
  rules: RoutingRule[];
  defaults: {
    local_model: string;
    cloud_model: string;
  };
  endpoints?: {
    local?: { ollama?: string; nemotron?: string };
    cloud?: { anthropic?: string; openai?: string };
  };
  cui_detection?: {
    literal_markers?: string[];
    contract_patterns?: string[];
  };
  pii_detection?: {
    patterns?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// PrivacyRouter
// ---------------------------------------------------------------------------

/**
 * Routes inference requests between local and cloud endpoints based on
 * configurable rules, automatic CUI detection, and PII scanning.
 *
 * @example
 * ```ts
 * const router = new PrivacyRouter("/etc/nemoclaw/routing.yaml");
 * const decision = await router.route({
 *   mode: "hybrid",
 *   task: "Summarize cost proposal",
 *   data_sensitivity: 3,
 *   payload: "The W911NF-23-C-0042 contract specifies...",
 * });
 * console.log(decision.route); // "local" (CUI detected)
 * const result = await router.route_and_infer(
 *   { mode: "hybrid", payload: "public abstract text..." },
 *   "Summarize the above."
 * );
 * ```
 */
export class PrivacyRouter {
  /** Path to the YAML configuration file. */
  private readonly config_path: string;
  /** Loaded routing rules, sorted by priority. */
  private rules: RoutingRule[] = [];
  /** Default model identifiers. */
  private defaults: { local_model: string; cloud_model: string } = {
    local_model: "nemotron:70b-q4_K_M",
    cloud_model: "claude-sonnet-4-20250514",
  };
  /** Endpoint URLs. */
  private endpoints = {
    local: {
      ollama: "http://localhost:11434",
      nemotron: "http://localhost:11434",
    },
    cloud: {
      anthropic: "https://api.anthropic.com",
      openai: "https://api.openai.com",
    },
  };
  /** CUI literal markers (loaded from config or defaults). */
  private cui_markers: string[] = DEFAULT_CUI_MARKERS;
  /** CUI contract patterns (loaded from config or defaults). */
  private contract_patterns: RegExp[] = DEFAULT_CONTRACT_PATTERNS;
  /** PII detection patterns (loaded from config or defaults). */
  private pii_patterns: Record<string, RegExp> = { ...DEFAULT_PII_PATTERNS };
  /** Decision audit log. */
  private decision_log: RoutingDecision[] = [];
  /** Whether the config has been loaded. */
  private loaded = false;
  /** Registered decision handlers for real-time event emission. */
  private decision_handlers: Array<(d: RoutingDecision) => void> = [];

  /**
   * @param config_path Absolute path to the routing configuration YAML file.
   */
  constructor(config_path: string) {
    this.config_path = config_path;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Classify a text payload for sensitivity level, CUI markers, and PII.
   *
   * @param text The raw text to classify.
   * @returns Classification result with level, detected patterns, and rationale.
   */
  async classify(text: string): Promise<ClassificationResult> {
    await this.ensureLoaded();

    const cui = this.detectCUI(text);
    const pii = this.detectPII(text);

    if (cui) {
      return {
        level: "cui",
        sensitivity: 4,
        cui_marker: cui,
        pii_types: pii,
        rationale: `CUI marker "${cui}" detected`,
      };
    }

    if (pii.includes("itar") || pii.includes("ear")) {
      return {
        level: "classified",
        sensitivity: 5,
        cui_marker: null,
        pii_types: pii,
        rationale: `Export-controlled content detected: ${pii.join(", ")}`,
      };
    }

    if (pii.length >= 3) {
      return {
        level: "sensitive",
        sensitivity: 3,
        cui_marker: null,
        pii_types: pii,
        rationale: `Multiple PII types detected: ${pii.join(", ")}`,
      };
    }

    if (pii.length > 0) {
      return {
        level: "internal",
        sensitivity: 2,
        cui_marker: null,
        pii_types: pii,
        rationale: `PII detected: ${pii.join(", ")}`,
      };
    }

    return {
      level: "public",
      sensitivity: 1,
      cui_marker: null,
      pii_types: [],
      rationale: "No sensitive content detected",
    };
  }

  /**
   * Evaluate routing rules for the given context and return a decision.
   *
   * **Safety override**: If CUI markers are detected anywhere in
   * `context.payload`, the request is unconditionally routed locally
   * regardless of any matching rule.
   *
   * Rules are evaluated in priority order (ascending). The first matching
   * rule wins. If no rule matches, the request is routed to the cloud by
   * default.
   */
  async route(context: RoutingContext): Promise<RoutingDecision> {
    await this.ensureLoaded();

    const textToScan = [context.payload ?? "", context.task ?? ""].join(" ");

    // ---- Classify the content ----
    const classification = await this.classify(textToScan);

    // ---- CUI safety override ----
    if (classification.cui_marker) {
      const decision: RoutingDecision = {
        rule_matched: "cui_safety_override",
        route: "local",
        model: this.defaults.local_model,
        rationale: `CUI marker "${classification.cui_marker}" detected in payload; forcing local routing`,
        timestamp: new Date().toISOString(),
        classification: classification.level,
        pii_detected: classification.pii_types,
        cui_marker: classification.cui_marker,
      };
      this.recordDecision(decision);
      return decision;
    }

    // ---- PII elevation: bump sensitivity if PII found ----
    let effectiveSensitivity = context.data_sensitivity ?? classification.sensitivity;
    if (classification.pii_types.length > 0 && effectiveSensitivity < 2) {
      effectiveSensitivity = 2;
    }
    if (classification.pii_types.length >= 3 && effectiveSensitivity < 3) {
      effectiveSensitivity = 3;
    }

    const effectiveContext: RoutingContext = {
      ...context,
      data_sensitivity: effectiveSensitivity,
    };

    // ---- Rule evaluation ----
    for (const rule of this.rules) {
      if (this.matchesCondition(rule.condition, effectiveContext, textToScan)) {
        const decision: RoutingDecision = {
          rule_matched: rule.name,
          route: rule.route,
          model: rule.model,
          rationale: `Matched rule "${rule.name}" (priority ${rule.priority})`,
          timestamp: new Date().toISOString(),
          classification: classification.level,
          pii_detected: classification.pii_types,
          cui_marker: null,
        };
        this.recordDecision(decision);
        return decision;
      }
    }

    // ---- Default fallback ----
    const fallback: RoutingDecision = {
      rule_matched: "default",
      route: "cloud",
      model: this.defaults.cloud_model,
      rationale: "No rule matched; using default cloud routing",
      timestamp: new Date().toISOString(),
      classification: classification.level,
      pii_detected: classification.pii_types,
      cui_marker: null,
    };
    this.recordDecision(fallback);
    return fallback;
  }

  /**
   * Route a request and execute the inference against the selected endpoint.
   *
   * @param context Routing context (mode, sensitivity, payload).
   * @param prompt The prompt to send to the LLM.
   * @returns Inference result with the LLM response, latency, and routing decision.
   */
  async route_and_infer(
    context: RoutingContext,
    prompt: string,
  ): Promise<InferenceResult> {
    const decision = await this.route(context);
    const endpoint = this.get_endpoint(decision);
    const start = performance.now();

    try {
      let response: string;

      if (decision.route === "local") {
        response = await this.inferLocal(endpoint, decision.model, prompt);
      } else {
        response = await this.inferCloud(endpoint, decision.model, prompt);
      }

      return {
        decision,
        response,
        latency_ms: performance.now() - start,
        endpoint,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        decision,
        response: "",
        latency_ms: performance.now() - start,
        endpoint,
        error: message,
      };
    }
  }

  /**
   * Resolve a routing decision to a concrete API endpoint URL.
   */
  get_endpoint(decision: RoutingDecision): string {
    switch (decision.route) {
      case "local":
        return this.endpoints.local.ollama;
      case "cloud":
        return this.endpoints.cloud.anthropic;
      default:
        return this.endpoints.local.ollama;
    }
  }

  /**
   * Return the full decision audit log.
   */
  get_decision_log(): RoutingDecision[] {
    return [...this.decision_log];
  }

  /**
   * Compute aggregate routing statistics.
   */
  get_stats(): RoutingStats {
    const total = this.decision_log.length;
    const local_count = this.decision_log.filter(
      (d) => d.route === "local",
    ).length;
    const cloud_count = total - local_count;

    const by_classification: Record<string, number> = {};
    let pii_detections = 0;
    let cui_detections = 0;

    for (const d of this.decision_log) {
      by_classification[d.classification] =
        (by_classification[d.classification] ?? 0) + 1;
      if (d.pii_detected.length > 0) pii_detections++;
      if (d.cui_marker) cui_detections++;
    }

    return {
      total,
      local_count,
      cloud_count,
      local_percent: total > 0 ? (local_count / total) * 100 : 0,
      cloud_percent: total > 0 ? (cloud_count / total) * 100 : 0,
      by_classification,
      pii_detections,
      cui_detections,
    };
  }

  /**
   * Register a handler for routing decisions (real-time event emission).
   */
  on_decision(handler: (decision: RoutingDecision) => void): void {
    this.decision_handlers.push(handler);
  }

  /**
   * Force reload configuration from disk.
   */
  async reload(): Promise<void> {
    this.loaded = false;
    await this.ensureLoaded();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Lazy-load the configuration file on first use. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const file = Bun.file(this.config_path);
      const exists = await file.exists();
      if (!exists) {
        console.warn(
          `Privacy router config not found at ${this.config_path}; using defaults`,
        );
        this.loaded = true;
        return;
      }

      const text = await file.text();
      const yaml = await import("js-yaml");
      const raw = yaml.load(text) as Partial<RouterConfig>;

      if (raw.rules && Array.isArray(raw.rules)) {
        this.rules = (raw.rules as RoutingRule[]).sort(
          (a, b) => a.priority - b.priority,
        );
      }

      if (raw.defaults) {
        if (raw.defaults.local_model) {
          this.defaults.local_model = raw.defaults.local_model;
        }
        if (raw.defaults.cloud_model) {
          this.defaults.cloud_model = raw.defaults.cloud_model;
        }
      }

      // Load endpoints.
      if (raw.endpoints) {
        if (raw.endpoints.local?.ollama) {
          this.endpoints.local.ollama = raw.endpoints.local.ollama;
        }
        if (raw.endpoints.local?.nemotron) {
          this.endpoints.local.nemotron = raw.endpoints.local.nemotron;
        }
        if (raw.endpoints.cloud?.anthropic) {
          this.endpoints.cloud.anthropic = raw.endpoints.cloud.anthropic;
        }
        if (raw.endpoints.cloud?.openai) {
          this.endpoints.cloud.openai = raw.endpoints.cloud.openai;
        }
      }

      // Load CUI detection patterns.
      if (raw.cui_detection?.literal_markers) {
        this.cui_markers = raw.cui_detection.literal_markers;
      }
      if (raw.cui_detection?.contract_patterns) {
        this.contract_patterns = raw.cui_detection.contract_patterns.map(
          (p) => new RegExp(`\\b${p}[-\\s]?\\d`, "i"),
        );
      }

      // Load PII detection patterns.
      if (raw.pii_detection?.patterns) {
        this.pii_patterns = {};
        for (const [name, patternStr] of Object.entries(
          raw.pii_detection.patterns,
        )) {
          try {
            this.pii_patterns[name] = new RegExp(patternStr);
          } catch (err) {
            console.warn(`Invalid PII pattern "${name}": ${err}`);
          }
        }
      }
    } catch (err) {
      console.error("Failed to load privacy router config:", err);
    }

    this.loaded = true;
  }

  /** Scan text for CUI markers. Returns the first match or null. */
  private detectCUI(text: string): string | null {
    const upper = text.toUpperCase();

    for (const marker of this.cui_markers) {
      if (upper.includes(marker.toUpperCase())) {
        return marker;
      }
    }

    for (const pattern of this.contract_patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return null;
  }

  /** Scan text for PII patterns. Returns array of PII type names found. */
  private detectPII(text: string): string[] {
    const found: string[] = [];
    for (const [name, pattern] of Object.entries(this.pii_patterns)) {
      if (pattern.test(text)) {
        found.push(name);
      }
    }
    return found;
  }

  /**
   * Evaluate whether a routing context satisfies a rule condition.
   * All specified fields must match (logical AND).
   */
  private matchesCondition(
    condition: RoutingCondition,
    context: RoutingContext,
    textToScan: string,
  ): boolean {
    // Mode check.
    if (condition.mode !== undefined) {
      if (context.mode !== condition.mode) return false;
    }

    // Task substring match.
    if (condition.task !== undefined) {
      if (
        !context.task ||
        !context.task.toLowerCase().includes(condition.task.toLowerCase())
      ) {
        return false;
      }
    }

    // Data sensitivity threshold.
    if (condition.data_sensitivity !== undefined) {
      if (
        context.data_sensitivity === undefined ||
        context.data_sensitivity < condition.data_sensitivity
      ) {
        return false;
      }
    }

    // Past performance flag.
    if (condition.contains_past_performance !== undefined) {
      if (
        context.contains_past_performance !==
        condition.contains_past_performance
      ) {
        return false;
      }
    }

    // CUI markers flag (checked against payload).
    if (condition.contains_cui_markers === true) {
      if (this.detectCUI(textToScan) === null) return false;
    }

    return true;
  }

  /** Record a decision to the log and notify handlers. */
  private recordDecision(decision: RoutingDecision): void {
    this.decision_log.push(decision);

    // Cap log at 10000 entries.
    if (this.decision_log.length > 10000) {
      this.decision_log = this.decision_log.slice(-5000);
    }

    for (const handler of this.decision_handlers) {
      try {
        handler(decision);
      } catch {
        // Swallow handler errors.
      }
    }
  }

  /**
   * Execute inference against a local Ollama endpoint.
   */
  private async inferLocal(
    endpoint: string,
    model: string,
    prompt: string,
  ): Promise<string> {
    const resp = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Local inference failed (HTTP ${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as { response?: string };
    return data.response ?? "";
  }

  /**
   * Execute inference against a cloud Anthropic endpoint.
   */
  private async inferCloud(
    endpoint: string,
    model: string,
    prompt: string,
  ): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY not set; cannot route to cloud endpoint",
      );
    }

    const resp = await fetch(`${endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Cloud inference failed (HTTP ${resp.status}): ${body}`);
    }

    const data = (await resp.json()) as {
      content?: Array<{ text?: string }>;
    };
    return data.content?.[0]?.text ?? "";
  }
}
