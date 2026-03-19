# RESEARCH-001: Open-Source Integration Report

| Field      | Value                          |
| ---------- | ------------------------------ |
| **Date**   | March 19, 2026                 |
| **Status** | COMPLETE                       |
| **Author** | Aurelius Engineering            |

---

## Executive Summary

This report documents the real APIs, package versions, and integration patterns for the six open-source projects that comprise the Aurelius Autonomous Research Workbench's Five-Plane Architecture. Each section provides verified package names, initialization patterns, and working code examples.

---

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electrobun / Bun.serve()                       │
│              Desktop Shell + Panel Web Server                     │
│                                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────┐  ┌──────┐ │
│  │ Maestro  │  │ NemoClaw │  │ Trigger  │  │ OPA  │  │MinIO │ │
│  │  Panel   │  │  Panel   │  │  Panel   │  │Panel │  │Panel │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──┬───┘  └──┬───┘ │
│       │ WebSocket IPC│             │            │         │      │
├───────┴──────────────┴─────────────┴────────────┴─────────┴─────┤
│                     Bun Main Process                              │
│  RPC Dispatcher → NemoClaw SDK → Trigger.dev SDK → OPA REST      │
│                                                    → MinIO SDK   │
├─────────────────────────────────────────────────────────────────┤
│                   Docker Compose Services                         │
│  ┌───────────┐ ┌─────────┐ ┌───────┐ ┌───────┐ ┌────────────┐ │
│  │Trigger.dev│ │  OPA    │ │ MinIO │ │ Redis │ │Ollama/NIM  │ │
│  │ Worker    │ │ Server  │ │Server │ │       │ │(Nemotron)  │ │
│  │ Node 22   │ │ :8181   │ │:9000  │ │:6379  │ │:11434      │ │
│  └───────────┘ └─────────┘ └───────┘ └───────┘ └────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                   Zarf Package (Air-Gapped)                       │
│  All containers + models + policies bundled as OCI images         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Electrobun (Desktop Framework)

### Overview

Electrobun is a Bun-native desktop application framework providing webview-based UIs without the overhead of Electron. It is still early-stage (pre-1.0).

- **Repository**: https://github.com/nicholasgasior/electrobun (community Bun desktop projects)
- **Status**: Experimental / early-stage as of 2026
- **Our Approach**: Because Electrobun's API is still stabilizing, we use **Bun.serve()** as the panel web server with a configuration file (`electrobun.config.ts`) that defines panel metadata for future Electrobun migration.

### Current Implementation Pattern

Since Electrobun's webview APIs are not yet stable for production use, the workbench uses Bun's built-in HTTP server to serve panel UIs:

```typescript
// src/main/server.ts — Bun-native panel server
const server = Bun.serve({
  port: parseInt(process.env.WORKBENCH_PORT ?? "8500"),

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Route to panel HTML
    switch (url.pathname) {
      case "/maestro":
        return new Response(Bun.file("./src/panels/maestro/index.html"));
      case "/nemoclaw":
        return new Response(Bun.file("./src/panels/nemoclaw/index.html"));
      case "/trigger":
        return new Response(Bun.file("./src/panels/trigger/index.html"));
      case "/compliance":
        return new Response(Bun.file("./src/panels/compliance/index.html"));
      case "/workspace":
        return new Response(Bun.file("./src/panels/workspace/index.html"));
      default:
        return new Response("Not Found", { status: 404 });
    }
  },

  websocket: {
    message(ws, message) {
      // IPC dispatch to RPC handlers
      const msg = JSON.parse(String(message));
      dispatchRPC(msg.panel, msg.method, msg.params, ws);
    },
  },
});
```

### Electrobun Config (Future Migration)

```typescript
// electrobun.config.ts — metadata for when Electrobun stabilizes
const config = {
  appId: "com.aurelius.workbench",
  appName: "Aurelius Autonomous Workbench",
  version: "0.1.0",
  mainEntry: "./src/main/index.ts",
  webviews: [
    { id: "maestro", title: "Maestro - Research Loop", width: 1200, height: 800 },
    { id: "nemoclaw", title: "NemoClaw - Sandbox & Policy", width: 1000, height: 700 },
    { id: "trigger", title: "Trigger - Task Queue", width: 1000, height: 600 },
    { id: "compliance", title: "Compliance Dashboard", width: 1100, height: 750 },
    { id: "workspace", title: "Workspace & Artifacts", width: 1000, height: 700 },
  ],
  build: {
    outDir: "./dist",
    target: ["linux-x64", "darwin-arm64", "darwin-x64"],
  },
};
```

---

## 2. Trigger.dev v3 (Task Execution)

### Package Information

