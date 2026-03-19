# PRD-001: Aurelius Autonomous Research Workbench

| Field          | Value                                                          |
| -------------- | -------------------------------------------------------------- |
| **Status**     | REVISED (v2.1 -- Five-Plane Architecture)                      |
| **Date**       | March 19, 2026                                                 |
| **Author**     | Aurelius Product Team                                          |
| **Stakeholders** | Engineering, Compliance, Federal BD, Security Architecture   |
| **Revision**   | 2.1                                                            |

---

## 1. Executive Summary

The Aurelius Autonomous Research Workbench is a desktop application that applies Andrej Karpathy's **autoresearch loop pattern** to federal proposal optimization and compliance automation. The workbench continuously generates hypotheses, modifies deliverables, scores results against objective metrics, and accumulates learnings -- all within a governed, auditable pipeline.

Revision 2.1 introduces a **Five-Plane Architecture** with NVIDIA NemoClaw as a dedicated Agent Security plane, enabling air-gapped operation, privacy-aware LLM routing, and sandboxed agent execution required for federal (FedRAMP, NIST 800-53, CMMC) deployments.

---

## 2. Problem Statement

### 2.1 Current Pain Points

Federal proposal teams and compliance engineers face compounding challenges:

1. **Manual iteration is slow.** Improving a 200-page technical volume against Section M evaluation criteria requires dozens of revision cycles, each involving cross-functional review. A single proposal can consume 2,000+ person-hours.

2. **Scoring is subjective.** Without machine-readable evaluation rubrics, reviewers disagree on quality. Teams submit proposals without knowing their objective alignment to evaluation criteria.

3. **Compliance drift is invisible.** Security configurations degrade over time. STIG pass rates drop between assessments without detection. POA&M items accumulate without automated triage.

4. **Data sovereignty is non-negotiable.** Federal customers require that CUI and classified content never leave the enclave. Existing AI-assisted tools route all prompts to cloud APIs with no local fallback.

5. **Agent autonomy is ungoverned.** LLM-powered agents that modify files, invoke tools, and call external APIs without sandboxing or policy enforcement are unacceptable in regulated environments.

### 2.2 Opportunity

An autonomous workbench that combines iterative LLM-driven optimization with objective scoring, compliance validation, and sandboxed execution can reduce proposal cycle time by 60-70% while improving evaluation alignment scores from a typical 65-75% to 85-95%.

---

## 3. Product Vision

**Enable federal teams to produce winning proposals and maintain continuous compliance through governed, autonomous AI research loops that operate safely in air-gapped environments.**

The workbench is not a chatbot. It is an autonomous research engine that runs multi-iteration optimization pipelines, accumulates domain learnings, and produces measurably better deliverables with each cycle -- all under policy-enforced security boundaries.

---

## 4. Target Users

| Persona | Role | Primary Use Case |
| ------- | ---- | ---------------- |
| **Capture Manager** | Leads proposal development | Run proposal optimization loops against Section M criteria; review score trajectories; accept/reject iterations |
| **Technical Volume Lead** | Authors technical approach | Optimize technical sections for discriminator density, requirements traceability, and win theme coverage |
| **Compliance Engineer** | Maintains security posture | Run compliance optimization loops against STIG/NIST baselines; reduce POA&M items; validate OSCAL artifacts |
| **ISSO / Security Officer** | Oversees information security | Configure autonomy levels, review agent sandbox policies, audit agent actions, validate privacy routing |
| **Program Manager** | Oversees delivery | Monitor optimization progress via dashboard; review aggregate metrics across multiple deliverables |

---

## 5. Five-Plane Architecture

The workbench is built on a five-plane architecture, each plane responsible for a distinct concern. See **ADR-001** for the full rationale.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    AURELIUS AUTONOMOUS WORKBENCH v2.1                    │
│                       (Electrobun + Bun Runtime)                         │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────┤
│   PANEL 1    │   PANEL 2    │   PANEL 3    │   PANEL 4    │  PANEL 5    │
│   MAESTRO    │  NEMOCLAW    │  TRIGGER.DEV │  OPA ENGINE  │ MINIO VAULT │
│  Orchestrate │  Sandbox     │  Execute     │  Evaluate    │ Store       │
├──────────────┴──────────────┴──────────────┴──────────────┴─────────────┤
│                          BUN MAIN PROCESS                                │
│  RPC handlers | IPC bridge | Autonomy scheduler | System tray            │
├──────────────────────────────────────────────────────────────────────────┤
│                    BACKEND SERVICES (Containers)                          │
│  Trigger.dev worker | OPA server | MinIO | OpenShell runtime | Nemotron  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Plane Responsibilities

