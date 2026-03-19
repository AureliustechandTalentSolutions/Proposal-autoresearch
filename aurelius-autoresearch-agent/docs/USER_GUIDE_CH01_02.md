# Aurelius Autoresearch Agent — User Guide

## Chapter 1: Introduction

### 1.1 What Is the Aurelius Autoresearch Agent?

The Aurelius Autoresearch Agent is an autonomous optimization system for federal proposal writing and compliance documentation. It implements the **Karpathy Autoresearch Loop** — a closed-loop pattern where an AI agent iteratively generates improvement hypotheses, applies modifications, scores the result, and decides whether to keep or discard each change.

The system is purpose-built for U.S. federal contracting workflows:

- **Proposal Mode** — Optimizes technical volumes, management volumes, and past-performance sections against FAR 15.305 evaluation criteria.
- **Compliance Mode** — Improves NIST 800-53, NIST 800-171, STIG, and CMMC Level 2 compliance artifacts toward target scores.

### 1.2 Key Capabilities

| Capability | Description |
|------------|-------------|
| **Autonomous optimization** | Runs up to 1,000 iterations without human intervention (when configured for full autonomy) |
| **Multi-persona hypothesis generation** | Rotates through six expert personas (capture manager, solution architect, customer advocate, pricing analyst, DevSecOps expert, D&I champion) to generate diverse improvement ideas |
| **Composite scoring** | Combines multiple weighted metrics — evaluation alignment, requirements traceability, readability (Flesch-Kincaid), discriminator density, win theme coverage, and page utilization |
| **Constraint enforcement** | Hard guardrails (page limits, no-fabrication, readability bands) that halt or discard modifications violating policy |
| **Privacy-aware LLM routing** | Automatically routes CUI, PII, and sensitive data to local Nemotron models while sending public tasks to cloud APIs |
| **Policy-as-code** | OPA (Open Policy Agent) Rego policies enforce FAR rubrics, NIST controls, STIG checks, and proposal constraints |
| **Full audit trail** | Every hypothesis, modification, score, and decision is logged with artifact hashes for tamper-evident provenance |
| **Real-time dashboard** | FastAPI web UI with Server-Sent Events for live progress monitoring |

### 1.3 Who Should Use This Guide

- **Proposal managers** who want to optimize technical volumes before submission
- **Compliance engineers** maintaining SSPs, POA&Ms, and OSCAL artifacts
- **DevSecOps teams** integrating continuous compliance into CI/CD pipelines
- **System administrators** deploying and operating the workbench

### 1.4 How the Autoresearch Loop Works

```
┌────────────────────────────────────────────────────────┐
│                  Autoresearch Loop                      │
│                                                        │
│  ┌──────────┐   ┌──────────┐   ┌───────┐   ┌───────┐  │
│  │ Hypothe- │──▶│ Modify   │──▶│ Score │──▶│Decide │  │
│  │ size     │   │ Artifact │   │       │   │       │  │
│  └──────────┘   └──────────┘   └───────┘   └───┬───┘  │
│       ▲                                        │      │
│       │         ┌───────────────┐              │      │
│       └─────────│ Learnings DB  │◀─────────────┘      │
│                 └───────────────┘                      │
└────────────────────────────────────────────────────────┘
```

Each iteration:

1. **Hypothesize** — The LLM generates ranked improvement hypotheses based on the current artifact, its score, and accumulated learnings.
2. **Modify** — The top hypothesis is applied to the artifact, producing a diff.
3. **Score** — The modified artifact is scored by the composite scorer.
4. **Decide** — If the score improves, the change is kept; otherwise it is discarded. The decision and its rationale are recorded as a learning.

The loop halts when one of these conditions is met:

- The **score threshold** is reached (e.g., 90.0)
- The **maximum iteration count** is exhausted
- A **plateau** is detected (3 consecutive non-improving iterations)
- A **HALT constraint** is violated (e.g., page limit exceeded)
- The user **cancels** the run

---

## Chapter 2: Architecture Overview

### 2.1 Five-Plane Architecture

The Aurelius Autoresearch Agent is organized into five operational planes, each responsible for a distinct concern:

```
┌─────────────────────────────────────────────────────────┐
│                     Maestro Plane                        │
│          (Orchestration · Dashboard · CLI)                │
├──────────┬──────────┬──────────┬────────────────────────┤
│ NemoClaw │Trigger.dev│   OPA    │       MinIO Vault      │
│ Plane    │  Plane    │  Plane   │        Plane           │
│(Security)│  (Tasks)  │(Policy)  │      (Storage)         │
└──────────┴──────────┴──────────┴────────────────────────┘
```

### 2.2 Plane Descriptions

#### Plane 1 — Maestro (Orchestration)

The Maestro plane controls the lifecycle of autoresearch runs:

- **AutoresearchLoop** (`agent/loop.py`) — The core Python engine that drives the hypothesis → modify → score → decide cycle.
- **CLI** (`agent/main.py`) — Command-line interface with `run`, `status`, `report`, and `dashboard` subcommands.
- **Autonomy Governor** (`src/main/autonomy/governor.ts`) — Controls the autonomy level (supervised, guided, fully autonomous) and determines which actions need human approval.
- **Scheduler** (`src/main/autonomy/scheduler.ts`) — Cron-based and folder-watch triggers for autonomous tasks.
- **Dashboard** (`dashboard/app.py`) — FastAPI web UI for starting runs, viewing progress, and reading reports.

