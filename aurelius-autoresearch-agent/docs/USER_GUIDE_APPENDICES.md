# Aurelius Autoresearch Agent — User Guide

## Appendices

---

### Appendix A: Complete CLI Reference

```
aurelius-autoresearch <command> [options]

Commands:
  run         Start an autoresearch optimization loop
  status      Check run status
  report      View run report
  dashboard   Start the web dashboard

run options:
  --config PATH          Path to YAML config file
  --mode MODE            Optimization mode: proposal | compliance
  --target PATH          Path to target artifact
  --metric METRIC        Metric to optimize
  --threshold FLOAT      Score threshold (default: 90.0)
  --max-iterations INT   Maximum iterations (default: 25)
  --llm-provider PROV    LLM provider: claude | openai | ollama (default: claude)
  --llm-model MODEL      Model identifier (default: claude-sonnet-4-20250514)
  --eval-criteria PATH   Path to evaluation criteria YAML
  --daemon               Run in background mode

status options:
  --run-id ID            Run ID to check (required)

report options:
  --run-id ID            Run ID to view (required)
```

---

### Appendix B: Environment Variable Reference

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `ANTHROPIC_API_KEY` | — | Yes (for Claude) | Anthropic API key |
| `LLM_PROVIDER` | `auto` | No | `auto`, `claude`, `openai`, `ollama` |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | No | Cloud model identifier |
| `LOCAL_MODEL` | `nemotron:latest` | No | Local model identifier |
| `OPENSHELL_ENDPOINT` | `http://localhost:2376` | No | OpenShell sandbox API |
| `PRIVACY_ROUTER_CONFIG` | `local-first` | No | `local-first`, `cloud`, `hybrid` |
| `AUTONOMY_CONFIG` | `supervised` | No | `supervised`, `guided`, `fully_autonomous` |
| `OPA_ENDPOINT` | `http://localhost:8181` | No | OPA server URL |
| `OPA_PORT` | `8181` | No | OPA listen port |
| `OPA_LOG_LEVEL` | `info` | No | `debug`, `info`, `error` |
| `MINIO_ENDPOINT` | `http://localhost:9000` | No | MinIO S3 API URL |
| `MINIO_API_PORT` | `9000` | No | MinIO API port |
| `MINIO_CONSOLE_PORT` | `9001` | No | MinIO web console port |
| `MINIO_USER` | `aurelius` | No | MinIO root user |
| `MINIO_PASSWORD` | `changeme123` | Yes (prod) | MinIO root password |
| `MINIO_USE_SSL` | `false` | No | Enable TLS for MinIO |
| `REDIS_URL` | `redis://localhost:6379` | No | Redis connection URL |
| `REDIS_PORT` | `6379` | No | Redis port |
| `REDIS_MAXMEMORY` | `256mb` | No | Redis memory limit |
| `TRIGGER_API_KEY` | `tr_dev_placeholder` | Yes (prod) | Trigger.dev API key |
| `TRIGGER_API_URL` | `http://localhost:3030` | No | Trigger.dev server URL |
| `TRIGGER_PROJECT_ID` | `aurelius-workbench` | No | Trigger.dev project ID |
| `OLLAMA_ENDPOINT` | `http://localhost:11434` | No | Ollama server URL |
| `OLLAMA_PORT` | `11434` | No | Ollama port |
| `DASHBOARD_PORT` | `8501` | No | Dashboard listen port |
| `WORKBENCH_PORT` | `8500` | No | Workbench port |
| `NODE_ENV` | `development` | No | Node.js environment |

---

### Appendix C: Scorer Quick Reference

#### Proposal Mode Scorers

| Scorer Class | Metric | LLM Required | Default Weight |
|-------------|--------|-------------|----------------|
| `EvaluationAlignmentScorer` | FAR 15.305 factor coverage | Yes | 0.35 |
| `RequirementsTraceabilityScorer` | PWS/SOW traceability | Yes | 0.20 |
| `ReadabilityScorer` | Flesch-Kincaid grade level | No | 0.15 |
| `DiscriminatorDensityScorer` | Unique differentiators per page | Yes | 0.15 |
| `WinThemeScorer` | Win theme presence | No | 0.10 |
| `PageUtilizationScorer` | Page budget efficiency | No | 0.05 |

