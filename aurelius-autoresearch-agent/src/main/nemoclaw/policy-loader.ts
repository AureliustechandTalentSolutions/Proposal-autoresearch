/**
 * @module policy-loader
 * @description YAML Policy Loader and Validator for NemoClaw.
 *
 * Loads OpenShell security policies from YAML files, validates them against
 * strict Zod schemas, and provides an access-checking API that evaluates
 * filesystem glob patterns and network host:port rules.
 *
 * Supports:
 * - Policy inheritance (base policy + overrides per autonomy level)
 * - Policy hot-reload via file watcher
 * - Default sandbox policies for each autonomy level
 *
 * Dependencies: zod, js-yaml, picomatch.
 */

import { z } from "zod";
import yaml from "js-yaml";
import picomatch from "picomatch";
import { watch } from "node:fs";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Filesystem permission rules.
 */
export const FilesystemPermissions = z.object({
  allowed_paths: z.array(z.string()).default([]),
  denied_paths: z.array(z.string()).default([]),
  read_only_paths: z.array(z.string()).default([]),
  max_disk_mb: z.number().nonnegative().default(0),
});

/**
 * Network permission rules.
 */
export const NetworkPermissions = z.object({
  enabled: z.boolean().default(false),
  allowed_hosts: z.array(z.string()).default([]),
  blocked_hosts: z.array(z.string()).default([]),
  max_bandwidth_kbps: z.number().nonnegative().default(0),
});

/**
 * Tool-level permission rules.
 */
export const ToolPermissions = z.object({
  allowed_tools: z.array(z.string()).default([]),
  denied_tools: z.array(z.string()).default([]),
  default_allow: z.boolean().default(false),
});

/** Hard resource caps enforced by the sandbox runtime. */
export const ResourceLimits = z.object({
  memory_mb: z.number().positive().default(512),
  cpu_cores: z.number().positive().default(1),
  disk_mb: z.number().nonnegative().default(1024),
  max_task_seconds: z.number().positive().default(300),
  max_processes: z.number().positive().int().default(16),
});

/** Top-level OpenShell policy document. */
export const OpenShellPolicy = z.object({
  name: z.string().min(1),
  version: z.string().default("1.0.0"),
  description: z.string().optional(),
  /** Optional parent policy name for inheritance. */
  inherits: z.string().optional(),
  filesystem: FilesystemPermissions.default({}),
  network: NetworkPermissions.default({}),
  tools: ToolPermissions.default({}),
  resource_limits: ResourceLimits.default({}),
  privacy_mode: z.enum(["local", "cloud", "hybrid"]).default("hybrid"),
  metadata: z.record(z.unknown()).optional(),
});

/** Convenience type alias for a validated policy object. */
export type OpenShellPolicyType = z.infer<typeof OpenShellPolicy>;

// ---------------------------------------------------------------------------
// Access check types
// ---------------------------------------------------------------------------

export type AccessType =
  | "filesystem_read"
  | "filesystem_write"
  | "network"
  | "tool";

