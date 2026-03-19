# Aurelius Autoresearch Agent — User Guide

## Chapter 9: Web Dashboard

The Aurelius dashboard is a FastAPI web application that provides real-time visibility into autoresearch runs.

---

### 9.1 Starting the Dashboard

#### Via CLI

```bash
aurelius-autoresearch dashboard
```

This starts the dashboard on the port specified by `DASHBOARD_PORT` (default: 8501).

#### Via Docker Compose

The dashboard starts automatically with the `autoresearch` service:

```bash
docker compose up -d
```

Access the dashboard at `http://localhost:8501`.

### 9.2 Dashboard Features

| Feature | Description |
|---------|-------------|
| **Run list** | All past and active runs with status, scores, and improvement percentages |
| **Live progress** | Real-time Server-Sent Events stream showing iteration-by-iteration progress |
| **Start new run** | Form to configure and launch a new optimization run |
| **Cancel run** | Stop an in-progress run gracefully |
| **View report** | Rendered Markdown report with score summary, iteration history, and learnings |

### 9.3 Dashboard API Reference

#### List All Runs

```
GET /api/runs
```

Response:

```json
{
  "runs": [
    {
      "run_id": "a1b2c3d4",
      "status": "COMPLETED",
      "mode": "proposal",
      "baseline_score": 62.5,
      "final_score": 90.2,
      "total_improvement": 27.7,
      "improvement_percentage": 44.3,
      "halt_reason": "threshold",
      "iterations": 18
    }
  ]
}
```

#### Get Run Details

```
GET /api/runs/{run_id}
```

Returns the full `result.json` for completed runs or `progress.yaml` for in-progress runs.

#### Live Progress Stream (SSE)

```
GET /api/runs/{run_id}/progress
```

Returns a Server-Sent Events stream:

```
event: progress
data: {"run_id":"a1b2c3d4","current_iteration":5,"current_score":72.3,...}

event: progress
data: {"run_id":"a1b2c3d4","current_iteration":6,"current_score":74.1,...}

event: done
data: {"run_id":"a1b2c3d4","status":"COMPLETED",...}
```

The stream polls `progress.yaml` every 2 seconds and sends updates when the data changes.

#### Get Run Report

```
GET /api/runs/{run_id}/report
```

Response:

```json
{"report": "# Autoresearch Run Report: a1b2c3d4\n\n..."}
```

#### Start a New Run

```
POST /api/runs
Content-Type: application/json

{
  "mode": "proposal",
  "target_path": "workspace/technical-volume.md",
  "metric": "composite",
  "threshold": 90.0,
  "max_iterations": 25
}
```

**Security:** The `target_path` is validated to prevent path traversal — it must exist and reside within the workspace or project directory.

#### Cancel a Run

```
DELETE /api/runs/{run_id}
```

Response:

```json
{"run_id": "a1b2c3d4", "status": "cancelling"}
```

### 9.4 MinIO Console

MinIO provides its own web console for browsing stored artifacts:

- **URL:** `http://localhost:9001`
- **Credentials:** `MINIO_USER` / `MINIO_PASSWORD` from `.env`

Use the console to:

- Browse artifact snapshots per run
- Download audit logs and reports
- Manage storage buckets

---

## Chapter 10: Advanced Topics

### 10.1 Scheduled Autonomous Tasks

The autonomy configuration (`config/autonomy.yaml`) defines cron-based and folder-watch triggers:

| Task | Schedule | Description |
|------|----------|-------------|
| `compliance_scan` | Daily at 2:00 AM | Full compliance evaluation across all artifacts |
| `proposal_review` | Weekdays at 8:00 AM | Score in-progress proposal drafts |
| `rfp_watch` | Every 5 min (folder poll) | Detect new RFP uploads in `/workspace/rfps/raw` |
| `compliance_drift` | Every 6 hours | Detect compliance drift in modified artifacts |
| `learnings_consolidation` | Friday at 10:00 PM | Weekly synthesis of learnings into meta-knowledge |

Enable or disable individual tasks:

```yaml
schedule:
  compliance_scan:
    enabled: true
  rfp_watch:
    enabled: false
```

### 10.2 Notification System

Notifications can be sent to multiple channels:

#### Email Notifications

```yaml
notifications:
  channels:
    - type: "email"
      recipients: ["team-lead@example.com"]
      events: ["loop_completed", "approval_required", "compliance_alert", "error"]
```

#### Webhook Notifications

```yaml
notifications:
  channels:
    - type: "webhook"
      url: "http://localhost:9090/hooks/aurelius"
      events: ["loop_completed", "approval_required", "compliance_alert", "error", "rfp_detected"]
```

#### Log File

```yaml
notifications:
  channels:
    - type: "log"
      path: "/workspace/logs/autonomy.log"
      events: ["*"]  # Log everything
```

#### Escalation

If an approval request is not acted on:

- **Reminder** after 30 minutes
- **Escalation** to manager after 120 minutes

### 10.3 Local LLM with Ollama + Nemotron

For air-gapped or CUI-sensitive deployments, run Nemotron locally:

#### Start Ollama

```bash
docker compose --profile local-llm up -d ollama
```

#### Download Models