#### Compliance Mode Scorers

| Scorer Class | Metric | LLM Required | Default Weight |
|-------------|--------|-------------|----------------|
| `NistControlCoverageScorer` | NIST control coverage | Yes | 0.40 |
| `StigPassRateScorer` | STIG checklist pass rate | Yes | 0.30 |
| `PoamReductionScorer` | POA&M item reduction | Yes | 0.20 |
| `SprsScorer` | SPRS score (normalized) | Yes | 0.10 |

---

### Appendix D: Constraint Validation Types

| Type | Parameters | Description |
|------|-----------|-------------|
| `word_count` | `min`, `max` | Validates word count is within range |
| `page_limit` | `max_pages`, `words_per_page` | Validates estimated page count |
| `readability_range` | `min`, `max` | Validates Flesch-Kincaid grade level |
| `contains_required` | `required_strings` (list) | Checks for presence of required text |
| `no_fabrication` | `enabled` | Prevents fabricated claims/evidence |
| `custom_regex` | `pattern`, `must_match` | Validates against a regex pattern |
| `file_valid` | `type` (`yaml`/`json`) | Validates file format |

---

### Appendix E: OPA Policy Packages

| Package | File | Purpose |
|---------|------|---------|
| `compliance.nist_800_53` | `policies/compliance/nist_800_53.rego` | NIST 800-53 Rev 5 controls |
| `compliance.nist_800_171` | `policies/compliance/nist_800_171.rego` | NIST 800-171 CUI controls |
| `compliance.cmmc_l2` | `policies/compliance/cmmc_l2.rego` | CMMC Level 2 maturity |
| `compliance.stig_k8s` | `policies/compliance/stig_k8s.rego` | Kubernetes STIGs |
| `compliance.sprs` | `policies/compliance/sprs.rego` | SPRS scoring |
| `proposal.eval_rubric` | `policies/proposal/eval_rubric.rego` | FAR 15.305 rubric |
| `proposal.compliance_matrix` | `policies/proposal/compliance_matrix.rego` | Compliance matrix |
| `proposal.page_limits` | `policies/proposal/page_limits.rego` | Page utilization |
| `proposal.readability` | `policies/proposal/readability.rego` | Readability targets |
| `constraints.federal_proposal` | `policies/constraints/federal_proposal.rego` | Proposal guardrails |
| `constraints.compliance_artifact` | `policies/constraints/compliance_artifact.rego` | Artifact validation |
| `constraints.safety` | `policies/constraints/safety.rego` | Safety rules |

---

### Appendix F: Docker Compose Profiles

| Profile | Services Added | Use Case |
|---------|---------------|----------|
| (default) | autoresearch, trigger-worker, opa, minio, redis | Standard deployment |
| `local-llm` | + ollama | Air-gapped / CUI-sensitive deployments |

#### Common Commands

```bash
# Start all default services
docker compose up -d

# Start with local LLM
docker compose --profile local-llm up -d

# View logs
docker compose logs -f autoresearch

# Restart OPA after policy changes
docker compose restart opa

# Stop everything
docker compose down

# Stop and remove volumes (destructive)
docker compose down -v
```

---

### Appendix G: Run Result Schema

The `result.json` file written for each completed run follows this schema:

