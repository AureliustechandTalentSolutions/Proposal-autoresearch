# Aurelius Autoresearch Agent -- User Guide

## Chapter 3: System Requirements & Prerequisites

This chapter details the hardware, software, API credentials, and network configuration required to run the Aurelius Autoresearch Agent. Meeting the recommended specifications will ensure stable performance during long-running autonomous research and proposal-generation workflows.

---

### 3.1 Hardware Requirements

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| CPU cores | 4 | 8+ | OPA policy evaluation and PDF parsing are CPU-bound |
| RAM | 8 GB | 16 GB | The Trigger.dev worker, Redis, and MinIO share memory |
| Disk space | 20 GB | 50 GB+ | MinIO artifact storage and Ollama model weights grow over time |
| GPU | None | NVIDIA with 8 GB+ VRAM | Required only when running local LLMs via Ollama |

> **Tip:** If you plan to use the `local-llm` Docker Compose profile to run Ollama locally, an NVIDIA GPU with the appropriate drivers and the NVIDIA Container Toolkit are required. CPU-only Ollama inference is possible but significantly slower.

### 3.2 Software Requirements

| Software | Required Version | Purpose |
|----------|-----------------|---------|
| **Python** | 3.11 or later (3.12 recommended) | Core agent runtime, FastAPI dashboard, scoring modules |
| **Bun** | 1.x | Fast installation of Trigger.dev task dependencies (alternative to npm) |
| **Node.js** | 22.0.0 or later | Trigger.dev v3 worker runtime (`engines.node >= 22.0.0` in `tasks/package.json`) |
| **Docker** | 24.0 or later | Containerized deployment of all services |
| **Docker Compose** | v2 (ships with Docker Desktop 4.x+) | Service orchestration via `docker-compose.yaml` |
| **Git** | 2.x | Cloning the repository |
| **curl** | Any modern version | Health-check verification |

#### Verifying installed versions

```bash
python3 --version          # expect 3.11+
bun --version              # expect 1.x
node --version             # expect v22.x
docker --version           # expect 24.x+
docker compose version     # expect v2.x
git --version              # expect 2.x
```

If any command is not found, install the corresponding tool before proceeding to Chapter 4.

### 3.3 API Keys & Credentials

The Aurelius Autoresearch Agent supports multiple LLM backends. You need **at least one** of the following:

| Variable | Provider | How to obtain |
|----------|----------|---------------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com/) -- create an API key under your organization |
| `OPENAI_API_KEY` | OpenAI / LeapfrogAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) or your LeapfrogAI deployment |
| *(none required)* | Ollama (local) | No API key needed; models are pulled on first use |

