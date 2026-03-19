/**
 * OPA RPC Handler
 *
 * Evaluates policies against Open Policy Agent for compliance scoring,
 * proposal evaluation, and constraint enforcement.
 */

import type {
  PolicyResult,
  ComplianceScore,
  RPCResponse,
} from "../../shared/types";

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

export class OpaRPC {
  private endpoint: string;
  private policyCache: Map<string, PolicyDocument> = new Map();

  constructor(endpoint: string = "http://localhost:8181") {
    this.endpoint = endpoint;
  }

  /**
   * Evaluate a single policy against the provided input.
   */
  async evaluate(req: PolicyEvalRequest): Promise<RPCResponse<PolicyResult>> {
    try {
      const response = await fetch(
        `${this.endpoint}/v1/data/${req.policyPath.replace(/\//g, "/")}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: req.input }),
        },
      );

      if (!response.ok) {
        throw new Error(`OPA evaluation failed (${response.status}): ${response.statusText}`);
      }

      const data = (await response.json()) as { result: Record<string, unknown> };

      return {
        ok: true,
        data: this.parsePolicyResult(req.policyPath, data.result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

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

    return {
      ok: true,
      data: policyResults,
    };
  }

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

    return this.evaluateBatch({
      policyPaths: proposalPolicies,
      input,
    });
  }

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
      data: {
        allowed: violations.length === 0,
        violations,
      },
    };
  }

  /**
   * Check OPA server health.
   */
  async healthCheck(): Promise<RPCResponse<{ healthy: boolean; version: string }>> {
    try {
      const response = await fetch(`${this.endpoint}/health`);
      if (!response.ok) {
        return { ok: true, data: { healthy: false, version: "unknown" } };
      }
      return { ok: true, data: { healthy: true, version: "latest" } };
    } catch {
      return { ok: true, data: { healthy: false, version: "unreachable" } };
    }
  }

  /**
   * List all loaded policies.
   */
  async listPolicies(): Promise<RPCResponse<PolicyDocument[]>> {
    try {
      const response = await fetch(`${this.endpoint}/v1/policies`);
      if (!response.ok) {
        throw new Error(`Failed to list policies: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        result: Array<{ id: string; raw: string }>;
      };

      const policies: PolicyDocument[] = data.result.map((p) => ({
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
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  private parsePolicyResult(
    policyPath: string,
    result: Record<string, unknown>,
  ): PolicyResult {
    return {
      policyPath,
      allowed: result.allow !== false && result.deny !== true,
      score: typeof result.score === "number" ? result.score : undefined,
      totalControls: typeof result.total_controls === "number" ? result.total_controls : undefined,
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
