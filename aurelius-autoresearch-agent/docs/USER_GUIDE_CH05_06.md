# Aurelius Autoresearch Agent — User Guide

## Chapter 5: Configuration

This chapter covers every configuration surface — environment variables, YAML presets, scorer weights, constraints, autonomy levels, and privacy routing rules.

---

### 5.1 Environment Variables

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

#### LLM Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Your Anthropic API key (required for Claude) |
| `LLM_PROVIDER` | `auto` | Provider selection: `auto`, `claude`, `openai`, `ollama` |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | Default cloud model |
| `LOCAL_MODEL` | `nemotron:latest` | Default local model for privacy routing |

When `LLM_PROVIDER=auto`, the system uses the privacy router to decide per-request whether to call cloud or local models.

#### NemoClaw Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSHELL_ENDPOINT` | `http://localhost:2376` | OpenShell sandbox API |
| `PRIVACY_ROUTER_CONFIG` | `local-first` | Routing mode: `local-first`, `cloud`, `hybrid` |
| `AUTONOMY_CONFIG` | `supervised` | Autonomy level: `supervised`, `guided`, `fully_autonomous` |

#### Infrastructure

| Variable | Default | Description |
|----------|---------|-------------|
| `OPA_ENDPOINT` | `http://localhost:8181` | OPA server URL |
| `OPA_PORT` | `8181` | OPA listen port |
| `OPA_LOG_LEVEL` | `info` | OPA log verbosity |
| `MINIO_ENDPOINT` | `http://localhost:9000` | MinIO S3 API |
| `MINIO_API_PORT` | `9000` | MinIO API port |
| `MINIO_CONSOLE_PORT` | `9001` | MinIO web console port |
| `MINIO_USER` | `aurelius` | MinIO root user |
| `MINIO_PASSWORD` | `changeme123` | MinIO root password (**change in production**) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_MAXMEMORY` | `256mb` | Redis memory limit |
| `TRIGGER_API_KEY` | `tr_dev_placeholder` | Trigger.dev API key |
| `TRIGGER_API_URL` | `http://localhost:3030` | Trigger.dev server URL |
| `TRIGGER_PROJECT_ID` | `aurelius-workbench` | Trigger.dev project ID |
| `OLLAMA_ENDPOINT` | `http://localhost:11434` | Ollama server URL |
| `DASHBOARD_PORT` | `8501` | Dashboard listen port |

---

### 5.2 YAML Configuration Presets

Configuration files live in `config/`. The CLI loads them via `--config`:

```bash
aurelius-autoresearch run --config config/proposal.yaml --target workspace/draft.md
```

#### `config/default.yaml` — Base Defaults

```yaml
mode: proposal
max_iterations: 25
threshold: 90.0
llm_provider: claude
llm_model: claude-sonnet-4-20250514
constraints: []
scorer_weights: {}
```

#### `config/proposal.yaml` — Proposal Optimization

Override default for proposal-specific runs. Typically sets:

- `mode: proposal`
- Higher iteration count for large volumes
- Scorer weights tuned for FAR 15.305

#### `config/compliance.yaml` — Compliance Optimization

- `mode: compliance`
- NIST/STIG-focused scorer weights
- Compliance-specific constraints (valid YAML, no fabricated evidence)

#### `config/proposal-presets.yaml` — Detailed Proposal Weights

Contains named presets for different acquisition types:

- **best-value** — Balanced across evaluation alignment, traceability, and readability
- **lpta** — Emphasizes compliance matrix and page utilization
- **oral-presentation** — Higher readability weight, lower page utilization

#### `config/compliance-presets.yaml` — Compliance Target Presets

Named presets for different compliance frameworks:

- **nist-800-53** — Full NIST 800-53 Rev 5 control family coverage
- **nist-800-171** — CUI protection focus (110 controls)
- **cmmc-l2** — CMMC Level 2 maturity assessment
- **stig-k8s** — Kubernetes STIG hardening

---

### 5.3 Scorer Weights

The `CompositeScorer` combines multiple metric scorers with weights that must sum to 1.0.

#### Proposal Mode Default Weights

| Scorer | Weight | Measures |
|--------|--------|----------|
| `eval_alignment` | 0.35 | Alignment to FAR 15.305 evaluation factors |
| `traceability` | 0.20 | PWS/SOW requirement traceability |
| `readability` | 0.15 | Flesch-Kincaid grade level (target: 8–10) |
| `discriminators` | 0.15 | Density of unique competitive differentiators |
| `win_themes` | 0.10 | Win theme presence and reinforcement |
| `page_utilization` | 0.05 | How efficiently page limits are used |

#### Compliance Mode Default Weights

