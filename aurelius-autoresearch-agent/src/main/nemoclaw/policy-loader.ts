/**
 * @module policy-loader
 * @description YAML Policy Loader and Validator for NemoClaw.
 *
 * Loads OpenShell security policies from YAML files, validates them against
 * strict Zod schemas, and provides an access-checking API that evaluates
 * filesystem glob patterns and network host:port rules.
 *
 * Dependencies: zod, js-yaml, picomatch.
 */

import { z } from "zod";
import yaml from "js-yaml";
import picomatch from "picomatch";

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Filesystem permission rules.
 *
 * `allowed_paths` and `denied_paths` accept glob patterns (e.g. "/tmp/**").
 * `read_only_paths` is a subset of allowed paths that may only be read.
 */
export const FilesystemPermissions = z.object({
  /** Glob patterns for paths the agent may access. */
  allowed_paths: z.array(z.string()).default([]),
  /** Glob patterns for paths the agent must never access. Checked first. */
  denied_paths: z.array(z.string()).default([]),
  /** Glob patterns for paths restricted to read-only access. */
  read_only_paths: z.array(z.string()).default([]),
  /** Maximum total disk usage in megabytes (0 = unlimited). */
  max_disk_mb: z.number().nonnegative().default(0),
});

/**
 * Network permission rules.
 *
 * Hosts are expressed as `host:port` strings. A wildcard port (`host:*`) allows
 * all ports on that host.
 */
export const NetworkPermissions = z.object({
  /** Whether outbound networking is permitted at all. */
  enabled: z.boolean().default(false),
  /** Allowed destination host:port pairs. */
  allowed_hosts: z.array(z.string()).default([]),
  /** Blocked destination host:port pairs (checked first). */
  blocked_hosts: z.array(z.string()).default([]),
  /** Maximum outbound bandwidth in KB/s (0 = unlimited). */
  max_bandwidth_kbps: z.number().nonnegative().default(0),
});

/**
 * Tool-level permission rules.
 *
 * Each tool name maps to a boolean (allowed / denied).
 */
export const ToolPermissions = z.object({
  /** Explicitly allowed tool identifiers. */
  allowed_tools: z.array(z.string()).default([]),
  /** Explicitly denied tool identifiers (checked first). */
  denied_tools: z.array(z.string()).default([]),
  /** Whether tools not listed in either array are allowed. */
  default_allow: z.boolean().default(false),
});

/** Hard resource caps enforced by the sandbox runtime. */
export const ResourceLimits = z.object({
  /** Maximum memory in megabytes. */
  memory_mb: z.number().positive().default(512),
  /** Maximum CPU cores (fractional, e.g. 0.5). */
  cpu_cores: z.number().positive().default(1),
  /** Maximum disk usage in megabytes. */
  disk_mb: z.number().nonnegative().default(1024),
  /** Maximum wall-clock seconds for any single task. */
  max_task_seconds: z.number().positive().default(300),
  /** Maximum concurrent processes inside the sandbox. */
  max_processes: z.number().positive().int().default(16),
});

/** Top-level OpenShell policy document. */
export const OpenShellPolicy = z.object({
  /** Human-readable policy name. */
  name: z.string().min(1),
  /** Semantic version of the policy schema (e.g. "1.0.0"). */
  version: z.string().default("1.0.0"),
  /** Free-form description. */
  description: z.string().optional(),
  /** Filesystem permissions. */
  filesystem: FilesystemPermissions.default({}),
  /** Network permissions. */
  network: NetworkPermissions.default({}),
  /** Tool permissions. */
  tools: ToolPermissions.default({}),
  /** Resource limits. */
  resource_limits: ResourceLimits.default({}),
  /** Privacy mode: "local" forces all inference to stay on-device. */
  privacy_mode: z.enum(["local", "cloud", "hybrid"]).default("hybrid"),
  /** Arbitrary metadata. */
  metadata: z.record(z.unknown()).optional(),
});

/** Convenience type alias for a validated policy object. */
export type OpenShellPolicyType = z.infer<typeof OpenShellPolicy>;

// ---------------------------------------------------------------------------
// Access check types
// ---------------------------------------------------------------------------

export type AccessType = "filesystem_read" | "filesystem_write" | "network" | "tool";

export interface AccessCheckResult {
  /** Whether the access is permitted. */
  allowed: boolean;
  /** Human-readable reason explaining the decision. */
  reason: string;
}

// ---------------------------------------------------------------------------
// PolicyLoader
// ---------------------------------------------------------------------------

