# ADR-001: Five-Plane Autonomous Workbench Architecture

| Field                  | Value                                              |
| ---------------------- | -------------------------------------------------- |
| **Status**             | ACCEPTED (amended from original four-plane design) |
| **Date**               | March 18, 2026                                     |
| **Deciders**           | Aurelius Architecture Board                        |
| **Amendment Revision** | 2.1                                                |

---

## 1. Context

The original Aurelius Autonomous Workbench was designed around a **four-plane architecture** consisting of Maestro (orchestration), Trigger.dev (task execution), OPA (policy evaluation), and MinIO (artifact storage). These four planes provided a clean separation of concerns for autonomous document research and generation.

However, as the workbench evolved toward **Level 3 autonomous operation** in federal environments, a critical gap emerged: **there was no dedicated agent security layer**. Autonomous agents executing LLM calls, modifying files, and generating artifacts require sandboxed isolation, permission policies, and a privacy-aware routing layer to meet federal compliance requirements (FedRAMP, NIST 800-53, CMMC).

Specifically, the architecture needed:

- **Agent isolation** -- each autonomous task must run in a sandboxed environment where file system access, network egress, and tool invocation are controlled by policy.
- **Local LLM inference** -- certain classification and routing decisions must stay on-premise, never leaving the air-gapped boundary, to satisfy data sovereignty requirements.
- **Privacy-aware routing** -- the system must decide at runtime whether a given prompt can be sent to a cloud LLM (e.g., Claude, GPT-4) or must be handled by a local model (e.g., Nemotron).
- **Permission policies** -- fine-grained YAML-driven policies that govern what each agent persona can read, write, execute, and export.

NVIDIA's **NemoClaw** framework -- combining OpenShell sandboxed runtimes with Nemotron local language models -- provides exactly this capability. Integrating NemoClaw as a dedicated security plane addresses the gap without disrupting the existing four planes.

---

## 2. Decision

**Add NemoClaw as Panel 2 (Agent Security plane)**, shifting the numbering of subsequent panels:

| Original (Four-Plane) | Amended (Five-Plane)        |
| ---------------------- | --------------------------- |
| Panel 1 -- Maestro     | Panel 1 -- Maestro          |
| _(none)_               | **Panel 2 -- NemoClaw**     |
| Panel 2 -- Trigger.dev | Panel 3 -- Trigger.dev      |
| Panel 3 -- OPA         | Panel 4 -- OPA              |
| Panel 4 -- MinIO       | Panel 5 -- MinIO            |

NemoClaw sits between Maestro (orchestration) and Trigger.dev (execution) because every task dispatched by the orchestrator must pass through the security plane before execution begins. This placement enforces a **mandatory security checkpoint** in the autonomy loop.

---

## 3. Five-Plane Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    AURELIUS AUTONOMOUS WORKBENCH v2.1                    │
│                       (Electrobun + Bun Runtime)                         │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────┤
│   PANEL 1    │   PANEL 2    │   PANEL 3    │   PANEL 4    │  PANEL 5    │
│   MAESTRO    │  NEMOCLAW    │  TRIGGER.DEV │  OPA ENGINE  │ MINIO VAULT │
│  Orchestrate │  Sandbox     │  Execute     │  Evaluate    │ Store       │
│              │              │              │              │             │
│  Loop control│  Agent       │  LLM calls   │  Compliance  │ Artifacts   │
│  Scheduling  │  isolation   │  Modify      │  scoring     │ Audit trail │
│  Dashboard   │  Permission  │  Parse       │  OSCAL valid │ Learnings   │
│  Pipeline    │  policies    │  Generate    │  Proposal    │ Exports     │
│  Autonomy    │  Nemotron    │  Persona     │  rubric eval │ Versions    │
│  governor    │  local LLM   │  tasks       │  (WASM local)│ (S3 compat) │
├──────────────┴──────────────┴──────────────┴──────────────┴─────────────┤
│                          BUN MAIN PROCESS                                │
│  RPC handlers | IPC bridge | Autonomy scheduler | System tray            │
├──────────────────────────────────────────────────────────────────────────┤
│                    BACKEND SERVICES (Containers)                          │
│  Trigger.dev worker | OPA server | MinIO | OpenShell runtime | Nemotron  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Five-Plane Mapping Table