```json
{
  "run_id": "a1b2c3d4",
  "config": {
    "mode": "proposal",
    "target_path": "workspace/technical-volume.md",
    "metric": "composite",
    "threshold": 90.0,
    "max_iterations": 25,
    "constraints": [],
    "scorer_weights": {},
    "llm_provider": "claude",
    "llm_model": "claude-sonnet-4-20250514"
  },
  "baseline_score": 62.5,
  "final_score": 90.2,
  "total_improvement": 27.7,
  "improvement_percentage": 44.3,
  "iterations": [
    {
      "iteration": 1,
      "hypothesis": {
        "id": "uuid",
        "description": "...",
        "expected_impact": "...",
        "risk": "...",
        "priority": 1
      },
      "score_before": 62.5,
      "score_after": 65.3,
      "delta": 2.8,
      "decision": "KEEP",
      "rationale": "Score improved by +2.80",
      "artifact_hash_before": "sha256:...",
      "artifact_hash_after": "sha256:...",
      "diff": "...",
      "timestamp": "2026-03-19T10:30:00Z",
      "duration_seconds": 12.5
    }
  ],
  "learnings": [
    {
      "iteration": 1,
      "hypothesis": "...",
      "decision": "KEEP",
      "delta": 2.8,
      "insight": "Score improved by +2.80"
    }
  ],
  "halt_reason": "threshold",
  "started_at": "2026-03-19T10:00:00Z",
  "completed_at": "2026-03-19T10:45:00Z"
}
```

---

### Appendix H: Privacy Router Classification Markers

#### CUI Markers (Force Local Routing)

| Marker | Standard |
|--------|----------|
| `CUI` | NARA CUI Registry |
| `CONTROLLED UNCLASSIFIED` | NARA |
| `FOUO` | For Official Use Only |
| `NOFORN` | Not Releasable to Foreign Nationals |
| `//CUI` | CUI banner marking |
| `CUI//SP-CTI` | Controlled Technical Information |
| `CUI//SP-EXPT` | Export Controlled |
| `DISTRIBUTION STATEMENT B–F` | DoD distribution restrictions |

#### Federal Contract Number Patterns

| Pattern | Agency |
|---------|--------|
| `W911NF` | Army Research Lab |
| `FA8702` | Air Force (MITRE) |
| `FA8750` | Air Force Research Lab |
| `N00024` | Navy (NAVSEA) |
| `N00174` | Navy (NSWC) |
| `N66001` | Navy (SPAWAR/NAVWAR) |
| `DAAB07` | Army CECOM |
| `H98230` | NSA |
| `HQ0034` / `HR0011` | DARPA |

#### PII Patterns Detected

SSN, email, U.S. phone numbers, credit card numbers, dates of birth, U.S. street addresses, passport numbers, ITAR references, EAR references.

---

### Appendix I: Glossary

| Term | Definition |
|------|-----------|
| **Autoresearch loop** | Iterative optimization cycle: hypothesize → modify → score → decide |
| **Artifact** | The document being optimized (proposal volume, SSP, POA&M, etc.) |
| **Composite scorer** | Weighted combination of multiple scoring metrics |
| **Constraint** | Hard guardrail that blocks (DISCARD) or halts (HALT) modifications |
| **CUI** | Controlled Unclassified Information |
| **Discriminator** | Unique competitive differentiator in a proposal |
| **FAR 15.305** | Federal Acquisition Regulation section governing source selection evaluation |
| **Hypothesis** | A proposed improvement to the artifact |
| **Karpathy loop** | Named pattern for autonomous iterative improvement |
| **Maestro** | Orchestration plane controlling loop lifecycle |
| **NemoClaw** | Security plane handling sandboxing and privacy routing |
| **Nemotron** | NVIDIA's local LLM model family |
| **OPA** | Open Policy Agent — policy-as-code engine |
| **OSCAL** | Open Security Controls Assessment Language |
| **Persona** | Expert role used to generate diverse hypotheses |
| **Plateau** | 3+ consecutive iterations with no score improvement |
| **POA&M** | Plan of Action and Milestones |
| **Privacy router** | Component that routes LLM requests based on data sensitivity |
| **PWS** | Performance Work Statement |
| **Rego** | OPA's policy language |
| **SOW** | Statement of Work |
| **SPRS** | Supplier Performance Risk System |
| **SSP** | System Security Plan |
| **STIG** | Security Technical Implementation Guide |
| **Win theme** | Key message thread reinforced throughout a proposal |