export interface AccessCheckResult {
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Default sandbox policies for each autonomy level
// ---------------------------------------------------------------------------

const DEFAULT_POLICIES: Record<string, Partial<z.input<typeof OpenShellPolicy>>> = {
  "level-1-supervised": {
    name: "level-1-supervised",
    description: "Restrictive: no network, read-only FS, local-only LLM",
    filesystem: {
      allowed_paths: ["/workspace/**", "/tmp/nemoclaw-*/**"],
      denied_paths: ["/etc/**", "/var/**", "/home/**", "/root/**", "**/.env", "**/.ssh/**"],
      read_only_paths: ["/workspace/**"],
      max_disk_mb: 512,
    },
    network: { enabled: false, allowed_hosts: [], blocked_hosts: [], max_bandwidth_kbps: 0 },
    tools: {
      allowed_tools: ["file_read", "file_search", "text_analysis", "compliance_check"],
      denied_tools: ["shell_exec", "http_request", "file_write", "docker_exec"],
      default_allow: false,
    },
    resource_limits: { memory_mb: 512, cpu_cores: 1, disk_mb: 512, max_task_seconds: 120, max_processes: 4 },
    privacy_mode: "local",
    metadata: { autonomy_level: 1, label: "supervised" },
  },
  "level-2-guided": {
    name: "level-2-guided",
    description: "Standard: whitelisted endpoints, project-scoped FS",
    filesystem: {
      allowed_paths: ["/workspace/**", "/tmp/nemoclaw-*/**", "/data/models/**"],
      denied_paths: ["/etc/shadow", "/root/**", "**/.env", "**/.ssh/**"],
      read_only_paths: ["/workspace/rfps/**", "/data/models/**"],
      max_disk_mb: 2048,
    },
    network: {
      enabled: true,
      allowed_hosts: ["api.anthropic.com:443", "localhost:11434", "localhost:9000"],
      blocked_hosts: ["*.onion:*", "pastebin.com:*"],
      max_bandwidth_kbps: 10240,
    },
    tools: {
      allowed_tools: ["file_read", "file_write", "file_search", "text_analysis", "compliance_check", "http_request"],
      denied_tools: ["shell_exec", "docker_exec", "git_push"],
      default_allow: false,
    },
    resource_limits: { memory_mb: 2048, cpu_cores: 2, disk_mb: 4096, max_task_seconds: 600, max_processes: 16 },
    privacy_mode: "hybrid",
    metadata: { autonomy_level: 2, label: "guided" },
  },
  "level-3-autonomous": {
    name: "level-3-autonomous",
    description: "Permissive but audited: broad access, full logging",
    filesystem: {
      allowed_paths: ["/workspace/**", "/tmp/**", "/data/**"],
      denied_paths: ["/etc/shadow", "/root/**", "**/.ssh/id_*"],
      read_only_paths: ["/data/models/**"],
      max_disk_mb: 10240,
    },
    network: {
      enabled: true,
      allowed_hosts: ["api.anthropic.com:443", "api.openai.com:443", "localhost:*", "sam.gov:443"],
      blocked_hosts: ["*.onion:*", "pastebin.com:*"],
      max_bandwidth_kbps: 51200,
    },
    tools: {
      allowed_tools: ["file_read", "file_write", "file_search", "file_delete", "text_analysis", "compliance_check", "http_request", "shell_exec"],
      denied_tools: ["docker_exec", "git_push"],
      default_allow: false,
    },
    resource_limits: { memory_mb: 8192, cpu_cores: 4, disk_mb: 20480, max_task_seconds: 1800, max_processes: 64 },
    privacy_mode: "hybrid",
    metadata: { autonomy_level: 3, label: "autonomous" },
  },
};

// ---------------------------------------------------------------------------
// PolicyLoader
// ---------------------------------------------------------------------------

/**
 * Loads, validates, and queries OpenShell security policies.
 * Supports policy inheritance and file watching for hot-reload.
 *
 * @example
 * ```ts
 * const loader = new PolicyLoader("/etc/nemoclaw/policies");
 * await loader.start_watching(); // Enable hot-reload
 * const policy = await loader.load("level-2-guided");
 * const check = loader.check_access(policy, "filesystem_read", "/data/experiment.csv");
 * if (!check.allowed) console.warn(check.reason);
 * ```
 */
export class PolicyLoader {
  /** Cache of loaded and validated policies keyed by name. */
  private cache: Map<string, OpenShellPolicyType> = new Map();

  /** File system watcher for hot-reload. */
  private watcher: ReturnType<typeof watch> | null = null;

  /** Registered reload handlers. */
  private reload_handlers: Array<(name: string, policy: OpenShellPolicyType) => void> = [];

  /**
   * @param policy_dir Absolute path to the directory containing YAML policy files.
   */
  constructor(private readonly policy_dir: string) {}