Additional service credentials (pre-configured with defaults in `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MINIO_USER` | `aurelius` | MinIO root username |
| `MINIO_PASSWORD` | `changeme123` | MinIO root password -- **change in production** |
| `TRIGGER_API_KEY` | `tr_dev_placeholder` | Trigger.dev project API key |
| `TRIGGER_PROJECT_ID` | `aurelius-workbench` | Trigger.dev project identifier |

### 3.4 Network Ports

The following ports must be available on the host machine. If any port conflicts with an existing service, override it via the corresponding environment variable in your `.env` file.

| Port | Service | Environment Variable | Protocol |
|------|---------|---------------------|----------|
| **8501** | Autoresearch Dashboard (Uvicorn) | `DASHBOARD_PORT` | HTTP |
| **8500** | Panel / Workbench Server | `WORKBENCH_PORT` | HTTP |
| **8181** | Open Policy Agent (OPA) | `OPA_PORT` | HTTP |
| **9000** | MinIO S3 API | `MINIO_API_PORT` | HTTP |
| **9001** | MinIO Web Console | `MINIO_CONSOLE_PORT` | HTTP |
| **6379** | Redis | `REDIS_PORT` | TCP |
| **11434** | Ollama (local LLM) | `OLLAMA_PORT` | HTTP |

> **Firewall note:** In a default development setup all ports bind to `0.0.0.0`. For production deployments, restrict binding to `127.0.0.1` or place services behind a reverse proxy.

### 3.5 Operating System Compatibility

| OS | Status |
|----|--------|
| Ubuntu 22.04 / 24.04 LTS | Fully supported |
| Debian 12 (Bookworm) | Fully supported |
| macOS 13+ (Ventura / Sonoma) with Docker Desktop | Supported |
| Windows 11 with WSL 2 + Docker Desktop | Supported |
| RHEL 9 / Rocky Linux 9 | Community-tested |

---

## Chapter 4: Installation Guide

This chapter walks through two installation paths: a Docker Compose deployment (recommended for most users) and a manual installation for development or customization. Both paths end with a verification checklist.

---

### 4.1 Clone the Repository

Regardless of installation method, start by cloning the project:

```bash
git clone https://github.com/your-org/aurelius-autoresearch-agent.git
cd aurelius-autoresearch-agent
```

### 4.2 Environment Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Open `.env` in your editor and configure the required values:

```dotenv
# ---- Required: set at least one LLM API key ----
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
# OPENAI_API_KEY=sk-...              # uncomment if using OpenAI / LeapfrogAI

# ---- LLM selection ----
LLM_PROVIDER=auto                     # auto | anthropic | openai | ollama
LLM_MODEL=claude-sonnet-4-20250514    # model identifier for the chosen provider
LOCAL_MODEL=nemotron:latest            # Ollama model name (used when provider=ollama)

# ---- MinIO credentials (change in production) ----
MINIO_USER=aurelius
MINIO_PASSWORD=changeme123

# ---- Trigger.dev ----
TRIGGER_API_KEY=tr_dev_placeholder
TRIGGER_PROJECT_ID=aurelius-workbench
```

The remaining variables (`OPA_ENDPOINT`, `REDIS_URL`, port numbers, etc.) have sensible defaults and usually do not need changes for local development.

---

### 4.3 Option A: Docker Compose (Recommended)

Docker Compose brings up the full stack -- the autoresearch agent, Trigger.dev worker, OPA, MinIO, and Redis -- with a single command.

#### Step 1 -- Build and start core services

```bash
docker compose up -d --build
```

This command builds two images from source (`autoresearch` from the root `Dockerfile` and `trigger-worker` from `tasks/Dockerfile`) and pulls three upstream images (`openpolicyagent/opa`, `minio/minio`, `redis:7-alpine`).

#### Step 2 -- (Optional) Enable local LLM with Ollama

If you want to run models locally instead of calling a cloud API, activate the `local-llm` profile:

```bash
docker compose --profile local-llm up -d
```

After the Ollama container is healthy, pull the model specified in your `.env`:

```bash
docker exec aurelius-ollama ollama pull nemotron:latest
```

> **Note:** The Ollama service reserves an NVIDIA GPU via Docker's device reservation. Ensure the NVIDIA Container Toolkit is installed (`nvidia-ctk --version`) and that your GPU driver supports CUDA.

#### Step 3 -- Verify service health

```bash
docker compose ps
```

All containers should show a status of **Up (healthy)**. Expected output:

```
NAME                      STATUS              PORTS
aurelius-autoresearch     Up (healthy)        0.0.0.0:8501->8501/tcp
aurelius-trigger-worker   Up (healthy)
aurelius-opa              Up (healthy)        0.0.0.0:8181->8181/tcp
aurelius-minio            Up (healthy)        0.0.0.0:9000->9000/tcp, 0.0.0.0:9001->9001/tcp
aurelius-redis            Up (healthy)        0.0.0.0:6379->6379/tcp
```

#### Step 4 -- Test health endpoints

```bash
# Dashboard / API
curl -s http://localhost:8501/health
# Expected: {"status":"ok"} or similar JSON

# OPA
curl -s http://localhost:8181/health
# Expected: {} (empty JSON object = healthy)

# MinIO
curl -s http://localhost:9000/minio/health/live
# Expected: HTTP 200

# Redis
docker exec aurelius-redis redis-cli ping
# Expected: PONG
```

#### Stopping and restarting

```bash
docker compose down          # stop all services, preserve volumes
docker compose down -v       # stop all services AND delete volumes (data loss)
docker compose up -d         # restart without rebuilding
docker compose up -d --build # restart with a fresh build
```

---

### 4.4 Option B: Manual Installation

Use this path when you need to run components outside containers -- for example, during active Python development with hot-reload or when debugging Trigger.dev tasks.

#### Step 1 -- Create a Python virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate    # Linux / macOS
# .venv\Scripts\activate     # Windows (PowerShell)
```

#### Step 2 -- Install the Python package in editable mode

```bash
pip install -e ".[dev]"
```

This installs the core agent (`anthropic`, `openai`, `pydantic`, `fastapi`, `uvicorn`, `httpx`, etc.) along with development dependencies (`pytest`, `pytest-asyncio`).

#### Step 3 -- Install Trigger.dev task dependencies

```bash
cd tasks
bun install          # preferred -- fast, lockfile-compatible
# npm install        # alternative if Bun is not available
cd ..
```

#### Step 4 -- Start infrastructure services

Even in manual mode the supporting services are easiest to run via Docker:

```bash
docker compose up -d opa minio redis
```

Wait for all three to report healthy:

```bash
docker compose ps opa minio redis
```

#### Step 5 -- Start the dashboard server

```bash
source .venv/bin/activate
python -m uvicorn dashboard.app:app --host 0.0.0.0 --port 8501 --reload
```

The `--reload` flag enables automatic reloading when Python source files change.

#### Step 6 -- Start the Trigger.dev worker

In a separate terminal:

```bash
cd tasks
npx trigger dev
```

The worker connects to the Trigger.dev API URL specified in `.env` and begins polling for jobs.

---

### 4.5 Verification & First-Run Checklist

After completing either Option A or Option B, work through the checklist below to confirm the system is fully operational.

| # | Check | Command / Action | Expected Result |
|---|-------|-----------------|-----------------|
| 1 | Dashboard reachable | Open `http://localhost:8501` in a browser | Dashboard UI loads without errors |
| 2 | API health endpoint | `curl http://localhost:8501/health` | JSON response with `status: ok` |
| 3 | OPA policy engine | `curl http://localhost:8181/v1/policies` | JSON listing loaded policies |
| 4 | MinIO console | Open `http://localhost:9001` in a browser | Login page appears; sign in with `MINIO_USER` / `MINIO_PASSWORD` |
| 5 | Redis connectivity | `docker exec aurelius-redis redis-cli ping` | `PONG` |
| 6 | Ollama (if enabled) | `curl http://localhost:11434/api/tags` | JSON listing available models |
| 7 | LLM connectivity | Submit a test prompt through the dashboard | Agent returns a generated response |
| 8 | Trigger worker | Check worker logs: `docker logs aurelius-trigger-worker` | No error traces; "connected" or "waiting for tasks" messages |

### 4.6 Troubleshooting Common Installation Issues

**Port already in use**
Override the conflicting port in `.env`. For example, to move the dashboard to port 8510:

```dotenv
DASHBOARD_PORT=8510
```

Then restart: `docker compose up -d`.

**Docker build fails on pip install**
Ensure you are running Docker 24+ with BuildKit enabled. If a dependency fails to compile, check that the base image (`python:3.12-slim`) has the necessary system libraries, or add them to the `Dockerfile`.

**Ollama GPU not detected**
Verify the NVIDIA Container Toolkit is installed:

```bash
nvidia-ctk --version
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

If `nvidia-smi` does not run inside the container, the toolkit or driver needs reinstalling.

**MinIO health check fails**
MinIO requires a few seconds after startup. If the health check still fails after 60 seconds, inspect logs:

```bash
docker logs aurelius-minio
```

Common causes include insufficient disk space or permission errors on the volume mount.

**Redis refuses connections**
Confirm no other Redis instance is bound to port 6379:

```bash
ss -tlnp | grep 6379
```

If another service holds the port, either stop it or change `REDIS_PORT` in `.env`.

---

*Next: Chapter 5 covers the Quick-Start Tutorial, walking through your first autonomous research run from prompt to generated deliverable.*
