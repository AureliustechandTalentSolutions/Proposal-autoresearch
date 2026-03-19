/**
 * OPA RPC Handler
 *
 * Evaluates policies against Open Policy Agent for compliance scoring,
 * proposal evaluation, and constraint enforcement.
 *
 * Uses the OPA REST API:
 *   POST  /v1/data/{path}       - evaluate a policy with input
 *   GET   /v1/data/{path}       - query policy data without input
 *   PUT   /v1/policies/{id}     - upload / replace a Rego policy
 *   DELETE /v1/policies/{id}    - remove a policy
 *   GET   /v1/policies          - list all loaded policies
 *   GET   /health               - server health check
 */

import type {
  PolicyResult,
  ComplianceScore,
  RPCResponse,
} from "../../shared/types";

// ── Public request/response shapes ──────────────────────────────────────

export interface PolicyEvalRequest {
  /** Rego policy path, e.g. "compliance/nist_800_53" */
  policyPath: string;
  /** Input data for evaluation */
  input: Record<string, unknown>;
}

export interface BatchEvalRequest {
  /** Multiple policies to evaluate against the same input */
  policyPaths: string[];
  input: Record<string, unknown>;
}

export interface PolicyDocument {
  path: string;
  packageName: string;
  rules: string[];
  lastLoaded: number;
}

export interface PolicyUploadRequest {
  /** Policy ID (used in the OPA REST path) */
  id: string;
  /** Raw Rego source code */
  rego: string;
}

// ── OPA RPC class ───────────────────────────────────────────────────────

export class OpaRPC {
  private endpoint: string;
  private policyCache: Map<string, PolicyDocument> = new Map();
  private requestTimeoutMs: number;

  constructor(
    endpoint?: string,
    opts?: { requestTimeoutMs?: number },
  ) {
    this.endpoint =
      endpoint ?? process.env.OPA_ENDPOINT ?? "http://localhost:8181";
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 10_000;
  }

  // ── Evaluate ────────────────────────────────────────────────────────