  /**
   * Load a single policy by name.
   *
   * Supports policy inheritance: if a policy has an `inherits` field,
   * the parent policy is loaded first and the child overrides are merged.
   */
  async load(policy_name: string): Promise<OpenShellPolicyType> {
    const cached = this.cache.get(policy_name);
    if (cached) return cached;

    // Check if this is a default built-in policy.
    const defaultPolicy = DEFAULT_POLICIES[policy_name];

    const filename =
      policy_name.endsWith(".yaml") || policy_name.endsWith(".yml")
        ? policy_name
        : `${policy_name}.yaml`;
    const full_path = `${this.policy_dir}/${filename}`;

    let raw: unknown;

    const file = Bun.file(full_path);
    const exists = await file.exists();

    if (exists) {
      const text = await file.text();
      raw = yaml.load(text);
    } else if (defaultPolicy) {
      // Use built-in default policy.
      raw = defaultPolicy;
    } else {
      throw new Error(`Policy file not found: ${full_path}`);
    }

    // Handle inheritance.
    const rawObj = raw as Record<string, unknown>;
    if (rawObj.inherits && typeof rawObj.inherits === "string") {
      const parentPolicy = await this.load(rawObj.inherits);
      raw = this.mergePolicy(parentPolicy, rawObj);
    }

    const policy = this.validate(raw);

    this.cache.set(policy_name, policy);
    return policy;
  }

  /**
   * Load every `.yaml` / `.yml` file in the policy directory,
   * plus all built-in default policies.
   */
  async load_all(): Promise<Map<string, OpenShellPolicyType>> {
    const results = new Map<string, OpenShellPolicyType>();

    // Load built-in defaults first.
    for (const [name, rawPolicy] of Object.entries(DEFAULT_POLICIES)) {
      try {
        const policy = this.validate(rawPolicy);
        results.set(name, policy);
        this.cache.set(name, policy);
      } catch (err) {
        console.warn(`Skipping invalid default policy "${name}":`, err);
      }
    }

    // Load file-based policies (overriding defaults if same name).
    try {
      const glob = new Bun.Glob("*.{yaml,yml}");
      for await (const entry of glob.scan({ cwd: this.policy_dir })) {
        const name = entry.replace(/\.(yaml|yml)$/, "");
        try {
          // Clear cache to force re-read from disk.
          this.cache.delete(name);
          const policy = await this.load(name);
          results.set(name, policy);
        } catch (err) {
          console.warn(`Skipping invalid policy "${entry}":`, err);
        }
      }
    } catch (err) {
      console.warn(
        `[PolicyLoader] Could not scan policy directory ${this.policy_dir}:`,
        err,
      );
    }

    return results;
  }

  /**
   * List all available policy names (file-based and built-in).
   */
  async list(): Promise<Array<{ name: string; path: string; builtin: boolean }>> {
    const policies: Array<{ name: string; path: string; builtin: boolean }> = [];

    // Built-in policies.
    for (const name of Object.keys(DEFAULT_POLICIES)) {
      policies.push({
        name,
        path: `[built-in]/${name}`,
        builtin: true,
      });
    }

    // File-based policies.
    try {
      const glob = new Bun.Glob("*.{yaml,yml}");
      for await (const entry of glob.scan({ cwd: this.policy_dir })) {
        const name = entry.replace(/\.(yaml|yml)$/, "");
        // Check if it overrides a built-in.
        const existingIdx = policies.findIndex((p) => p.name === name);
        if (existingIdx >= 0) {
          policies[existingIdx] = {
            name,
            path: `${this.policy_dir}/${entry}`,
            builtin: false,
          };
        } else {
          policies.push({
            name,
            path: `${this.policy_dir}/${entry}`,
            builtin: false,
          });
        }
      }
    } catch {
      // Directory may not exist yet.
    }

    return policies;
  }

  /**
   * Validate an unknown value against the OpenShellPolicy schema.
   */
  validate(policy: unknown): OpenShellPolicyType {
    return OpenShellPolicy.parse(policy);
  }

  /**
   * Get a policy for a specific autonomy level (1, 2, or 3).
   */
  async get_for_autonomy_level(level: number): Promise<OpenShellPolicyType> {
    switch (level) {
      case 1:
        return this.load("level-1-supervised");
      case 2:
        return this.load("level-2-guided");
      case 3:
        return this.load("level-3-autonomous");
      default:
        return this.load("level-1-supervised"); // Default to most restrictive.
    }
  }

