"""FastAPI web dashboard for the autoresearch agent."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sse_starlette.sse import EventSourceResponse

logger = logging.getLogger(__name__)

app = FastAPI(title="Aurelius Autoresearch Agent", version="0.1.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Paths
BASE_DIR = Path(__file__).parent.parent
RUNS_DIR = BASE_DIR / "runs"
RUNS_DIR.mkdir(exist_ok=True)

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Mount static files if directory exists
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Active loops storage
active_loops: dict[str, Any] = {}


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Serve the dashboard."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/runs")
async def list_runs():
    """List all runs."""
    runs = []
    if RUNS_DIR.exists():
        for run_dir in sorted(RUNS_DIR.iterdir(), reverse=True):
            if not run_dir.is_dir() or run_dir.name.startswith("."):
                continue

            run_info = {"run_id": run_dir.name, "status": "unknown"}

            # Try to read result.json first (completed runs)
            result_path = run_dir / "result.json"
            if result_path.exists():
                try:
                    data = json.loads(result_path.read_text())
                    run_info.update({
                        "status": "COMPLETED",
                        "mode": data.get("config", {}).get("mode", "unknown"),
                        "baseline_score": data.get("baseline_score", 0),
                        "final_score": data.get("final_score", 0),
                        "total_improvement": data.get("total_improvement", 0),
                        "improvement_percentage": data.get("improvement_percentage", 0),
                        "halt_reason": data.get("halt_reason", ""),
                        "started_at": data.get("started_at", ""),
                        "completed_at": data.get("completed_at", ""),
                        "iterations": len(data.get("iterations", [])),
                    })
                except (json.JSONDecodeError, KeyError):
                    pass

            # Try progress.yaml for running/in-progress runs
            progress_path = run_dir / "progress.yaml"
            if progress_path.exists() and "mode" not in run_info:
                try:
                    data = yaml.safe_load(progress_path.read_text())
                    if data:
                        run_info.update({
                            "status": data.get("status", "unknown"),
                            "current_iteration": data.get("current_iteration", 0),
                            "current_score": data.get("current_score", 0),
                            "baseline_score": data.get("baseline_score", 0),
                            "improvement": data.get("improvement", 0),
                        })
                except yaml.YAMLError:
                    pass

            runs.append(run_info)
    return {"runs": runs}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str):
    """Get specific run details."""
    run_dir = RUNS_DIR / run_id
    if not run_dir.exists():
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    result_path = run_dir / "result.json"
    if result_path.exists():
        return json.loads(result_path.read_text())

    progress_path = run_dir / "progress.yaml"
    if progress_path.exists():
        return yaml.safe_load(progress_path.read_text())

    raise HTTPException(status_code=404, detail=f"No data found for run {run_id}")


@app.get("/api/runs/{run_id}/progress")
async def run_progress_stream(run_id: str):
    """SSE stream of run progress updates."""

    async def event_generator():
        run_dir = RUNS_DIR / run_id
        last_data = None

        while True:
            progress_path = run_dir / "progress.yaml"
            if progress_path.exists():
                try:
                    data = yaml.safe_load(progress_path.read_text())
                    if data and data != last_data:
                        last_data = data

                        # Also read iteration history from audit.jsonl
                        audit_path = run_dir / "audit.jsonl"
                        iterations = []
                        if audit_path.exists():
                            for line in audit_path.read_text().strip().split("\n"):
                                if line.strip():
                                    try:
                                        iterations.append(json.loads(line))
                                    except json.JSONDecodeError:
                                        pass

                        payload = {**data, "iterations": iterations}
                        yield {"event": "progress", "data": json.dumps(payload)}

                        # If completed or halted, send final event and stop
                        status = data.get("status", "")
                        if status in ("COMPLETED", "HALTED", "CANCELLED"):
                            yield {"event": "done", "data": json.dumps(payload)}
                            return
                except (yaml.YAMLError, FileNotFoundError):
                    pass

            await asyncio.sleep(2)

    return EventSourceResponse(event_generator())


@app.get("/api/runs/{run_id}/report")
async def get_run_report(run_id: str):
    """Get the markdown report for a run."""
    report_path = RUNS_DIR / run_id / "report.md"
    if not report_path.exists():
        raise HTTPException(status_code=404, detail=f"Report not found for run {run_id}")
    return {"report": report_path.read_text()}


@app.post("/api/runs")
async def start_run(request: Request):
    """Start a new autoresearch run."""
    body = await request.json()

    try:
        from agent.config import RunConfig
        from agent.llm import get_llm
        from agent.audit import AuditTrail
        from agent.constraints import ConstraintValidator, FEDERAL_PROPOSAL_CONSTRAINTS, COMPLIANCE_CONSTRAINTS
        from agent.learnings import LearningsStore
        from agent.hypothesis import HypothesisGenerator
        from agent.modifier import ArtifactModifier
        from agent.loop import AutoresearchLoop
        from scorers.composite_scorer import CompositeScorer
        from scorers.readability_scorer import ReadabilityScorer

        config = RunConfig(**body)

        # Validate target_path: must exist and must be within the workspace
        target = config.target_path
        if not target.exists():
            raise ValueError(f"Target file does not exist: {target}")
        # Prevent path traversal: resolve and check it's under the allowed workspace
        workspace_dir = BASE_DIR / "workspace"
        workspace_dir.mkdir(exist_ok=True)
        try:
            resolved = target.resolve()
            if not (str(resolved).startswith(str(BASE_DIR.resolve()))
                    or str(resolved).startswith(str(workspace_dir.resolve()))):
                raise ValueError(f"Target path is outside the allowed workspace: {target}")
        except (OSError, ValueError) as path_err:
            raise ValueError(f"Invalid target path: {path_err}")

        # Initialize components
        llm = get_llm(config.llm_provider, config.llm_model)

        import uuid
        run_id = str(uuid.uuid4())[:8]
        run_dir = RUNS_DIR / run_id

        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")

        # Set up constraints based on mode
        if config.mode == "compliance":
            constraint_set = COMPLIANCE_CONSTRAINTS
        else:
            constraint_set = FEDERAL_PROPOSAL_CONSTRAINTS
        constraints = ConstraintValidator(constraint_set)

        # Set up scorer (use readability as default simple scorer)
        scorer = ReadabilityScorer()

        hypothesis_gen = HypothesisGenerator(llm, config.mode, learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config,
            llm=llm,
            scorer=scorer,
            constraints=constraints,
            audit=audit,
            learnings=learnings,
            hypothesis_gen=hypothesis_gen,
            modifier=modifier,
        )
        loop.run_id = run_id

        active_loops[run_id] = loop

        # Start loop in background
        asyncio.create_task(_run_loop(run_id, loop))

        return {"run_id": run_id, "status": "started"}

    except Exception as e:
        logger.exception(f"Failed to start run: {e}")
        raise HTTPException(status_code=400, detail=str(e))


async def _run_loop(run_id: str, loop: Any):
    """Run a loop in the background."""
    try:
        await loop.run()
    except Exception as e:
        logger.exception(f"Run {run_id} failed: {e}")
    finally:
        active_loops.pop(run_id, None)


@app.delete("/api/runs/{run_id}")
async def cancel_run(run_id: str):
    """Cancel a running loop."""
    loop = active_loops.get(run_id)
    if not loop:
        raise HTTPException(status_code=404, detail=f"No active run {run_id}")
    await loop.cancel()
    return {"run_id": run_id, "status": "cancelling"}


def start_dashboard():
    """Start the dashboard server."""
    import uvicorn
    port = int(os.environ.get("DASHBOARD_PORT", "8501"))
    uvicorn.run(app, host="0.0.0.0", port=port)