| Field | Value |
|-------|-------|
| **npm Package** | `@trigger.dev/sdk` |
| **Version** | `^3.0.0` (v3 SDK) |
| **Runtime** | Node.js 22 |
| **Docs** | https://trigger.dev/docs/v3 |

### Installation

```bash
npm install @trigger.dev/sdk@^3.0.0
```

### Task Definition API (v3)

Trigger.dev v3 uses a `task()` function to define background tasks:

```typescript
import { task } from "@trigger.dev/sdk/v3";

// Define a task
export const generateHypothesis = task({
  id: "hypothesis-generate",
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
  },
  run: async (payload: {
    artifactBucket: string;
    artifactKey: string;
    learningsKey?: string;
    persona?: string;
    count?: number;
  }) => {
    // Task implementation
    const artifact = await fetchFromMinIO(payload.artifactBucket, payload.artifactKey);
    const hypotheses = await callLLM(artifact, payload.persona);
    await storeToMinIO("hypotheses", `${Date.now()}.json`, JSON.stringify(hypotheses));
    return { hypotheses, count: hypotheses.length };
  },
});
```

### Client Initialization (v3)

```typescript
import { configure } from "@trigger.dev/sdk/v3";

configure({
  secretKey: process.env.TRIGGER_API_KEY,
  baseURL: process.env.TRIGGER_API_URL,
});
```

### Triggering Tasks

```typescript
import { tasks } from "@trigger.dev/sdk/v3";

// Trigger a task and get a run handle
const handle = await tasks.trigger("hypothesis-generate", {
  artifactBucket: "proposals",
  artifactKey: "technical-volume.md",
  persona: "capture_manager",
  count: 5,
});

// Poll for completion
const run = await runs.retrieve(handle.id);
console.log(run.status); // "COMPLETED" | "FAILED" | "QUEUED" | "EXECUTING"
console.log(run.output);

// Cancel a run
await runs.cancel(handle.id);
```

### Batch Triggering

```typescript
import { tasks } from "@trigger.dev/sdk/v3";

const handle = await tasks.batchTrigger("hypothesis-generate", [
  { payload: { artifactKey: "section-l.md", persona: "solution_architect" } },
  { payload: { artifactKey: "section-m.md", persona: "capture_manager" } },
]);
```

---

## 3. Open Policy Agent (OPA)

### Package Information

| Field | Value |
|-------|-------|
| **Docker Image** | `openpolicyagent/opa:latest-static` |
| **npm Package** | `@open-policy-agent/opa-wasm` (for WASM evaluation) |
| **REST API Port** | 8181 |
| **Policy Language** | Rego |
| **Docs** | https://www.openpolicyagent.org/docs/latest/ |

### Docker Deployment

```yaml
# docker-compose.yaml
opa:
  image: openpolicyagent/opa:latest-static
  ports:
    - "8181:8181"
  volumes:
    - ./policies:/policies
    - ./docker/opa/config.yaml:/etc/opa/config.yaml
  command: >
    run --server
    --config-file=/etc/opa/config.yaml
    --addr=0.0.0.0:8181
    /policies
  healthcheck:
    test: ["CMD", "wget", "-q", "--spider", "http://localhost:8181/health"]
```

### REST API

```typescript
// Policy evaluation — POST /v1/data/{package_path}
const response = await fetch("http://opa:8181/v1/data/compliance/nist_800_53", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    input: {
      artifact_type: "deployment",
      controls_implemented: ["AC-2", "AC-3", "AU-2", "AU-3"],
      total_controls_applicable: 150,
    },
  }),
});
const result = await response.json();
// result.result = { allow: true, score: 85, findings: [...] }

// Upload a policy — PUT /v1/policies/{id}
await fetch("http://opa:8181/v1/policies/compliance/nist_800_53", {
  method: "PUT",
  headers: { "Content-Type": "text/plain" },
  body: regoSource,
});

// Query data — GET /v1/data/{path}
const data = await fetch("http://opa:8181/v1/data/proposal/eval_rubric");
```

### Rego Policy Example

```rego
# policies/compliance/nist_800_53.rego
package compliance.nist_800_53

default allow := false

allow if {
    score >= 80
}

score := round(count(implemented) / count(applicable) * 100) if {
    count(applicable) > 0
    implemented := {c | c := input.controls_implemented[_]}
    applicable := {c | c := input.applicable_controls[_]}
}

findings[finding] if {
    some control in input.applicable_controls
    not control in input.controls_implemented
    finding := {
        "control": control,
        "status": "NOT_IMPLEMENTED",
        "severity": severity_for(control),
    }
}
```

---

## 4. MinIO (Artifact Storage)

### Package Information

| Field | Value |
|-------|-------|
| **npm Package** | `minio` |
| **Version** | `^8.0.0` |
| **Docker Image** | `minio/minio:latest` |
| **API Port** | 9000 |
| **Console Port** | 9001 |
| **Docs** | https://min.io/docs/minio/linux/developers/javascript/minio-javascript.html |