  /**
   * Evaluate a single policy against the provided input.
   *
   * Sends a POST to `/v1/data/{policyPath}` with `{ "input": ... }`.
   */
  async evaluate(req: PolicyEvalRequest): Promise<RPCResponse<PolicyResult>> {
    try {
      const url = `${this.endpoint}/v1/data/${normalisePath(req.policyPath)}`;

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: req.input }),
      }, this.requestTimeoutMs);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `OPA evaluation failed (${response.status}): ${body || response.statusText}`,
        );
      }

      const data = (await response.json()) as { result?: Record<string, unknown> };

      // OPA returns `{ "result": { ... } }` when the path resolves.
      // If the package/rule doesn't exist the result key is undefined.
      if (data.result === undefined) {
        return {
          ok: true,
          data: {
            policyPath: req.policyPath,
            allowed: false,
            reason: "Policy path returned no result (undefined). Check that the policy is loaded.",
            details: {},
          },
        };
      }

      return {
        ok: true,
        data: this.parsePolicyResult(req.policyPath, data.result),
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Query (GET without input) ──────────────────────────────────────

  /**
   * Query policy data without providing input (GET).
   * Useful for reading base/default data documents.
   */
  async query(path: string): Promise<RPCResponse<Record<string, unknown>>> {
    try {
      const url = `${this.endpoint}/v1/data/${normalisePath(path)}`;

      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
      }, this.requestTimeoutMs);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `OPA query failed (${response.status}): ${body || response.statusText}`,
        );
      }

      const data = (await response.json()) as { result?: Record<string, unknown> };
      return { ok: true, data: data.result ?? {} };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Batch evaluate ─────────────────────────────────────────────────

  /**
   * Evaluate multiple policies against a single input in parallel.
   */
  async evaluateBatch(req: BatchEvalRequest): Promise<RPCResponse<PolicyResult[]>> {
    const results = await Promise.allSettled(
      req.policyPaths.map((path) =>
        this.evaluate({ policyPath: path, input: req.input }),
      ),
    );

    const policyResults: PolicyResult[] = [];
    const errors: string[] = [];

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok && result.value.data) {
        policyResults.push(result.value.data);
      } else if (result.status === "fulfilled" && !result.value.ok) {
        errors.push(result.value.error || "Unknown error");
      } else if (result.status === "rejected") {
        errors.push(String(result.reason));
      }
    }

    return { ok: true, data: policyResults };
  }

  // ── Compliance scan ────────────────────────────────────────────────

  /**
   * Run a full compliance scan across all compliance policies.
   */
  async runComplianceScan(
    input: Record<string, unknown>,
  ): Promise<RPCResponse<ComplianceScore>> {
    const compliancePolicies = [
      "compliance/nist_800_53",
      "compliance/nist_800_171",
      "compliance/stig_k8s",
      "compliance/cmmc_l2",
      "compliance/sprs",
    ];

    const batchResult = await this.evaluateBatch({
      policyPaths: compliancePolicies,
      input,
    });

    if (!batchResult.ok || !batchResult.data) {
      return { ok: false, error: batchResult.error || "Batch evaluation failed" };
    }

    const findings = batchResult.data;
    const totalControls = findings.reduce((acc, f) => acc + (f.totalControls ?? 0), 0);
    const passingControls = findings.reduce((acc, f) => acc + (f.passingControls ?? 0), 0);
    const overallScore = totalControls > 0 ? (passingControls / totalControls) * 100 : 0;

    return {
      ok: true,
      data: {
        overallScore: Math.round(overallScore * 100) / 100,
        totalControls,
        passingControls,
        failingControls: totalControls - passingControls,
        findings,
        evaluatedAt: Date.now(),
      },
    };
  }

  // ── Framework score ────────────────────────────────────────────────

  /**
   * Query a specific compliance score by framework name.
   */
  async getFrameworkScore(
    framework: string,
    input: Record<string, unknown>,
  ): Promise<RPCResponse<PolicyResult>> {
    const frameworkMap: Record<string, string> = {
      nist_800_53: "compliance/nist_800_53",
      nist_800_171: "compliance/nist_800_171",
      stig_k8s: "compliance/stig_k8s",
      cmmc_l2: "compliance/cmmc_l2",
      sprs: "compliance/sprs",
    };

    const policyPath = frameworkMap[framework];
    if (!policyPath) {
      return { ok: false, error: `Unknown framework: ${framework}` };
    }

    return this.evaluate({ policyPath, input });
  }

  // ── Proposal evaluation ────────────────────────────────────────────

  /**
   * Evaluate proposal quality against proposal policies.
   */
  async evaluateProposal(
    input: Record<string, unknown>,
  ): Promise<RPCResponse<PolicyResult[]>> {
    const proposalPolicies = [
      "proposal/eval_rubric",
      "proposal/readability",
      "proposal/page_limits",
      "proposal/compliance_matrix",
    ];

    return this.evaluateBatch({ policyPaths: proposalPolicies, input });
  }

  // ── Constraint checks ─────────────────────────────────────────────

  /**
   * Check safety and constraint policies before an operation.
   */
  async checkConstraints(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<RPCResponse<{ allowed: boolean; violations: string[] }>> {
    const constraintPolicies = [
      "constraints/federal_proposal",
      "constraints/compliance_artifact",
      "constraints/safety",
    ];

    const result = await this.evaluateBatch({
      policyPaths: constraintPolicies,
      input: { operation, ...input },
    });

    if (!result.ok || !result.data) {
      return { ok: false, error: result.error || "Constraint check failed" };
    }

    const violations = result.data
      .filter((r) => !r.allowed)
      .map((r) => r.reason || `Policy violation: ${r.policyPath}`);

    return {
      ok: true,
      data: { allowed: violations.length === 0, violations },
    };
  }

  // ── Policy management (PUT / DELETE) ───────────────────────────────

  /**
   * Upload (create or replace) a Rego policy module.
   *
   * PUT /v1/policies/{id}
   */
  async uploadPolicy(req: PolicyUploadRequest): Promise<RPCResponse<void>> {
    try {
      const url = `${this.endpoint}/v1/policies/${encodeURIComponent(req.id)}`;

      const response = await fetchWithTimeout(url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: req.rego,
      }, this.requestTimeoutMs);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Policy upload failed (${response.status}): ${body || response.statusText}`,
        );
      }

      // Invalidate cache entry
      this.policyCache.delete(req.id);

      return { ok: true, data: undefined };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Delete a policy module by ID.
   *
   * DELETE /v1/policies/{id}
   */
  async deletePolicy(id: string): Promise<RPCResponse<void>> {
    try {
      const url = `${this.endpoint}/v1/policies/${encodeURIComponent(id)}`;

      const response = await fetchWithTimeout(url, {
        method: "DELETE",
      }, this.requestTimeoutMs);

      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        throw new Error(
          `Policy delete failed (${response.status}): ${body || response.statusText}`,
        );
      }

      this.policyCache.delete(id);
      return { ok: true, data: undefined };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── List policies ──────────────────────────────────────────────────

  /**
   * List all loaded policies.
   *
   * GET /v1/policies
   */
  async listPolicies(): Promise<RPCResponse<PolicyDocument[]>> {
    try {
      const response = await fetchWithTimeout(
        `${this.endpoint}/v1/policies`,
        { method: "GET", headers: { "Accept": "application/json" } },
        this.requestTimeoutMs,
      );

      if (!response.ok) {
        throw new Error(`Failed to list policies: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        result: Array<{ id: string; raw: string }>;
      };

      const policies: PolicyDocument[] = (data.result ?? []).map((p) => ({
        path: p.id,
        packageName: this.extractPackageName(p.raw),
        rules: this.extractRuleNames(p.raw),
        lastLoaded: Date.now(),
      }));

      for (const policy of policies) {
        this.policyCache.set(policy.path, policy);
      }

      return { ok: true, data: policies };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  // ── Health check ───────────────────────────────────────────────────

  /**
   * Check OPA server health and retrieve diagnostic info.
   *
   * GET /health?bundles=true&plugins=true
   */
  async healthCheck(): Promise<RPCResponse<{ healthy: boolean; version: string }>> {
    try {
      const response = await fetchWithTimeout(
        `${this.endpoint}/health?bundles=true`,
        { method: "GET" },
        5_000,
      );

      if (!response.ok) {
        return { ok: true, data: { healthy: false, version: "unknown" } };
      }

      // Try to get the version from the diagnostics endpoint
      let version = "latest";
      try {
        const diagResponse = await fetchWithTimeout(
          `${this.endpoint}/v1/config`,
          { method: "GET", headers: { "Accept": "application/json" } },
          3_000,
        );
        if (diagResponse.ok) {
          const diag = (await diagResponse.json()) as { result?: { labels?: { version?: string } } };
          version = diag.result?.labels?.version ?? "latest";
        }
      } catch {
        // Non-critical; keep "latest"
      }

      return { ok: true, data: { healthy: true, version } };
    } catch {
      return { ok: true, data: { healthy: false, version: "unreachable" } };
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private parsePolicyResult(
    policyPath: string,
    result: Record<string, unknown>,
  ): PolicyResult {
    return {
      policyPath,
      allowed: result.allow !== false && result.deny !== true,
      score: typeof result.score === "number" ? result.score : undefined,
      totalControls:
        typeof result.total_controls === "number" ? result.total_controls : undefined,
      passingControls:
        typeof result.passing_controls === "number" ? result.passing_controls : undefined,
      reason: typeof result.reason === "string" ? result.reason : undefined,
      details: result,
    };
  }

  private extractPackageName(raw: string): string {
    const match = raw.match(/^package\s+([\w.]+)/m);
    return match ? match[1] : "unknown";
  }

  private extractRuleNames(raw: string): string[] {
    const matches = raw.matchAll(/^(\w+)\s*(?:=|{|\[)/gm);
    return Array.from(matches, (m) => m[1]).filter(
      (name) => !["package", "import"].includes(name),
    );
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Normalise a policy path (strip leading/trailing slashes, collapse doubles).
 */
function normalisePath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

/**
 * Wrapper around `fetch` that respects a timeout via `AbortSignal.timeout`.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