| Plane | Name | Technology | Key Responsibilities |
| ----- | ---- | ---------- | -------------------- |
| 1 | **Orchestration (Maestro)** | Bun main process | Autoresearch loop control, scheduling, dashboard, autonomy governor, pipeline management |
| 2 | **Agent Security (NemoClaw)** | OpenShell + Nemotron | Agent sandboxing, permission policies, privacy-aware LLM routing, local inference |
| 3 | **Task Execution (Trigger.dev)** | Node.js 22 workers | LLM API calls, document parsing, content generation, persona-based tasks |
| 4 | **Policy Evaluation (OPA)** | Bun FFI / WASM | Compliance scoring, OSCAL validation, rubric evaluation, proposal review |
| 5 | **Artifact Storage (MinIO)** | S3-compatible container | Artifact persistence, audit trail, learnings DB, versioned exports |

---

## 6. Core Features

### 6.1 Autoresearch Loop Engine

The core engine implements the Karpathy autoresearch pattern as a four-phase iterative loop:

**Phase 1 -- Hypothesis Generation**
The system analyzes the current state of the deliverable and accumulated learnings to generate a targeted improvement hypothesis (e.g., "Adding a past performance reference to Section L.4 will increase discriminator density by 15%").

**Phase 2 -- Modification**
An LLM applies the hypothesis to the deliverable, producing a modified version. Modifications respect constraints (page limits, readability targets, no fabrication).

**Phase 3 -- Scoring**
One or more scoring functions evaluate the modified deliverable against objective metrics. Scores are recorded to the audit trail.

**Phase 4 -- Decision (Keep/Discard)**
If the modified version scores higher than the current best, it is kept as the new baseline. Otherwise, it is discarded. Either way, the hypothesis and outcome are recorded as a learning for future iterations.

The loop runs for N iterations (configurable) or until a target threshold is reached.

### 6.2 Scoring Functions

| Scorer | Metric | Mode | Description |
| ------ | ------ | ---- | ----------- |
| `EvaluationAlignmentScorer` | `eval_alignment` | Proposal | Measures alignment to Section M evaluation criteria per FAR 15.305 |
| `RequirementsTraceabilityScorer` | `req_traceability` | Proposal | Traces deliverable content to PWS/SOW requirements |
| `DiscriminatorDensityScorer` | `discriminator_density` | Proposal | Counts unique discriminators (strengths/significant strengths) per section |
| `WinThemeScorer` | `win_themes` | Proposal | Measures win theme presence and reinforcement across sections |
| `ReadabilityScorer` | `readability` | Both | Targets Flesch-Kincaid grade level 8-10 for federal audiences |
| `PageUtilizationScorer` | `page_utilization` | Proposal | Ensures efficient use of page limits without overflow |
| `NistControlCoverageScorer` | `nist_coverage` | Compliance | Measures NIST 800-53/171 control implementation coverage |
| `StigPassRateScorer` | `stig_pass_rate` | Compliance | STIG pass rate with CAT I/II/III severity weighting |
| `SprsScorer` | `sprs_score` | Compliance | SPRS score normalized to 0-100 |
| `PoamReductionScorer` | `poam_reduction` | Compliance | Tracks POA&M open item reduction over time |
| `CompositeScorer` | `composite` | Both | Weighted combination of multiple metrics |

### 6.3 Constraint Engine

Built-in constraint sets prevent the loop from producing invalid output:

- **FEDERAL_PROPOSAL_CONSTRAINTS**: Page limits, readability range (grade 8-10), no fabricated past performance, no hallucinated contract numbers
- **COMPLIANCE_CONSTRAINTS**: Valid YAML syntax, no fabricated evidence, no invented control implementations
- **KUBERNETES_CONSTRAINTS**: Valid YAML, valid Kubernetes API versions