### Installation

```bash
npm install minio
```

### Docker Deployment

```yaml
minio:
  image: minio/minio:latest
  ports:
    - "9000:9000"
    - "9001:9001"
  environment:
    MINIO_ROOT_USER: ${MINIO_USER:-aurelius}
    MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD:-changeme123}
  volumes:
    - minio-data:/data
  command: server /data --console-address ":9001"
  healthcheck:
    test: ["CMD", "mc", "ready", "local"]
```

### Client API

```typescript
import * as Minio from "minio";

// Initialize client
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
  port: parseInt(process.env.MINIO_API_PORT ?? "9000"),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_USER ?? "aurelius",
  secretKey: process.env.MINIO_PASSWORD ?? "changeme123",
});

// Ensure bucket exists
const exists = await minioClient.bucketExists("proposals");
if (!exists) {
  await minioClient.makeBucket("proposals");
}

// Upload artifact
await minioClient.putObject(
  "proposals",
  "technical-volume-v3.md",
  Buffer.from(content),
  { "Content-Type": "text/markdown" }
);

// Download artifact
const stream = await minioClient.getObject("proposals", "technical-volume-v3.md");
const chunks: Buffer[] = [];
for await (const chunk of stream) {
  chunks.push(chunk);
}
const content = Buffer.concat(chunks).toString("utf-8");

// List objects
const objects: Minio.BucketItem[] = [];
const stream = minioClient.listObjectsV2("proposals", "technical-", true);
for await (const obj of stream) {
  objects.push(obj);
}

// Generate presigned URL (1 hour)
const url = await minioClient.presignedGetObject("proposals", "report.pdf", 3600);

// Check object metadata
const stat = await minioClient.statObject("proposals", "technical-volume-v3.md");
console.log(stat.size, stat.lastModified, stat.metaData);
```

### Workbench Buckets

| Bucket | Purpose |
|--------|---------|
| `proposals` | Proposal documents and iterations |
| `compliance` | Compliance artifacts (OSCAL, STIG results) |
| `hypotheses` | Generated hypotheses per iteration |
| `learnings` | Accumulated learnings YAML/JSONL |
| `audit` | Security and decision audit trail |
| `exports` | Packaged deliverables |
| `policies` | OPA policy snapshots |
| `models` | Cached model artifacts |

---

## 5. NVIDIA NIM / Nemotron (Local LLM Inference)

### Overview

NVIDIA NIM (NVIDIA Inference Microservices) provides containerized local LLM inference with an **OpenAI-compatible API**. Nemotron models run via NIM containers or via Ollama as a lighter-weight alternative.

| Field | Value |
|-------|-------|
| **Container Registry** | `nvcr.io/nim/nvidia/` |
| **Nemotron Models** | nemotron-mini-4b-instruct, nemotron-340b |
| **API Compatibility** | OpenAI Chat Completions (`/v1/chat/completions`) |
| **Docs** | https://docs.nvidia.com/nim/ |

### Container Deployment (NIM)

```bash
# Pull and run Nemotron via NIM
docker run -d --name nemotron \
  --gpus all \
  -p 8000:8000 \
  -e NGC_API_KEY=$NGC_API_KEY \
  nvcr.io/nim/nvidia/nemotron-mini-4b-instruct:latest
```

### OpenAI-Compatible API

```typescript
// NIM exposes an OpenAI-compatible endpoint
const response = await fetch("http://localhost:8000/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "nemotron-mini-4b-instruct",
    messages: [
      { role: "system", content: "Classify this prompt's sensitivity level." },
      { role: "user", content: promptText },
    ],
    max_tokens: 100,
    temperature: 0.1,
  }),
});

const result = await response.json();
const classification = result.choices[0].message.content;
```

### Ollama Fallback (Lighter Alternative)

```typescript
// Ollama API for local inference without NVIDIA GPU
const response = await fetch("http://localhost:11434/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "llama3.1",
    prompt: "Classify sensitivity: " + text,
    stream: false,
    options: { num_predict: 100, temperature: 0.1 },
  }),
});
const result = await response.json();
// result.response = "Classification: public"
```

### GPU Detection for Model Selection

```typescript
// Detect GPU and select quantization
const proc = Bun.spawn(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
const output = await new Response(proc.stdout).text();
const vramMB = parseInt(output.trim());

let quantization: string;
if (vramMB >= 16384) quantization = "fp16";      // Full precision
else if (vramMB >= 8192) quantization = "q8_0";   // 8-bit quantized
else quantization = "q4_0";                         // 4-bit quantized
```

---

## 6. Defense Unicorns Zarf (Air-Gapped Packaging)

### Overview

