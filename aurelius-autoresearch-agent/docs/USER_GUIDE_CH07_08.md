# Aurelius Autoresearch Agent — User Guide

## Chapter 7: Scoring Engine

The scoring engine is the decision authority of the autoresearch loop. Every modification is accepted or rejected based on whether it improves the composite score.

---

### 7.1 Scorer Architecture

All scorers inherit from the `Scorer` base class (`scorers/__init__.py`) and implement:

- `score(artifact_content, context)` → `float` — Evaluate the artifact and return a score (0–100).
- `direction` — Either `higher_is_better` or `lower_is_better`.
- `describe()` — Human-readable description of the metric.

The `CompositeScorer` (`scorers/composite_scorer.py`) runs multiple scorers **in parallel** and returns a weighted sum.

### 7.2 Proposal Scorers

#### EvaluationAlignmentScorer

**Weight:** 0.35 (default)

Measures how well the proposal addresses FAR 15.305 evaluation factors. Takes a list of evaluation criteria (from the RFP's Section M) and uses the LLM to assess coverage of each factor.

**Inputs:** Evaluation criteria YAML, artifact content.

**Score:** Percentage of evaluation factors substantively addressed.

#### RequirementsTraceabilityScorer

**Weight:** 0.20

Checks that every PWS/SOW requirement has a traceable response in the proposal. Uses the LLM to map requirements to proposal sections.

**Inputs:** Requirements list (from Section C/L), artifact content.

**Score:** Percentage of requirements with traceable coverage.

#### ReadabilityScorer

**Weight:** 0.15

Calculates the Flesch-Kincaid grade level using the `textstat` library. The target range is grade 8–10, which balances clarity with technical precision.

**Scoring formula:**
- Grade 8.0 → 100 (optimal)
- Grade 10.0 → 100 (optimal)
- Each grade level outside [8, 10] reduces the score by 10 points

This is a **pure-compute scorer** — no LLM call required.

#### DiscriminatorDensityScorer

**Weight:** 0.15

Measures the density of unique competitive differentiators per page. Uses the LLM to identify and count distinct discriminators (features, capabilities, or approaches that distinguish the proposal from competitors).

**Score:** Normalized discriminator count per page, capped at 100.

#### WinThemeScorer

**Weight:** 0.10

Checks for the presence and reinforcement of predefined win themes throughout the proposal. Win themes are provided by the capture manager.

**Inputs:** Win theme list, artifact content.

**Score:** Percentage of win themes present and reinforced.

#### PageUtilizationScorer

**Weight:** 0.05

Measures how efficiently the available page budget is used. Penalizes both under-utilization (wasted space) and over-utilization (risk of exceeding limits).

**Optimal range:** 90–98% of page limit.

**Score:** 100 within optimal range, decreasing linearly outside.

### 7.3 Compliance Scorers

#### NistControlCoverageScorer

**Weight:** 0.40

Evaluates coverage of NIST SP 800-53 or 800-171 security controls. Takes a control family list and uses the LLM to assess whether each control is addressed with implementation details.

**Score:** Percentage of required controls with adequate implementation narrative.

#### StigPassRateScorer

**Weight:** 0.30

Assesses the pass rate against applicable STIG checklists. Uses the LLM to evaluate each finding as pass, fail, or not applicable.

**Score:** Pass count / (Pass count + Fail count) × 100.

#### PoamReductionScorer

**Weight:** 0.20

Measures progress in reducing open Plan of Action & Milestones (POA&M) items. Compares the current artifact's open items against a baseline.

**Score:** Reduction percentage relative to baseline POA&M count.

#### SprsScorer

**Weight:** 0.10

Calculates the Supplier Performance Risk System (SPRS) score based on NIST 800-171 assessment results. The DoD SPRS range is -203 to 110.

**Score:** Normalized to 0–100 scale: `(sprs_raw + 203) / 313 × 100`.

### 7.4 CompositeScorer

The `CompositeScorer` is a meta-scorer that:

1. Runs all configured sub-scorers **in parallel** via `asyncio.gather`.
2. Multiplies each sub-score by its weight.
3. Sums the weighted scores.
4. Returns a rounded composite score (0–100).

**Validation:** Weights must sum to 1.0 (tolerance: ±0.01).

#### Factory Methods

```python
# Federal compliance composite
scorer = CompositeScorer.federal_compliance(llm, controls_list)

# Federal proposal composite
scorer = CompositeScorer.federal_proposal(
    llm, eval_criteria, requirements, win_themes, max_pages=20
)
```

### 7.5 Interpreting Score Details

After scoring, call `scorer.get_details()` for a breakdown:

```python
details = scorer.get_details()
# {
#     "eval_alignment": {"score": 78.0, "weight": 0.35, "weighted": 27.30},
#     "traceability": {"score": 85.0, "weight": 0.20, "weighted": 17.00},
#     "readability": {"score": 92.0, "weight": 0.15, "weighted": 13.80},
#     "discriminators": {"score": 60.0, "weight": 0.15, "weighted": 9.00},
#     "win_themes": {"score": 70.0, "weight": 0.10, "weighted": 7.00},
#     "page_utilization": {"score": 95.0, "weight": 0.05, "weighted": 4.75},
# }
# Composite: 78.85
```

---

## Chapter 8: Policy Engine (OPA)

Open Policy Agent (OPA) enforces compliance rules, proposal rubrics, and safety constraints as machine-readable code.

---

### 8.1 How OPA Integrates

OPA runs as a sidecar service (`aurelius-opa`) and evaluates policies via its REST API:

```
POST http://opa:8181/v1/data/<package>/<rule>
Content-Type: application/json

{"input": { ... }}
```

The autoresearch loop calls OPA for:

1. **Constraint validation** — Before scoring, modifications are checked against constraint policies.
2. **Compliance scoring** — NIST, STIG, and CMMC policies produce structured assessment results.
3. **Proposal rubric evaluation** — FAR 15.305 rubrics score proposal sections.

### 8.2 Policy Directory Structure

```
policies/
├── compliance/
│   ├── nist_800_53.rego       # NIST SP 800-53 Rev 5 controls
│   ├── nist_800_171.rego      # NIST SP 800-171 (CUI)
│   ├── cmmc_l2.rego           # CMMC Level 2 assessment
│   ├── stig_k8s.rego          # Kubernetes STIGs
│   └── sprs.rego              # SPRS scoring algorithm
├── constraints/
│   ├── federal_proposal.rego  # Page limits, readability, anti-fabrication
│   ├── compliance_artifact.rego # YAML validity, evidence authenticity
│   └── safety.rego            # General safety guardrails
├── proposal/
│   ├── eval_rubric.rego       # FAR 15.305 evaluation rubric
│   ├── compliance_matrix.rego # Compliance matrix validation
│   ├── page_limits.rego       # Page utilization rules
│   └── readability.rego       # Readability target ranges
├── openshell/
│   ├── proposal-persona-agent.yaml
│   ├── compliance-agent.yaml
│   ├── hypothesis-agent.yaml
│   ├── modifier-agent.yaml
│   ├── rfp-parser-agent.yaml
│   ├── meta-learnings-agent.yaml
│   └── export-agent.yaml
└── sandbox/
    ├── level-1-supervised.yaml
    ├── level-2-guided.yaml
    └── level-3-autonomous.yaml
```

### 8.3 Compliance Policies

#### NIST 800-53 (`compliance/nist_800_53.rego`)

Evaluates an artifact against NIST SP 800-53 Rev 5 control families:

- Access Control (AC)
- Audit and Accountability (AU)
- Security Assessment and Authorization (CA)
- Configuration Management (CM)
- Identification and Authentication (IA)
- And all remaining families

**Input:** Artifact content with control implementation narratives.

**Output:** Per-control pass/fail assessment and overall coverage percentage.

#### NIST 800-171 (`compliance/nist_800_171.rego`)

Focused on the 110 CUI protection requirements. Aligns with CMMC Level 2.

#### CMMC Level 2 (`compliance/cmmc_l2.rego`)

Maps NIST 800-171 requirements to CMMC Level 2 practices and produces a maturity assessment.

#### Kubernetes STIGs (`compliance/stig_k8s.rego`)

Evaluates Kubernetes configuration artifacts against DISA STIG checklists.

#### SPRS (`compliance/sprs.rego`)

Calculates the SPRS score from NIST 800-171 assessment results. Implements the DoD scoring methodology (-203 to 110).

### 8.4 Proposal Policies

#### FAR 15.305 Evaluation Rubric (`proposal/eval_rubric.rego`)

Defines evaluation factor scoring based on FAR 15.305:

- **Outstanding** — Exceeds requirements with exceptional strengths
- **Good** — Meets requirements with some strengths
- **Acceptable** — Meets minimum requirements
- **Marginal** — Does not clearly meet some requirements
- **Unacceptable** — Fails to meet requirements

#### Compliance Matrix (`proposal/compliance_matrix.rego`)

Validates that the proposal addresses every requirement in the compliance matrix (Section L/M cross-reference).

#### Page Limits (`proposal/page_limits.rego`)

Enforces solicitation-specific page limits. Configurable per volume/section.

#### Readability (`proposal/readability.rego`)

Enforces Flesch-Kincaid grade level targets. Default target: 8–10.

### 8.5 Constraint Policies

#### Federal Proposal Constraints (`constraints/federal_proposal.rego`)

Hard guardrails for proposal optimization:

- Page limit enforcement (HALT on violation)
- Readability band enforcement (DISCARD on violation)
- Anti-fabrication checks (HALT on violation)
- Required section headers

#### Compliance Artifact Constraints (`constraints/compliance_artifact.rego`)

- YAML/JSON validity (HALT on invalid)
- Evidence authenticity markers
- Control ID format validation

#### Safety Guardrails (`constraints/safety.rego`)

General safety rules that prevent:

- Deletion of existing content beyond a threshold
- Introduction of known-bad patterns
- Excessive artifact growth

### 8.6 OpenShell Agent Policies

Each agent persona has a YAML policy file in `policies/openshell/` that defines:

- **Allowed actions** — Which file operations, network calls, and LLM interactions the agent can perform.
- **Resource limits** — CPU, memory, and time constraints.
- **Network restrictions** — Allowed/blocked hosts and ports.
- **Filesystem scope** — Read/write paths within the workspace.

Example (`proposal-persona-agent.yaml`):

```yaml
name: proposal-persona-writer
description: Writes and refines proposal sections
permissions:
  filesystem:
    read: ["/workspace/**"]
    write: ["/workspace/drafts/**"]
  network:
    allow: ["api.anthropic.com:443", "localhost:8181"]
  process:
    max_cpu_seconds: 300
    max_memory_mb: 2048
```

### 8.7 Sandbox Autonomy Levels

Three sandbox levels in `policies/sandbox/` map to the autonomy configuration:

| Level | File | Network | Filesystem | Approval |
|-------|------|---------|-----------|----------|
| 1 — Supervised | `level-1-supervised.yaml` | Blocked (except OPA) | Read-only | All actions |
| 2 — Guided | `level-2-guided.yaml` | Whitelisted hosts | Project directory | Writes only |
| 3 — Autonomous | `level-3-autonomous.yaml` | Open (audited) | Full workspace | None (audited) |

### 8.8 Adding Custom Policies

1. Create a new `.rego` file in the appropriate `policies/` subdirectory.
2. Define your package and rules following OPA conventions.
3. Restart the OPA container to load the new policy:

```bash
docker compose restart opa
```

4. Test your policy:

```bash
curl -X POST http://localhost:8181/v1/data/your_package/your_rule \
  -H "Content-Type: application/json" \
  -d '{"input": {"test": "data"}}'
```

### 8.9 Querying OPA Directly

For debugging or exploration:

```bash
# List loaded policies
curl http://localhost:8181/v1/policies

# Evaluate a specific rule
curl -X POST http://localhost:8181/v1/data/compliance/nist_800_53/coverage \
  -H "Content-Type: application/json" \
  -d '{"input": {"artifact": "...", "controls": ["AC-1", "AC-2"]}}'

# Check OPA health
curl http://localhost:8181/health
```