| Scorer | Weight | Measures |
|--------|--------|----------|
| `nist_coverage` | 0.40 | Percentage of NIST controls addressed |
| `stig_pass` | 0.30 | STIG checklist pass rate |
| `poam_reduction` | 0.20 | Reduction in open POA&M items |
| `sprs_normalized` | 0.10 | Normalized SPRS score (0–110 → 0–100) |

To override weights in your config YAML:

```yaml
scorer_weights:
  eval_alignment: 0.40
  traceability: 0.25
  readability: 0.10
  discriminators: 0.10
  win_themes: 0.10
  page_utilization: 0.05
```

---

### 5.4 Constraints

Constraints are hard guardrails that block or halt modifications. Each constraint has an `on_violation` action:

- **DISCARD** — The modification is rejected but the loop continues.
- **HALT** — The loop stops immediately.

#### Federal Proposal Constraints (built-in)

| Constraint | Type | Parameters | On Violation |
|-----------|------|-----------|-------------|
| Page Limit | `page_limit` | `max_pages: 20`, `words_per_page: 250` | HALT |
| Readability | `readability_range` | `min: 8`, `max: 10` | DISCARD |
| No Fabrication | `no_fabrication` | `enabled: true` | HALT |

#### Compliance Constraints (built-in)

| Constraint | Type | Parameters | On Violation |
|-----------|------|-----------|-------------|
| Valid YAML | `file_valid` | `type: yaml` | HALT |
| No Fabricated Evidence | `no_fabrication` | `enabled: true` | HALT |

#### Custom Constraints

Add constraints to your config file using the `constraints` key:

```yaml
constraints:
  - name: "Section L compliance"
    validation_type: "contains_required"
    parameters:
      required_strings:
        - "Technical Approach"
        - "Management Approach"
        - "Past Performance"
    on_violation: "DISCARD"

  - name: "Max word count"
    validation_type: "word_count"
    parameters:
      max: 5000
    on_violation: "HALT"
```

Available validation types: `word_count`, `page_limit`, `readability_range`, `contains_required`, `no_fabrication`, `custom_regex`, `file_valid`.

---

### 5.5 Autonomy Levels

The autonomy configuration (`config/autonomy.yaml`) defines how much human oversight the system requires.

#### Level 1: Supervised (Default)

Every action requires explicit approval. Best for initial deployment.

```yaml
requires_approval:
  - hypothesis_generation
  - artifact_modification
  - compliance_evaluation
  - proposal_drafting
  - export_rendering
```

#### Level 2: Guided

Read-only and evaluation tasks run autonomously; modifications require approval.

```yaml
requires_approval:
  - artifact_modification
  - proposal_drafting
  - export_rendering
autonomous:
  - hypothesis_generation
  - compliance_evaluation
  - learnings_consolidation
```

#### Level 3: Fully Autonomous

All tasks run without intervention. Use only after the system has proven reliable.

```yaml
requires_approval: []
autonomous:
  - hypothesis_generation
  - artifact_modification
  - compliance_evaluation
  - proposal_drafting
  - export_rendering
  - learnings_consolidation
```

Set the level via environment variable:

```bash
AUTONOMY_CONFIG=guided
```

---

### 5.6 Privacy Router Configuration

The privacy router (`config/privacy-router.yaml`) controls which LLM handles each request. Rules are evaluated by priority (ascending); the first match wins.

#### CUI Detection

The router scans payloads for CUI markers (`CUI`, `FOUO`, `NOFORN`, etc.) and federal contract number patterns (`W911NF`, `FA8702`, `N00024`, etc.). Any match forces local routing.

#### PII Detection

Patterns for SSN, email, phone, credit card, date of birth, address, passport number, ITAR, and EAR trigger elevated sensitivity classification.

#### Classification Levels

| Level | Label | Typical Routing |
|-------|-------|----------------|
| 1 | Public | Cloud allowed |
| 2 | Internal | Cloud in hybrid mode |
| 3 | Sensitive | Local in hybrid mode |
| 4 | CUI | Always local |
| 5 | Classified | Always local |

#### Default Safety Rule

If no rule matches, the **default-local-safety** rule routes to the local Nemotron model:

```yaml
- name: "default_local_safety"
  priority: 100
  condition: {}
  route: "local"
  model: "nemotron:70b-q4_K_M"
```

---

## Chapter 6: Running the Autoresearch Loop

### 6.1 CLI Quick Start

#### Start a Proposal Optimization Run

```bash
aurelius-autoresearch run \
  --mode proposal \
  --target workspace/technical-volume.md \
  --metric composite \
  --threshold 90.0 \
  --max-iterations 25
```

#### Start a Compliance Optimization Run

```bash
aurelius-autoresearch run \
  --mode compliance \
  --target workspace/ssp-controls.yaml \
  --metric nist_coverage \
  --threshold 95.0 \
  --max-iterations 50
```

#### Use a Config File

```bash
aurelius-autoresearch run \
  --config config/proposal.yaml \
  --target workspace/volume-1.md
```