/**
 * Loads, validates, and queries OpenShell security policies.
 *
 * @example
 * ```ts
 * const loader = new PolicyLoader("/etc/nemoclaw/policies");
 * const policy = await loader.load("researcher");
 * const check = loader.check_access(policy, "filesystem_read", "/data/experiment.csv");
 * if (!check.allowed) console.warn(check.reason);
 * ```
 */
export class PolicyLoader {
  /** Cache of loaded and validated policies keyed by name. */
  private cache: Map<string, OpenShellPolicyType> = new Map();

  /**
   * @param policy_dir Absolute path to the directory containing YAML policy files.
   */
  constructor(private readonly policy_dir: string) {}

  /**
   * Load a single policy by name.
   *
   * The name is resolved to `<policy_dir>/<policy_name>.yaml` (the `.yaml`
   * extension is appended automatically if missing).
   *
   * @param policy_name Bare name or filename of the policy.
   * @returns Validated policy object.
   * @throws If the file cannot be read or fails schema validation.
   */
  async load(policy_name: string): Promise<OpenShellPolicyType> {
    const cached = this.cache.get(policy_name);
    if (cached) return cached;

    const filename = policy_name.endsWith(".yaml") || policy_name.endsWith(".yml")
      ? policy_name
      : `${policy_name}.yaml`;
    const full_path = `${this.policy_dir}/${filename}`;

    const file = Bun.file(full_path);
    const exists = await file.exists();
    if (!exists) {
      throw new Error(`Policy file not found: ${full_path}`);
    }

    const text = await file.text();
    const raw = yaml.load(text);
    const policy = this.validate(raw);

    this.cache.set(policy_name, policy);
    return policy;
  }

  /**
   * Load every `.yaml` / `.yml` file in the policy directory.
   *
   * @returns Map of filename (sans extension) to validated policy.
   */
  async load_all(): Promise<Map<string, OpenShellPolicyType>> {
    const results = new Map<string, OpenShellPolicyType>();
    const glob = new Bun.Glob("*.{yaml,yml}");

    for await (const entry of glob.scan({ cwd: this.policy_dir })) {
      const name = entry.replace(/\.(yaml|yml)$/, "");
      try {
        const policy = await this.load(name);
        results.set(name, policy);
      } catch (err) {
        console.warn(`Skipping invalid policy "${entry}":`, err);
      }
    }

    return results;
  }

  /**
   * Validate an unknown value against the OpenShellPolicy schema.
   *
   * @param policy Raw (typically YAML-parsed) value.
   * @returns Validated policy object.
   * @throws ZodError on validation failure.
   */
  validate(policy: unknown): OpenShellPolicyType {
    return OpenShellPolicy.parse(policy);
  }

  /**
   * Check whether a specific access request is permitted by a policy.
   *
   * Evaluation logic:
   * - **filesystem_read / filesystem_write**: denied_paths are checked first
   *   via glob matching. Then allowed_paths must match. For writes,
   *   read_only_paths are additionally checked.
   * - **network**: `blocked_hosts` checked first, then `allowed_hosts`.
   *   Supports `host:port` and `host:*` patterns.
   * - **tool**: `denied_tools` first, then `allowed_tools`, then `default_allow`.
   *
   * @param policy Validated policy object.
   * @param access_type The category of access being requested.
   * @param resource The specific resource (path, host:port, or tool name).
   * @returns Whether the access is allowed and why.
   */
  check_access(
    policy: OpenShellPolicyType,
    access_type: AccessType,
    resource: string
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
        return { allowed: false, reason: `Unknown access type: ${access_type}` };
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Evaluate filesystem access using glob matching.
   *
   * Denied paths take precedence over allowed paths. Write requests are
   * additionally blocked if the path matches a read_only_paths pattern.
   */
  private checkFilesystem(
    policy: OpenShellPolicyType,
    path: string,
    isWrite: boolean
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
   *
   * The resource should be formatted as `host:port`. Wildcard ports (`host:*`)
   * are supported in policy rules.
   */
  private checkNetwork(
    policy: OpenShellPolicyType,
    resource: string
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
    tool: string
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
   * Rule entries may use `*` as a port wildcard.
   */
  private hostPortMatches(
    reqHost: string,
    reqPort: string,
    ruleEntry: string
  ): boolean {
    const [ruleHost, rulePort] = this.parseHostPort(ruleEntry);

    // Host comparison is case-insensitive.
    if (ruleHost.toLowerCase() !== reqHost.toLowerCase()) return false;

    // Wildcard port matches everything.
    if (rulePort === "*") return true;

    return rulePort === reqPort;
  }
}