```bash
docker exec aurelius-ollama ollama pull nemotron:70b-q4_K_M
docker exec aurelius-ollama ollama pull nemotron:22b-q8_0
```

#### Configure

Set in `.env`:

```bash
LLM_PROVIDER=ollama
LOCAL_MODEL=nemotron:70b-q4_K_M
OLLAMA_ENDPOINT=http://localhost:11434
```

Or use `LLM_PROVIDER=auto` with `PRIVACY_ROUTER_CONFIG=local-first` to let the privacy router decide per-request.

#### Hardware Requirements

| Model | VRAM | Quantization | Speed (tok/s) |
|-------|------|-------------|---------------|
| `nemotron:70b-q4_K_M` | 24 GB+ | 4-bit | ~15 |
| `nemotron:22b-q8_0` | 16 GB | 8-bit | ~30 |

### 10.4 Multi-Run Comparison

After multiple runs, compare results across run directories:

```bash
# List all completed runs with scores
for d in runs/*/result.json; do
  run_id=$(basename $(dirname $d))
  score=$(python3 -c "import json; r=json.load(open('$d')); print(f\"{r['baseline_score']:.1f} → {r['final_score']:.1f} ({r['halt_reason']})\")")
  echo "$run_id: $score"
done
```

### 10.5 Learnings Accumulation

The learnings store (`agent/learnings.py`) persists insights across iterations within a run. Each learning records:

- **Iteration number**
- **Hypothesis description**
- **Decision** (KEEP/DISCARD)
- **Score delta**
- **Insight** (why the decision was made)

Learnings are fed back to the hypothesis generator, enabling the LLM to avoid repeating failed strategies and build on successful ones.

#### Weekly Consolidation

The `learnings_consolidation` scheduled task (Friday 10 PM) aggregates learnings across all runs into meta-knowledge patterns, such as:

- "Readability improvements above grade 10 are consistently discarded"
- "Adding past-performance matrices improves traceability by 15–20%"
- "Win theme reinforcement in executive summaries yields the highest delta"

### 10.6 Extending the Scoring Engine

To add a custom scorer:

1. Create a new file in `scorers/`:

```python
from scorers import Scorer

class MyCustomScorer(Scorer):
    @property
    def direction(self):
        return "higher_is_better"

    def describe(self):
        return "My custom metric"

    async def score(self, artifact_content, context=None):
        # Your scoring logic
        return 85.0
```

2. Add it to the `CompositeScorer` configuration:

```python
from scorers.composite_scorer import CompositeScorer
from scorers.my_custom_scorer import MyCustomScorer

scorer = CompositeScorer(scorers={
    "custom": (MyCustomScorer(), 0.20),
    "readability": (ReadabilityScorer(), 0.80),
})
```

### 10.7 Custom Constraint Types

To add a new constraint validation type:

1. Add a new method to `ConstraintValidator` in `agent/constraints.py`:

```python
def _check_my_constraint(self, content, params, metadata):
    # Your validation logic
    if not valid:
        return False, "Explanation of violation"
    return True, ""
```

2. Register it in the `validators` dictionary within `_check()`.

3. Use it in configuration:

```yaml
constraints:
  - name: "My constraint"
    validation_type: "my_constraint"
    parameters: { key: value }
    on_violation: "DISCARD"
```

### 10.8 Trigger.dev Task Development

Tasks are defined in `tasks/src/` and use the Trigger.dev v3 SDK.

#### Task Structure

```typescript
import { task } from "@trigger.dev/sdk/v3";

export const myTask = task({
  id: "my-task",
  run: async (payload) => {
    // Task logic
    return { result: "done" };
  },
});
```

#### Running the Worker Locally

```bash
cd tasks
bun install
npx trigger-dev@latest dev
```

### 10.9 Production Deployment Checklist

Before deploying to production:

- [ ] Change `MINIO_PASSWORD` from the default
- [ ] Set real `ANTHROPIC_API_KEY` and `TRIGGER_API_KEY`
- [ ] Set `AUTONOMY_CONFIG=supervised` initially
- [ ] Configure email notifications for `approval_required` and `error` events
- [ ] Review and enable only needed scheduled tasks
- [ ] Set `OPA_LOG_LEVEL=error` to reduce log volume
- [ ] Configure `REDIS_MAXMEMORY` based on expected workload
- [ ] Enable TLS for all external-facing endpoints
- [ ] Set up backup for MinIO data volume
- [ ] Review OpenShell agent policies for your security posture

### 10.10 Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No hypotheses generated" | LLM API error or rate limit | Check API key, retry, or switch to local model |
| Run halts immediately | HALT constraint violated on first modification | Review constraints; ensure target artifact meets baseline requirements |
| Score never improves | Threshold too high or wrong scorer config | Lower threshold, adjust scorer weights, or add more iterations |
| OPA returns 404 | Policy not loaded | `docker compose restart opa`, check policy syntax |
| Dashboard shows "unknown" status | `progress.yaml` not written | Check disk permissions on `runs/` directory |
| Ollama timeout | Model not downloaded or insufficient VRAM | Run `ollama pull`, check GPU memory |
| Redis connection refused | Redis not started | `docker compose up -d redis` |
| Privacy router sends everything local | Default safety rule catching all requests | Set `PRIVACY_ROUTER_CONFIG=hybrid` and verify data classification |