#### Run in Daemon Mode

```bash
aurelius-autoresearch run \
  --config config/compliance.yaml \
  --target workspace/ssp.yaml \
  --daemon
```

### 6.2 CLI Commands Reference

| Command | Description |
|---------|-------------|
| `aurelius-autoresearch run` | Start an optimization loop |
| `aurelius-autoresearch status --run-id <id>` | Check progress of a running loop |
| `aurelius-autoresearch report --run-id <id>` | Display the final Markdown report |
| `aurelius-autoresearch dashboard` | Start the web dashboard on port 8501 |

### 6.3 Run Options

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--config` | No | — | Path to YAML config file |
| `--mode` | Yes* | — | `proposal` or `compliance` |
| `--target` | Yes | — | Path to the artifact to optimize |
| `--metric` | Yes* | — | Metric to optimize |
| `--threshold` | No | `90.0` | Score target (0–100) |
| `--max-iterations` | No | `25` | Maximum loop iterations |
| `--llm-provider` | No | `claude` | `claude`, `openai`, or `ollama` |
| `--llm-model` | No | `claude-sonnet-4-20250514` | Model identifier |
| `--eval-criteria` | No | — | Path to evaluation criteria YAML |
| `--daemon` | No | `false` | Run in background |

*Required when not using `--config`.

### 6.4 Understanding Run Output

A typical run produces output like:

```
Starting autoresearch loop.
  Run ID: a1b2c3d4
  Mode: proposal
  Target: workspace/technical-volume.md
  Threshold: 90.0
  Max iterations: 25

Baseline score: 62.50
--- Iteration 1/25 ---
  Testing: Strengthen technical approach section with specific...
  KEEP: score 65.30 (delta=+2.80)
--- Iteration 2/25 ---
  Testing: Add past performance relevance matrix linking...
  KEEP: score 68.10 (delta=+2.80)
--- Iteration 3/25 ---
  Using persona: capture_manager
  Testing: Reframe win themes around cost savings...
  DISCARD: score 68.10 (delta=-0.40)
...
Threshold 90.0 reached!

Run complete!
  Baseline: 62.50
  Final: 90.20
  Improvement: +27.70 (+44.3%)
  Halt reason: threshold
  Report: runs/a1b2c3d4/report.md
```

### 6.5 Run Artifacts

Each run creates a directory under `runs/<run-id>/` containing:

| File | Description |
|------|-------------|
| `progress.yaml` | Live progress (updated each iteration) |
| `audit.jsonl` | Full audit trail (one JSON object per event) |
| `result.json` | Final run result with all iterations and learnings |
| `report.md` | Human-readable Markdown report |
| `learnings.yaml` | Accumulated learnings from this run |
| `snapshots/` | Directory of artifact snapshots at each KEEP iteration |

### 6.6 Checking Status

While a run is in progress:

```bash
aurelius-autoresearch status --run-id a1b2c3d4
```

Output:

```
Run: a1b2c3d4
  Status: RUNNING
  Iteration: 12
  Score: 78.50
  Baseline: 62.50
  Improvement: +16.00
```

### 6.7 Halt Conditions

The loop will stop for any of these reasons:

| Halt Reason | Meaning |
|-------------|---------|
| `threshold` | Target score reached |
| `max_iterations` | Iteration limit exhausted |
| `plateau` | 3 consecutive non-improving iterations |
| `constraint_violation` | A HALT-level constraint was violated |
| `user_interrupt` | Cancelled via dashboard or signal |

### 6.8 Persona Rotation (Proposal Mode)

In proposal mode, the system rotates through six expert personas every 5 iterations:

| Persona | Focus Area |
|---------|-----------|
| `capture_manager` | Competitive positioning, teaming, and capture strategy |
| `solution_architect` | Technical approach, system design, and innovation |
| `customer_advocate` | Government evaluator perspective and evaluation criteria |
| `pricing_analyst` | Cost optimization, value propositions, and pricing strategy |
| `devsecops_expert` | Security architecture, compliance, and DevSecOps practices |
| `di_champion` | Diversity & inclusion, small business participation, socioeconomic goals |

This ensures the optimization explores multiple dimensions rather than over-fitting to a single perspective.

### 6.9 Starting a Run via the Dashboard API

You can also start runs programmatically:

```bash
curl -X POST http://localhost:8501/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "proposal",
    "target_path": "workspace/technical-volume.md",
    "metric": "composite",
    "threshold": 90.0,
    "max_iterations": 25
  }'
```

Response:

```json
{"run_id": "a1b2c3d4", "status": "started"}
```

### 6.10 Cancelling a Run

Via the API:

```bash
curl -X DELETE http://localhost:8501/api/runs/a1b2c3d4
```

The loop will complete its current iteration and then halt with `user_interrupt`.