Custom constraints can be defined in YAML config files.

### 6.4 Autonomy Levels

The workbench supports three autonomy levels, each enforced by both Maestro (orchestration) and NemoClaw (security):

| Level | Name | Behavior | NemoClaw Policy | Use Case |
| ----- | ---- | -------- | --------------- | -------- |
| 1 | Supervised | Every action requires human approval | Restrictive: no network egress, read-only FS, local-only LLM | Initial setup, sensitive deliverables |
| 2 | Semi-Autonomous | Pre-approved action types execute automatically; novel actions require approval | Standard: whitelisted endpoints, project-scoped FS, classification-based routing | Day-to-day proposal work |
| 3 | Fully Autonomous | Full pipeline executes without intervention; kill switch available | Permissive but audited: broad access, full tool set, anomaly detection auto-downgrade | Overnight batch runs, CI/CD integration |

### 6.5 Agent Security (NemoClaw Integration)

Every task dispatched by Maestro passes through NemoClaw before execution:

1. **Sandbox Enforcement**: OpenShell runtime isolates each agent task with declarative YAML policies controlling filesystem, network, tool, and resource access.
2. **Privacy Router**: Classifies outbound LLM requests by data sensitivity (public / internal / sensitive / classified) and routes to cloud or local Nemotron accordingly.
3. **Local Inference**: Nemotron models handle prompt classification, local summarization, and policy evaluation assistance without external API calls.
4. **Anomaly Detection**: Behavioral monitoring detects agent actions deviating from expected patterns and auto-downgrades autonomy level.

### 6.6 Real-Time Dashboard

The Maestro panel provides a web-based dashboard (SSE-powered) showing:

- Live score trajectory chart across iterations
- Iteration history with KEEP/DISCARD decisions and rationale
- Hypothesis log with confidence scores
- Learnings database (searchable)
- Run management (start, pause, cancel)
- Aggregate metrics across multiple concurrent runs

### 6.7 Learnings Store

The system accumulates domain-specific learnings across runs:

- Successful hypotheses are stored with context, enabling transfer learning between proposals
- Failed hypotheses are stored with failure reasons, preventing repeated mistakes
- Learnings are versioned and searchable
- Cross-run knowledge synthesis enables improving hypothesis quality over time

### 6.8 LLM Provider Abstraction

The workbench supports multiple LLM backends:

| Provider | Model | Use Case |
| -------- | ----- | -------- |
| **Claude** (Anthropic) | claude-sonnet-4-20250514 | Primary cloud inference for proposal/compliance optimization |
| **OpenAI** | GPT-4 | Alternative cloud inference |
| **Ollama** | llama3.1, mistral | Local inference for development and air-gapped fallback |
| **Nemotron** (via NemoClaw) | Nemotron-mini, Nemotron-340B | Local inference for classification, summarization, sensitive content |
| **LeapfrogAI** | Custom endpoint | DoD-hosted inference via custom OpenAI-compatible endpoint |

---

## 7. Technical Requirements

### 7.1 Desktop Application

| Requirement | Specification |
| ----------- | ------------- |
| Runtime | Electrobun (Bun-native desktop framework) |
| UI Framework | Five-panel webview architecture |
| IPC | Bun-native RPC between main process and webview panels |
| Build Targets | Linux x64, macOS ARM64, macOS x64 |
| Tray Integration | System tray icon with quick-access menu |

### 7.2 Backend Services

| Service | Technology | Purpose |
| ------- | ---------- | ------- |
| Trigger.dev Worker | Node.js 22 | Executes LLM tasks, document parsing, content generation |
| OPA Server | OPA + WASM | Policy evaluation, compliance scoring |
| MinIO | S3-compatible | Artifact storage, audit trail |
| OpenShell Runtime | NemoClaw container | Agent sandboxing |
| Nemotron | NVIDIA container | Local LLM inference |

### 7.3 Deployment

