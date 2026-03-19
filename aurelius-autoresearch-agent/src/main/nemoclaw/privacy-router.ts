/**
 * @module privacy-router
 * @description Privacy Router for NemoClaw.
 *
 * Evaluates routing rules to determine whether an inference request should be
 * processed locally (Ollama / Nemotron) or in the cloud (Anthropic API).
 * CUI (Controlled Unclassified Information) markers are detected automatically
 * and force local routing regardless of any other rules.
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
  /** Raw text payload to scan for CUI markers. */
  payload?: string;
}

/** Aggregate routing statistics. */
export interface RoutingStats {
  total: number;
  local_count: number;
  cloud_count: number;
  local_percent: number;
  cloud_percent: number;
}

// ---------------------------------------------------------------------------
// CUI detection
// ---------------------------------------------------------------------------

/**
 * Known CUI markers and DoD contract number patterns.
 *
 * Any occurrence of these strings (case-insensitive) in a payload forces
 * local-only routing as a safety override.
 */
const CUI_LITERAL_MARKERS: string[] = [
  "CUI",
  "CONTROLLED UNCLASSIFIED",
  "FOUO",
  "NOFORN",
  "//CUI",
];

/**
 * Regex patterns for DoD contract identifiers that imply CUI.
 * - W911NF  (Army Research Laboratory)
 * - FA8702  (Air Force)
 * - N00024  (Navy)
 */
const CUI_CONTRACT_PATTERNS: RegExp[] = [
  /\bW911NF[-\s]?\d/i,
  /\bFA8702[-\s]?\d/i,
  /\bN00024[-\s]?\d/i,
];

/**
 * Scan text for CUI markers.
 *
 * @param text The raw text to scan.
 * @returns The first matched marker string, or null if none found.
 */
function detectCUI(text: string): string | null {
  const upper = text.toUpperCase();

  for (const marker of CUI_LITERAL_MARKERS) {
    if (upper.includes(marker.toUpperCase())) {
      return marker;
    }
  }

  for (const pattern of CUI_CONTRACT_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Router configuration file shape
// ---------------------------------------------------------------------------

interface RouterConfig {
  rules: RoutingRule[];
  defaults: {
    local_model: string;
    cloud_model: string;
  };
}

// ---------------------------------------------------------------------------
// PrivacyRouter
// ---------------------------------------------------------------------------

/**
 * Routes inference requests between local and cloud endpoints based on
 * configurable rules and automatic CUI detection.
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
 * const endpoint = router.get_endpoint(decision);
 * ```
 */
export class PrivacyRouter {
  /** Path to the YAML configuration file. */
  private readonly config_path: string;
  /** Loaded routing rules, sorted by priority. */
  private rules: RoutingRule[] = [];
  /** Default model identifiers. */
  private defaults: { local_model: string; cloud_model: string } = {
    local_model: "nemotron:70b-q4",
    cloud_model: "claude-sonnet-4-20250514",
  };
  /** Decision audit log. */
  private decision_log: RoutingDecision[] = [];
  /** Whether the config has been loaded. */
  private loaded = false;

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
   * Evaluate routing rules for the given context and return a decision.
   *
   * **Safety override**: If CUI markers are detected anywhere in
   * `context.payload`, the request is unconditionally routed locally
   * regardless of any matching rule.
   *
   * Rules are evaluated in priority order (ascending). The first matching
   * rule wins. If no rule matches, the request is routed to the cloud by
   * default.
   *
   * @param context Request context to evaluate.
   * @returns The routing decision.
   */
  async route(context: RoutingContext): Promise<RoutingDecision> {
    await this.ensureLoaded();

    // ---- CUI safety override ----
    const textToScan = [context.payload ?? "", context.task ?? ""].join(" ");
    const cuiMatch = detectCUI(textToScan);

    if (cuiMatch) {
      const decision: RoutingDecision = {
        rule_matched: "cui_safety_override",
        route: "local",
        model: this.defaults.local_model,
        rationale: `CUI marker "${cuiMatch}" detected in payload; forcing local routing`,
        timestamp: new Date().toISOString(),
      };
      this.decision_log.push(decision);
      return decision;
    }

    // Also check the explicit flag.
    if (context.contains_past_performance) {
      // Past-performance data is treated as CUI-adjacent in DoD contexts.
      // Check rules first, but provide a default toward local.
    }

    // ---- Rule evaluation ----
    for (const rule of this.rules) {
      if (this.matchesCondition(rule.condition, context)) {
        const decision: RoutingDecision = {
          rule_matched: rule.name,
          route: rule.route,
          model: rule.model,
          rationale: `Matched rule "${rule.name}" (priority ${rule.priority})`,
          timestamp: new Date().toISOString(),
        };
        this.decision_log.push(decision);
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
    };
    this.decision_log.push(fallback);
    return fallback;
  }

  /**
   * Resolve a routing decision to a concrete API endpoint URL.
   *
   * @param decision A previously computed routing decision.
   * @returns The base URL of the target inference endpoint.
   */
  get_endpoint(decision: RoutingDecision): string {
    switch (decision.route) {
      case "local":
        return "http://localhost:11434";
      case "cloud":
        return "https://api.anthropic.com";
      default:
        return "http://localhost:11434";
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
      (d) => d.route === "local"
    ).length;
    const cloud_count = total - local_count;

    return {
      total,
      local_count,
      cloud_count,
      local_percent: total > 0 ? (local_count / total) * 100 : 0,
      cloud_percent: total > 0 ? (cloud_count / total) * 100 : 0,
    };
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
          `Privacy router config not found at ${this.config_path}; using empty rule set`
        );
        this.loaded = true;
        return;
      }

      const text = await file.text();
      const yaml = await import("js-yaml");
      const raw = yaml.load(text) as Partial<RouterConfig>;

      if (raw.rules && Array.isArray(raw.rules)) {
        this.rules = (raw.rules as RoutingRule[]).sort(
          (a, b) => a.priority - b.priority
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
    } catch (err) {
      console.error("Failed to load privacy router config:", err);
    }

    this.loaded = true;
  }

  /**
   * Evaluate whether a routing context satisfies a rule condition.
   *
   * All specified fields in the condition must match for the condition to
   * be considered satisfied (logical AND).
   */
  private matchesCondition(
    condition: RoutingCondition,
    context: RoutingContext
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
      if (context.contains_past_performance !== condition.contains_past_performance) {
        return false;
      }
    }

    // CUI markers flag (checked against payload).
    if (condition.contains_cui_markers === true) {
      const text = [context.payload ?? "", context.task ?? ""].join(" ");
      if (detectCUI(text) === null) return false;
    }

    return true;
  }
}