| Plane | Name              | Panel | Runtime / Engine       | Responsibility                                          |
| ----- | ----------------- | ----- | ---------------------- | ------------------------------------------------------- |
| 1     | Orchestration     | 1     | Maestro / Bun          | Loop control, scheduling, dashboard, autonomy governor   |
| 2     | Agent Security    | 2     | NemoClaw / OpenShell + Nemotron | Agent isolation, permission policies, privacy routing, local LLM |
| 3     | Task Execution    | 3     | Trigger.dev / Node.js 22 | LLM API calls, document parsing, content generation, persona tasks |
| 4     | Policy Evaluation | 4     | OPA / Bun FFI WASM     | Compliance scoring, OSCAL validation, rubric evaluation, proposal review |
| 5     | Artifact Storage  | 5     | MinIO / Container      | Artifact persistence, audit trail, learnings DB, exports, versioning (S3-compatible) |

---

## 5. NemoClaw Integration Rationale

### 5.1 Why NemoClaw

NemoClaw is NVIDIA's agent security framework designed for production autonomous AI systems. It provides three capabilities that the Aurelius Workbench requires:

1. **OpenShell Runtime** -- A sandboxed execution environment for AI agents. Each agent task runs inside an OpenShell container with a declarative policy that specifies allowed file paths, network endpoints, tool invocations, and resource limits. This prevents a compromised or misbehaving agent from accessing data or systems outside its designated scope.

2. **Nemotron Local Models** -- NVIDIA's Nemotron family of language models can run entirely on local hardware (GPU or CPU). The workbench uses Nemotron for:
   - **Prompt classification** -- determining whether a user prompt contains PII, CUI, or classified content before routing.
   - **Local summarization** -- generating summaries of sensitive documents without sending content to external APIs.
   - **Policy evaluation assistance** -- augmenting OPA decisions with natural-language reasoning about edge cases.

3. **Privacy Router** -- A configurable routing layer that examines each outbound LLM request and decides, based on content classification and policy, whether to route it to a cloud API (Claude, GPT-4) or handle it locally with Nemotron. This is essential for federal deployments where certain data categories must never leave the enclave.

### 5.2 OpenShell Policy Architecture

OpenShell policies are defined in YAML and loaded at task dispatch time. Each policy specifies:

- **Filesystem access**: read/write paths, denied paths
- **Network egress**: allowed endpoints and ports
- **Tool permissions**: which MCP tools the agent may invoke
- **Resource limits**: CPU, memory, execution time
- **Audit requirements**: what events must be logged

### 5.3 Privacy Router Configuration

The Privacy Router is configured via YAML and consulted on every outbound LLM call. It classifies prompts using Nemotron and routes them according to data sensitivity:

- **public** -- may be sent to any configured cloud LLM
- **internal** -- may be sent to cloud LLMs with contractual data protection (e.g., Claude with zero-retention)
- **sensitive** -- must be processed locally by Nemotron
- **classified** -- must be processed locally, and the prompt/response must be encrypted at rest

---

## 6. Updated Autonomy Architecture

The three autonomy levels are preserved but now incorporate NemoClaw sandboxing:

### Level 1 -- Supervised

- Maestro proposes each action and waits for human approval.
- NemoClaw enforces a **restrictive policy**: no network egress, read-only filesystem, no tool invocation without explicit approval.
- All LLM calls routed through Privacy Router with **local-only** default.

### Level 2 -- Semi-Autonomous

- Maestro executes pre-approved action types (e.g., search, summarize) without confirmation; novel actions require approval.
- NemoClaw enforces a **standard policy**: network egress to whitelisted endpoints, read-write within project directory, approved tool set.
- Privacy Router uses **classification-based** routing (public/internal to cloud, sensitive/classified to local).

### Level 3 -- Fully Autonomous

- Maestro executes all actions in the approved pipeline without human intervention, with a kill switch available.
- NemoClaw enforces a **permissive but audited policy**: broader network and filesystem access, full tool set, but every action is logged to the audit trail in MinIO.
- Privacy Router uses **classification-based** routing with additional anomaly detection -- if the agent's behavior deviates from expected patterns, NemoClaw downgrades to Level 2 automatically.