| Requirement | Specification |
| ----------- | ------------- |
| Containerization | Docker Compose for local development; Zarf packages for air-gapped |
| Minimum Hardware | 16 GB RAM, 4 CPU cores (CPU-only Nemotron with Q4 quantization) |
| Recommended Hardware | 32 GB RAM, 8 CPU cores, NVIDIA GPU 16 GB+ VRAM |
| Air-Gapped Support | Full functionality via Nemotron local inference + Zarf packaging |

### 7.4 API Surface

| Endpoint | Method | Description |
| -------- | ------ | ----------- |
| `/` | GET | Dashboard UI |
| `/api/runs` | GET | List all optimization runs |
| `/api/runs/{id}` | GET | Get run details with iteration history |
| `/api/runs/{id}/progress` | GET (SSE) | Real-time progress stream |
| `/api/runs/{id}/report` | GET | Markdown report of run results |
| `/api/runs` | POST | Start new optimization run |
| `/api/runs/{id}` | DELETE | Cancel running optimization loop |

### 7.5 RPC Handlers

The Bun main process exposes RPC handlers for inter-panel communication:

| Handler | Panel | Purpose |
| ------- | ----- | ------- |
| `maestro.rpc` | Maestro | Loop control, scheduling, pipeline management |
| `nemoclaw.rpc` | NemoClaw | Sandbox management, policy operations, privacy routing |
| `trigger.rpc` | Trigger.dev | Task dispatch, queue management, worker status |
| `opa.rpc` | OPA | Policy evaluation, compliance queries, OSCAL validation |
| `minio.rpc` | MinIO | Artifact upload/download, audit log queries, versioning |

---

## 8. Compliance Requirements

### 8.1 Federal Frameworks

| Framework | Requirement | How Addressed |
| --------- | ----------- | ------------- |
| **FedRAMP** | AC-6 Least Privilege | NemoClaw OpenShell policies enforce per-agent minimal permissions |
| **NIST 800-53** | SC-7 Boundary Protection | Privacy Router prevents sensitive data from leaving enclave |
| **NIST 800-171** | CUI Protection | Classification-based routing ensures CUI stays on local Nemotron |
| **CMMC Level 3** | Practice maturity | OPA plane validates OSCAL artifacts against CMMC requirements |
| **STIG** | Configuration hardening | Compliance mode optimizes configs against STIG benchmarks |

### 8.2 Audit Trail

Every action in the autonomy loop is recorded to the MinIO audit trail:

- Hypothesis generated (with confidence score and rationale)
- Modification applied (with diff)
- Score computed (with breakdown)
- Decision made (KEEP/DISCARD with justification)
- Agent sandbox events (tool invocations, file access, network calls)
- Privacy routing decisions (cloud vs. local, classification result)
- Autonomy level changes (upgrades, downgrades, anomaly triggers)

---

## 9. Operational Modes

### 9.1 Proposal Optimization

```bash
python -m agent run \
  --mode proposal \
  --target ./workspace/technical-volume.md \
  --metric eval_alignment \
  --threshold 90 \
  --max-iterations 50
```

The loop reads the target document, generates improvement hypotheses targeting the specified metric, applies modifications, scores, and iterates. Constraint sets prevent page overflow and fabrication.

### 9.2 Compliance Optimization

```bash
python -m agent run \
  --mode compliance \
  --target ./workspace/deployment.yaml \
  --metric stig_pass_rate \
  --threshold 95 \
  --max-iterations 30
```

The loop modifies security configurations to improve STIG pass rates, NIST control coverage, or SPRS scores while maintaining valid YAML and Kubernetes API compatibility.

### 9.3 Dashboard Mode

```bash
python -m agent dashboard
# or
docker compose up -d
open http://localhost:8501
```

Web-based interface for starting runs, monitoring progress, and reviewing results.

---

## 10. Integration Points

| System | Integration | Purpose |
| ------ | ----------- | ------- |
| **Lula** | CLI invocation from compliance scorer | Validate OSCAL compliance artifacts against live infrastructure |
| **InSpec** | CLI invocation from STIG scorer | Automated STIG validation against deployed systems |
| **BMAD** | Agent persona definitions | Define specialized agent personas (proposal writer, compliance auditor, etc.) |
| **Zarf** | Build packaging | Package entire workbench for air-gapped deployment |
| **Defense Unicorns UDS** | Kubernetes deployment | Deploy backend services in hardened Kubernetes clusters |