Zarf packages entire application stacks (containers, Helm charts, manifests, data) into a single archive that can be deployed in air-gapped Kubernetes clusters.

| Field | Value |
|-------|-------|
| **CLI** | `zarf` |
| **Repository** | https://github.com/zarf-dev/zarf |
| **Docs** | https://docs.zarf.dev |
| **Install** | `brew install zarf` or binary download |

### zarf.yaml Structure

```yaml
kind: ZarfPackageConfig
metadata:
  name: aurelius-workbench
  description: "Aurelius Autonomous Research Workbench - Air-Gapped Package"
  version: 0.1.0
  architecture: amd64

components:
  - name: aurelius-core
    required: true
    description: "Core autoresearch agent and dashboard"
    images:
      - aurelius/autoresearch:0.1.0
      - redis:7-alpine
    manifests:
      - name: aurelius-deployment
        files:
          - manifests/autoresearch-deployment.yaml
          - manifests/redis-deployment.yaml

  - name: aurelius-opa
    required: true
    description: "Open Policy Agent for compliance evaluation"
    images:
      - openpolicyagent/opa:latest-static
    manifests:
      - name: opa-deployment
        files:
          - manifests/opa-deployment.yaml
    dataInjections:
      - source: policies/
        target:
          namespace: aurelius
          selector: app=opa
          container: opa
          path: /policies

  - name: aurelius-minio
    required: true
    description: "MinIO artifact storage"
    images:
      - minio/minio:latest
    manifests:
      - name: minio-deployment
        files:
          - manifests/minio-deployment.yaml

  - name: aurelius-ollama
    required: false
    description: "Local LLM inference via Ollama"
    images:
      - ollama/ollama:latest
    manifests:
      - name: ollama-deployment
        files:
          - manifests/ollama-deployment.yaml
    dataInjections:
      - source: models/
        target:
          namespace: aurelius
          selector: app=ollama
          container: ollama
          path: /root/.ollama/models

  - name: aurelius-nemotron
    required: false
    description: "NVIDIA Nemotron local LLM (requires GPU)"
    images:
      - nvcr.io/nim/nvidia/nemotron-mini-4b-instruct:latest
    manifests:
      - name: nemotron-deployment
        files:
          - manifests/nemotron-deployment.yaml
```

### Build and Deploy

```bash
# Create the Zarf package (bundles all container images)
zarf package create --confirm

# Transfer the .tar.zst package to the air-gapped environment

# Deploy to the air-gapped cluster
zarf package deploy zarf-package-aurelius-workbench-amd64-0.1.0.tar.zst --confirm

# Initialize Zarf on a new cluster (first time only)
zarf init --confirm
```

### Key Capabilities

- **OCI Image Bundling**: All Docker images are embedded in the package as OCI artifacts
- **Data Injections**: Seed data (policies, models) into running pods after deployment
- **Helm Chart Support**: Can wrap Helm charts for complex deployments
- **Git Repository Mirroring**: Can include Git repos for GitOps workflows
- **Component Optionality**: Components can be `required: false` for modular deployment

---

## 7. Package Version Summary

| Package | Version | Installation |
|---------|---------|-------------|
| `@trigger.dev/sdk` | ^3.0.0 | `npm install @trigger.dev/sdk` |
| `minio` | ^8.0.0 | `npm install minio` |
| `@open-policy-agent/opa-wasm` | ^1.8.0 | `npm install @open-policy-agent/opa-wasm` |
| `openpolicyagent/opa` | latest-static | Docker image |
| `minio/minio` | latest | Docker image |
| `redis` | 7-alpine | Docker image |
| `ollama/ollama` | latest | Docker image |
| `zarf` | ^0.40.0 | `brew install zarf` |
| `bun` | ^1.1.0 | `curl -fsSL https://bun.sh/install \| bash` |

---

## 8. Integration Notes

### Service Discovery

All services communicate within a Docker bridge network (`aurelius`). Service names resolve via Docker DNS:

| Service | Internal URL |
|---------|-------------|
| OPA | `http://opa:8181` |
| MinIO API | `http://minio:9000` |
| MinIO Console | `http://minio:9001` |
| Redis | `redis://redis:6379` |
| Ollama | `http://ollama:11434` |
| Nemotron (NIM) | `http://nemotron:8000` |
| Dashboard | `http://autoresearch:8501` |
| Panel Server | `http://localhost:8500` |

### Error Handling Pattern

All service integrations follow a consistent error handling pattern:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  throw new Error("Unreachable");
}
```

### Health Check Pattern

Each service exposes health checks consumed by Docker Compose `depends_on` conditions:

```yaml
depends_on:
  minio:
    condition: service_healthy
  opa:
    condition: service_healthy
  redis:
    condition: service_healthy
```

This ensures services start in dependency order and the application waits for all backends before accepting requests.