#### Plane 2 — NemoClaw (Agent Security)

The NemoClaw plane ensures that agent actions respect security boundaries:

- **OpenShell Sandbox** (`src/main/nemoclaw/sandbox.ts`) — Executes agent tasks in least-privilege containers with network, filesystem, and process restrictions.
- **Privacy Router** (`src/main/nemoclaw/privacy-router.ts`) — Classifies prompt data and routes sensitive content (CUI, PII, past performance) to local Nemotron models.
- **Model Manager** (`src/main/nemoclaw/model-manager.ts`) — Manages local Nemotron model lifecycle (download, load, health).
- **Security Logger** (`src/main/nemoclaw/security-logger.ts`) — Logs all security-relevant events to the audit trail.
- **Policy Loader** (`src/main/nemoclaw/policy-loader.ts`) — Loads and validates OpenShell YAML agent policies.

#### Plane 3 — Trigger.dev (Task Execution)

Trigger.dev v3 handles all background task execution:

- **Hypothesis generation** (`tasks/src/hypothesis/generate.ts`) — Dispatches LLM calls for hypothesis generation.
- **Modification** (`tasks/src/modify/apply.ts`) — Applies hypotheses to produce artifact diffs.
- **Scoring** (`tasks/src/score/evaluate.ts`) — Runs scoring tasks against modified artifacts.
- **PDF parsing** (`tasks/src/parse/pdf.ts`) — Extracts structured content from RFP PDFs.
- **Volume generation** (`tasks/src/generate/volume.ts`) — Generates proposal volume drafts.
- **Export packaging** (`tasks/src/export/package.ts`) — Archives final artifacts with metadata.

#### Plane 4 — OPA (Policy Engine)

Open Policy Agent evaluates all compliance and constraint rules:

- **Compliance policies** — NIST 800-53 (`nist_800_53.rego`), NIST 800-171 (`nist_800_171.rego`), CMMC L2 (`cmmc_l2.rego`), Kubernetes STIGs (`stig_k8s.rego`), SPRS scoring (`sprs.rego`).
- **Proposal policies** — FAR 15.305 evaluation rubric (`eval_rubric.rego`), compliance matrix validation (`compliance_matrix.rego`), page limits (`page_limits.rego`), readability targets (`readability.rego`).
- **Constraint policies** — Federal proposal constraints (`federal_proposal.rego`), compliance artifact validation (`compliance_artifact.rego`), safety guardrails (`safety.rego`).
- **OpenShell agent policies** — Per-persona sandboxing rules (e.g., `proposal-persona-agent.yaml`, `compliance-agent.yaml`).

#### Plane 5 — MinIO Vault (Artifact Storage)

MinIO provides S3-compatible object storage for all artifacts:

- **Artifact snapshots** — Every iteration's artifact is stored with its hash.
- **Audit logs** — JSONL audit trails and YAML progress files.
- **Learnings database** — Accumulated patterns and insights across runs.
- **Exports** — Final packaged deliverables (ZIP archives with metadata).

### 2.3 Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Core loop engine | Python 3.11+, Pydantic, asyncio | Autoresearch loop, scoring, constraints |
| UI layer | TypeScript, Electrobun/Bun | NemoClaw panels, Maestro UI |
| Task execution | Node.js 22, Trigger.dev v3 | Background LLM calls, parsing, generation |
| Policy engine | OPA, Rego | Compliance rules, proposal rubrics |
| Object storage | MinIO | S3-compatible artifact persistence |
| Queue/cache | Redis 7 | Task queue backend, result caching |
| Local LLM | Ollama + Nemotron | Privacy-safe inference for sensitive data |
| Cloud LLM | Anthropic Claude, OpenAI | High-quality generation for public data |
| Containerization | Docker Compose | Full-stack orchestration |

### 2.4 Data Flow

```
RFP Document
    │
    ▼
┌──────────┐     ┌──────────────┐     ┌─────────┐
│ PDF Parse│────▶│ Baseline     │────▶│ Loop    │
│ (Trigger)│     │ Score (OPA)  │     │(Maestro)│
└──────────┘     └──────────────┘     └────┬────┘
                                           │
                     ┌─────────────────────┤
                     ▼                     ▼
              ┌────────────┐       ┌──────────────┐
              │ Hypothesis │       │ Modify       │
              │ (LLM call) │       │ (LLM call)   │
              └────────────┘       └──────┬───────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │ Constraint   │
                                   │ Validation   │
                                   └──────┬───────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │ Score        │
                                   │ (Composite)  │
                                   └──────┬───────┘
                                          │
                                   ┌──────┴───────┐
                                   │ KEEP/DISCARD │
                                   └──────┬───────┘
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │ MinIO Vault  │
                                   │ (snapshot)   │
                                   └──────────────┘
```

### 2.5 Network Topology (Docker Compose)

All services run on the `aurelius-net` bridge network:

| Service | Container Name | Default Port | Depends On |
|---------|---------------|-------------|------------|
| autoresearch | `aurelius-autoresearch` | 8501 | minio, opa, redis |
| trigger-worker | `aurelius-trigger-worker` | — | minio, opa, redis |
| opa | `aurelius-opa` | 8181 | — |
| minio | `aurelius-minio` | 9000 (API), 9001 (Console) | — |
| redis | `aurelius-redis` | 6379 | — |
| ollama | `aurelius-ollama` | 11434 | — (profile: `local-llm`) |