  /**
   * Check whether a specific access request is permitted by a policy.
   */
  check_access(
    policy: OpenShellPolicyType,
    access_type: AccessType,
    resource: string,
  ): AccessCheckResult {
    switch (access_type) {
      case "filesystem_read":
        return this.checkFilesystem(policy, resource, false);
      case "filesystem_write":
        return this.checkFilesystem(policy, resource, true);
      case "network":
        return this.checkNetwork(policy, resource);
      case "tool":
        return this.checkTool(policy, resource);
      default:
        return {
          allowed: false,
          reason: `Unknown access type: ${access_type}`,
        };
    }
  }

  /**
   * Start watching the policy directory for changes (hot-reload).
   * When a policy file changes, it is re-loaded, re-validated, and
   * registered handlers are notified.
   */
  async start_watching(): Promise<void> {
    if (this.watcher) return;

    try {
      this.watcher = watch(
        this.policy_dir,
        { recursive: false },
        async (eventType, filename) => {
          if (!filename) return;
          if (!filename.endsWith(".yaml") && !filename.endsWith(".yml")) return;

          const name = filename.replace(/\.(yaml|yml)$/, "");
          console.log(
            `[PolicyLoader] Detected ${eventType} on ${filename}; reloading...`,
          );

          // Clear cache for this policy (and any that inherit from it).
          this.cache.delete(name);
          this.invalidateDependents(name);

          try {
            const policy = await this.load(name);
            console.log(
              `[PolicyLoader] Reloaded policy "${name}" successfully.`,
            );

            // Notify handlers.
            for (const handler of this.reload_handlers) {
              try {
                handler(name, policy);
              } catch {
                // Swallow handler errors.
              }
            }
          } catch (err) {
            console.error(
              `[PolicyLoader] Failed to reload policy "${name}":`,
              err,
            );
          }
        },
      );

      console.log(`[PolicyLoader] Watching ${this.policy_dir} for changes.`);
    } catch (err) {
      console.warn(
        `[PolicyLoader] Could not watch ${this.policy_dir}:`,
        err,
      );
    }
  }

  /**
   * Stop watching for policy changes.
   */
  stop_watching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Register a handler for policy reload events.
   */
  on_reload(
    handler: (name: string, policy: OpenShellPolicyType) => void,
  ): void {
    this.reload_handlers.push(handler);
  }

  /**
   * Clear the policy cache, forcing re-load from disk on next access.
   */
  clear_cache(): void {
    this.cache.clear();
  }