---

## 7. Consequences

### Positive

- **Mandatory security checkpoint**: Every task passes through NemoClaw before execution, preventing unauthorized actions even if Maestro or Trigger.dev is compromised.
- **Federal compliance**: OpenShell sandboxing and Privacy Router directly address FedRAMP AC-6 (least privilege), NIST 800-53 SC-7 (boundary protection), and CMMC Level 3 requirements.
- **Local inference capability**: Nemotron models enable the workbench to operate in air-gapped environments without any cloud LLM dependency.
- **Privacy by design**: The Privacy Router ensures sensitive data is never sent to external APIs, providing a verifiable data sovereignty guarantee.
- **Graceful degradation**: If cloud LLMs are unavailable, the workbench falls back to Nemotron for all inference, maintaining operational capability.

### Negative

- **Increased complexity**: Five planes are harder to reason about, deploy, and debug than four planes.
- **Resource requirements**: Nemotron models require GPU memory (or significant CPU resources for quantized variants), increasing the hardware baseline.
- **Latency overhead**: Every task dispatch now includes a NemoClaw policy check and potential Privacy Router classification step, adding latency to the autonomy loop.
- **Additional container**: OpenShell runtime adds another container to the deployment topology.

### Risks

- **NemoClaw maturity**: NemoClaw is a relatively new framework; APIs and policy formats may change, requiring migration effort.
- **Nemotron model quality**: Local models may produce lower-quality classifications or summaries compared to cloud LLMs, leading to incorrect routing decisions.
- **Policy misconfiguration**: Overly restrictive OpenShell policies could block legitimate agent actions; overly permissive policies could negate the security benefits.
- **GPU availability**: In environments without GPU access, Nemotron inference may be prohibitively slow, degrading the user experience.

### Mitigations

- Pin NemoClaw SDK version and maintain an abstraction layer to isolate from upstream API changes.
- Implement a dual-classification strategy: Nemotron classifies first, and if confidence is below threshold, escalate to human review.
- Provide policy templates for each autonomy level and validate policies against a test suite before deployment.
- Support quantized Nemotron variants (Q4, Q8) for CPU-only deployments with acceptable latency.

---

## 8. References

| Reference | Description |
| --------- | ----------- |
| [Karpathy Autoresearch](https://github.com/karpathy/autoresearch) | Andrej Karpathy's autonomous research agent pattern -- inspiration for the Maestro orchestration loop |
| [Palantir AI Hivemind](https://www.palantir.com/platforms/aip/) | Palantir's approach to multi-agent orchestration in defense contexts -- informed the autonomy level design |
| [NVIDIA NemoClaw](https://developer.nvidia.com/nemoclaw) | NVIDIA's agent security framework -- provides OpenShell runtime, Nemotron models, and Privacy Router |
| [Defense Unicorns UDS Core](https://github.com/defenseunicorns/uds-core) | Defense Unicorns' Unicorn Delivery Service -- Kubernetes distribution for air-gapped federal deployments, informs our container strategy |
| [NIST 800-53 Rev 5](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final) | Security and Privacy Controls for Information Systems -- the compliance baseline for federal deployments |
| [OSCAL](https://pages.nist.gov/OSCAL/) | Open Security Controls Assessment Language -- used by Panel 4 (OPA) for machine-readable compliance validation |

---

## Appendix: Migration from Four-Plane to Five-Plane

Existing four-plane deployments can migrate incrementally:

1. **Deploy NemoClaw containers** (OpenShell runtime + Nemotron) alongside existing services.
2. **Update Maestro dispatcher** to route tasks through NemoClaw before Trigger.dev.
3. **Configure Privacy Router** with a permissive initial policy (all traffic to cloud) and progressively tighten.
4. **Update panel numbering** in the Electrobun UI to reflect the five-plane layout.
5. **Validate** by running the existing test suite with NemoClaw in pass-through mode, then enable enforcement.

No data migration is required -- MinIO artifacts, OPA policies, and Trigger.dev workflows are unchanged.