---

## 11. Success Metrics

| Metric | Target | Measurement |
| ------ | ------ | ----------- |
| Evaluation alignment improvement | +20 points (e.g., 65% to 85%) | Before/after scoring on held-out evaluation criteria |
| Proposal cycle time reduction | 60-70% reduction | Wall-clock time from first draft to final submission |
| STIG pass rate improvement | +15 points per optimization run | Before/after STIG benchmark results |
| POA&M item reduction | 40% reduction per quarter | Quarterly POA&M count comparison |
| Agent policy violations | 0 uncontained violations | NemoClaw audit log analysis |
| Privacy routing accuracy | 99.5%+ correct classification | Manual review of routing decisions sample |
| System uptime | 99.9% during business hours | Monitoring and alerting |

---

## 12. Risks and Mitigations

| Risk | Severity | Mitigation |
| ---- | -------- | ---------- |
| LLM hallucination in proposals | HIGH | Constraint engine blocks fabricated content; human review at autonomy levels 1-2 |
| Sensitive data leakage via cloud LLM | CRITICAL | NemoClaw Privacy Router with mandatory classification; Nemotron fallback |
| NemoClaw SDK instability | MEDIUM | Pinned SDK version; abstraction layer isolates upstream changes |
| Nemotron quality vs. cloud models | MEDIUM | Dual-classification with confidence thresholds; escalation to human review |
| GPU unavailability in target environments | MEDIUM | Quantized Nemotron variants (Q4/Q8) for CPU-only; graceful degradation |
| Over-optimization (gaming metrics) | LOW | Composite scoring with multiple orthogonal metrics; constraint validation |

---

## 13. Milestones

| Phase | Milestone | Description |
| ----- | --------- | ----------- |
| 1 | **Core Loop** | Autoresearch loop engine with hypothesis, modifier, scorer, and learnings store |
| 2 | **Scoring Library** | Full suite of proposal and compliance scoring functions |
| 3 | **Desktop Workbench** | Electrobun five-panel UI with Maestro dashboard |
| 4 | **NemoClaw Integration** | Agent sandboxing, privacy routing, local Nemotron inference |
| 5 | **Compliance Automation** | OSCAL validation, STIG optimization, POA&M tracking |
| 6 | **Air-Gapped Packaging** | Zarf packages for disconnected federal deployments |
| 7 | **Multi-Agent Personas** | BMAD-driven specialized agent personas for different proposal sections |

---

## 14. Open Questions

1. **Nemotron model selection**: Which Nemotron variant balances classification accuracy with CPU-only latency requirements? Requires benchmarking in target hardware.
2. **Autonomy level defaults**: Should new installations default to Level 1 (Supervised) or Level 2 (Semi-Autonomous)? Depends on customer risk tolerance.
3. **Cross-proposal learning**: Should the learnings store be shared across proposals within an organization, or isolated per-proposal for information barriers?
4. **OSCAL profile selection**: Which OSCAL profiles should ship as built-in presets? NIST 800-53 Moderate and CMMC Level 3 are candidates.

---

## 15. References

| Reference | Description |
| --------- | ----------- |
| [ADR-001](./ADR-001-five-plane-workbench.md) | Five-Plane Autonomous Workbench Architecture Decision Record |
| [Karpathy Autoresearch](https://github.com/karpathy/autoresearch) | Andrej Karpathy's autonomous research agent pattern |
| [Palantir AIP](https://www.palantir.com/platforms/aip/) | Multi-agent orchestration in defense contexts |
| [NVIDIA NemoClaw](https://developer.nvidia.com/nemoclaw) | Agent security framework with OpenShell and Nemotron |
| [Defense Unicorns UDS](https://github.com/defenseunicorns/uds-core) | Kubernetes distribution for air-gapped federal deployments |
| [NIST 800-53 Rev 5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final) | Security and Privacy Controls for Information Systems |
| [OSCAL](https://pages.nist.gov/OSCAL/) | Open Security Controls Assessment Language |
| [Electrobun](https://electrobun.dev/) | Bun-native desktop application framework |
| [Trigger.dev](https://trigger.dev/) | Background task execution framework |