  /**
   * Clean up: stop watcher and clear cache.
   */
  destroy(): void {
    this.stop_watching();
    this.clear_cache();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Deep merge a parent policy with child overrides.
   * Child values take precedence. Arrays are replaced (not concatenated).
   */
  private mergePolicy(
    parent: OpenShellPolicyType,
    child: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...parent };

    for (const [key, value] of Object.entries(child)) {
      if (key === "inherits") continue; // Don't propagate the inherits field.

      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        merged[key] !== null &&
        typeof merged[key] === "object" &&
        !Array.isArray(merged[key])
      ) {
        // Deep merge objects.
        merged[key] = {
          ...(merged[key] as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }

  /**
   * Invalidate cached policies that inherit from the given policy name.
   */
  private invalidateDependents(parentName: string): void {
    for (const [name, policy] of this.cache) {
      // Check if this policy's raw source has an `inherits` matching parentName.
      // Since we validate on load, we rely on metadata.
      if ((policy.metadata as any)?.inherits === parentName) {
        this.cache.delete(name);
        this.invalidateDependents(name); // Recursive invalidation.
      }
    }
  }

  /**
   * Evaluate filesystem access using glob matching.
   */
  private checkFilesystem(
    policy: OpenShellPolicyType,
    path: string,
    isWrite: boolean,
  ): AccessCheckResult {
    const fs = policy.filesystem;

    // 1. Check denied paths first.
    for (const pattern of fs.denied_paths) {
      if (picomatch.isMatch(path, pattern)) {
        return {
          allowed: false,
          reason: `Path "${path}" matches denied pattern "${pattern}"`,
        };
      }
    }

    // 2. Check allowed paths.
    let isAllowed = false;
    let matchedPattern = "";
    for (const pattern of fs.allowed_paths) {
      if (picomatch.isMatch(path, pattern)) {
        isAllowed = true;
        matchedPattern = pattern;
        break;
      }
    }

    if (!isAllowed) {
      return {
        allowed: false,
        reason: `Path "${path}" does not match any allowed pattern`,
      };
    }

    // 3. For writes, check read-only paths.
    if (isWrite) {
      for (const pattern of fs.read_only_paths) {
        if (picomatch.isMatch(path, pattern)) {
          return {
            allowed: false,
            reason: `Path "${path}" matches read-only pattern "${pattern}"; writes are denied`,
          };
        }
      }
    }

    return {
      allowed: true,
      reason: `Path "${path}" allowed by pattern "${matchedPattern}"${isWrite ? " (write)" : " (read)"}`,
    };
  }

  /**
   * Evaluate network access against host:port rules.
   */
  private checkNetwork(
    policy: OpenShellPolicyType,
    resource: string,
  ): AccessCheckResult {
    const net = policy.network;

    if (!net.enabled) {
      return {
        allowed: false,
        reason: "Network access is disabled by policy",
      };
    }

    const [reqHost, reqPort] = this.parseHostPort(resource);

    // 1. Blocked hosts first.
    for (const entry of net.blocked_hosts) {
      if (this.hostPortMatches(reqHost, reqPort, entry)) {
        return {
          allowed: false,
          reason: `"${resource}" matches blocked host rule "${entry}"`,
        };
      }
    }

    // 2. Allowed hosts.
    for (const entry of net.allowed_hosts) {
      if (this.hostPortMatches(reqHost, reqPort, entry)) {
        return {
          allowed: true,
          reason: `"${resource}" allowed by host rule "${entry}"`,
        };
      }
    }

    return {
      allowed: false,
      reason: `"${resource}" does not match any allowed host rule`,
    };
  }

  /** Evaluate tool access. */
  private checkTool(
    policy: OpenShellPolicyType,
    tool: string,
  ): AccessCheckResult {
    const tp = policy.tools;

    if (tp.denied_tools.includes(tool)) {
      return { allowed: false, reason: `Tool "${tool}" is explicitly denied` };
    }

    if (tp.allowed_tools.includes(tool)) {
      return { allowed: true, reason: `Tool "${tool}" is explicitly allowed` };
    }

    if (tp.default_allow) {
      return {
        allowed: true,
        reason: `Tool "${tool}" allowed by default_allow policy`,
      };
    }

    return {
      allowed: false,
      reason: `Tool "${tool}" is not in the allowed list and default_allow is false`,
    };
  }

  /** Parse a `host:port` string into its components. */
  private parseHostPort(value: string): [string, string] {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) return [value, "*"];
    return [value.slice(0, lastColon), value.slice(lastColon + 1)];
  }

  /**
   * Check whether a request (host, port) matches a policy rule entry.
   * Rule entries may use `*` as a port or host wildcard.
   */
  private hostPortMatches(
    reqHost: string,
    reqPort: string,
    ruleEntry: string,
  ): boolean {
    const [ruleHost, rulePort] = this.parseHostPort(ruleEntry);

    // Host comparison: support wildcard prefix (e.g. "*.onion").
    if (ruleHost.startsWith("*.")) {
      const suffix = ruleHost.slice(1).toLowerCase(); // e.g. ".onion"
      if (!reqHost.toLowerCase().endsWith(suffix)) return false;
    } else {
      if (ruleHost.toLowerCase() !== reqHost.toLowerCase()) return false;
    }

    // Wildcard port matches everything.
    if (rulePort === "*") return true;

    return rulePort === reqPort;
  }
}
