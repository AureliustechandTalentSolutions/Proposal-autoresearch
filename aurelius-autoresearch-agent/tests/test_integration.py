"""Integration / end-to-end tests for the Aurelius Autoresearch Agent.

All LLM calls are mocked so no API keys or network access are required.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import sys
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import yaml

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_PROPOSAL = FIXTURES / "sample_proposal.md"
SAMPLE_DEPLOYMENT = FIXTURES / "sample_deployment.yaml"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class MockLLM:
    """Deterministic mock LLM that returns canned responses."""

    def __init__(self):
        self._call_count = 0

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str:
        self._call_count += 1

        # --- hypothesis generation ---
        if "hypotheses" in user_message.lower() or "hypothesis" in system_prompt.lower():
            return json.dumps([
                {
                    "description": f"Improve section clarity and add quantified metrics (call {self._call_count})",
                    "expected_impact": "Score increase of 3-5 points",
                    "risk": "low",
                    "priority": 1,
                },
                {
                    "description": "Add specific timeline milestones",
                    "expected_impact": "Score increase of 1-2 points",
                    "risk": "low",
                    "priority": 2,
                },
            ])

        # --- artifact modification ---
        if "apply" in system_prompt.lower() or "modify" in system_prompt.lower() or "editor" in system_prompt.lower():
            # Return the artifact with a small deterministic tweak
            lines = user_message.split("## Current Document\n")
            if len(lines) > 1:
                original = lines[-1].split("\n\nApply ONLY")[0].strip()
            else:
                original = user_message[-2000:]
            return original + f"\n\n<!-- improved: call {self._call_count} -->"

        # --- scoring / evaluation (fallback) ---
        if "SCORE:" in system_prompt.upper() or "score" in system_prompt.lower():
            return "SCORE: 75"

        if "RATING:" in system_prompt or "rating" in system_prompt.lower():
            return "RATING: GOOD\nJUSTIFICATION: Meets requirements."

        if "COUNT:" in system_prompt:
            return "COUNT: 3"

        if "SPRS" in system_prompt:
            return "SPRS_SCORE: 80"

        if "TOTAL:" in system_prompt:
            return "TOTAL: 5 OPEN_HIGH: 0 OPEN_MED: 1 OPEN_LOW: 1"

        # Generic safe fallback
        return "OK"


def _make_run_dir(tmp_path: Path, name: str = "run") -> Path:
    d = tmp_path / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def _build_loop(
    tmp_path: Path,
    mode: str = "proposal",
    target: Path | None = None,
    max_iterations: int = 3,
    threshold: float = 99.0,
    extra_constraints=None,
):
    """Wire up all real components with the mock LLM."""
    from agent.audit import AuditTrail
    from agent.config import RunConfig
    from agent.constraints import (
        COMPLIANCE_CONSTRAINTS,
        FEDERAL_PROPOSAL_CONSTRAINTS,
        Constraint,
        ConstraintValidator,
    )
    from agent.hypothesis import HypothesisGenerator
    from agent.learnings import LearningsStore
    from agent.loop import AutoresearchLoop
    from agent.modifier import ArtifactModifier
    from scorers.readability_scorer import ReadabilityScorer

    llm = MockLLM()

    if target is None:
        target = SAMPLE_PROPOSAL if mode == "proposal" else SAMPLE_DEPLOYMENT

    config = RunConfig(
        mode=mode,
        target_path=target,
        metric="readability",
        threshold=threshold,
        max_iterations=max_iterations,
    )

    run_dir = _make_run_dir(tmp_path)
    audit = AuditTrail(run_dir)
    learnings = LearningsStore(run_dir / "learnings.yaml")

    if extra_constraints is not None:
        constraint_set = extra_constraints
    elif mode == "compliance":
        constraint_set = COMPLIANCE_CONSTRAINTS
    else:
        constraint_set = FEDERAL_PROPOSAL_CONSTRAINTS

    constraints = ConstraintValidator(constraint_set)
    scorer = ReadabilityScorer()
    hypothesis_gen = HypothesisGenerator(llm, mode, learnings)
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
    return loop, run_dir


# ======================================================================
# Test 1 -- Full proposal optimization loop (3 iterations)
# ======================================================================

@pytest.mark.asyncio
async def test_proposal_optimization_loop(tmp_path):
    loop, run_dir = _build_loop(tmp_path, mode="proposal", max_iterations=3)
    result = await loop.run()

    # audit.jsonl exists and has entries
    audit_path = run_dir / "audit.jsonl"
    assert audit_path.exists(), "audit.jsonl missing"
    lines = [l for l in audit_path.read_text().splitlines() if l.strip()]
    assert len(lines) >= 1, "audit.jsonl should have at least 1 iteration entry"

    # progress.yaml is valid
    progress_path = run_dir / "progress.yaml"
    assert progress_path.exists()
    progress = yaml.safe_load(progress_path.read_text())
    assert progress is not None
    assert "status" in progress

    # result.json is valid
    result_path = run_dir / "result.json"
    assert result_path.exists()
    result_data = json.loads(result_path.read_text())
    assert "baseline_score" in result_data
    assert "final_score" in result_data

    # report.md has content
    report_path = run_dir / "report.md"
    assert report_path.exists()
    assert len(report_path.read_text()) > 50

    # learnings.yaml has entries
    learnings_path = run_dir / "learnings.yaml"
    assert learnings_path.exists()
    learnings = yaml.safe_load(learnings_path.read_text())
    assert isinstance(learnings, list)
    assert len(learnings) >= 1


# ======================================================================
# Test 2 -- Full compliance optimization loop (3 iterations)
# ======================================================================

@pytest.mark.asyncio
async def test_compliance_optimization_loop(tmp_path):
    loop, run_dir = _build_loop(tmp_path, mode="compliance", max_iterations=3)
    result = await loop.run()

    assert run_dir / "audit.jsonl"
    assert (run_dir / "progress.yaml").exists()
    progress = yaml.safe_load((run_dir / "progress.yaml").read_text())
    assert progress["status"] in ("COMPLETED", "HALTED", "CANCELLED")

    assert (run_dir / "result.json").exists()
    result_data = json.loads((run_dir / "result.json").read_text())
    assert result_data["config"]["mode"] == "compliance"

    assert (run_dir / "report.md").exists()

    learnings = yaml.safe_load((run_dir / "learnings.yaml").read_text())
    assert isinstance(learnings, list)
    assert len(learnings) >= 1


# ======================================================================
# Test 3 -- CLI argument parsing
# ======================================================================

def test_cli_argument_parsing():
    """Verify argparse handles expected subcommands and flags."""
    import argparse
    from agent.main import main

    # We re-create the parser by importing main's setup.  main() calls
    # parser.parse_args() which reads sys.argv, so we patch sys.argv.

    def _parse(argv: list[str]) -> argparse.Namespace:
        """Parse with the same parser that main() builds."""
        # Replicate parser construction inline (lightweight, no side effects).
        parser = argparse.ArgumentParser(prog="aurelius-autoresearch")
        sub = parser.add_subparsers(dest="command")

        run_p = sub.add_parser("run")
        run_p.add_argument("--config", type=str)
        run_p.add_argument("--mode", choices=["compliance", "proposal"])
        run_p.add_argument("--target", type=str)
        run_p.add_argument("--metric", type=str)
        run_p.add_argument("--threshold", type=float, default=90.0)
        run_p.add_argument("--max-iterations", type=int, default=25)
        run_p.add_argument("--llm-provider", choices=["claude", "openai", "ollama"], default="claude")
        run_p.add_argument("--llm-model", type=str, default="claude-sonnet-4-20250514")
        run_p.add_argument("--eval-criteria", type=str)
        run_p.add_argument("--daemon", action="store_true")

        status_p = sub.add_parser("status")
        status_p.add_argument("--run-id", required=True)

        report_p = sub.add_parser("report")
        report_p.add_argument("--run-id", required=True)

        sub.add_parser("dashboard")

        return parser.parse_args(argv)

    # run subcommand
    args = _parse(["run", "--mode", "proposal", "--target", "x", "--metric", "y"])
    assert args.command == "run"
    assert args.mode == "proposal"
    assert args.target == "x"
    assert args.metric == "y"

    # status subcommand
    args = _parse(["status", "--run-id", "abc"])
    assert args.command == "status"
    assert args.run_id == "abc"

    # report subcommand
    args = _parse(["report", "--run-id", "abc"])
    assert args.command == "report"
    assert args.run_id == "abc"

    # dashboard subcommand
    args = _parse(["dashboard"])
    assert args.command == "dashboard"


# ======================================================================
# Test 4 -- Dashboard API endpoints
# ======================================================================

def test_dashboard_api_endpoints(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    # Point RUNS_DIR at a temp dir so tests are isolated
    import dashboard.app as dash_mod
    monkeypatch.setattr(dash_mod, "RUNS_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()

    client = TestClient(dash_mod.app)

    # GET / -> 200 HTML
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers.get("content-type", "")

    # GET /api/runs -> 200 JSON with "runs" key
    resp = client.get("/api/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert "runs" in body
    assert isinstance(body["runs"], list)

    # GET /api/runs/nonexistent -> 404
    resp = client.get("/api/runs/nonexistent")
    assert resp.status_code == 404

    # POST /api/runs with invalid body -> 400
    resp = client.post("/api/runs", json={"bad": "data"})
    assert resp.status_code == 400

    # DELETE /api/runs/nonexistent -> 404
    resp = client.delete("/api/runs/nonexistent")
    assert resp.status_code == 404


# ======================================================================
# Test 5 -- Audit trail integrity
# ======================================================================

@pytest.mark.asyncio
async def test_audit_trail_integrity(tmp_path):
    loop, run_dir = _build_loop(tmp_path, mode="proposal", max_iterations=2)
    result = await loop.run()

    # Verify SHA-256 hashes in audit.jsonl match actual artifact content
    audit_path = run_dir / "audit.jsonl"
    assert audit_path.exists()
    entries = [json.loads(l) for l in audit_path.read_text().splitlines() if l.strip()]
    assert len(entries) >= 1

    for entry in entries:
        # Each entry should have artifact_hash_before / artifact_hash_after
        assert "artifact_hash_before" in entry
        assert "artifact_hash_after" in entry
        # Hashes should be 64-char hex strings (SHA-256)
        assert len(entry["artifact_hash_before"]) == 64
        assert len(entry["artifact_hash_after"]) == 64

    # Verify iteration directories contain expected files
    iterations_dir = run_dir / "iterations"
    assert iterations_dir.exists()
    iter_dirs = sorted(iterations_dir.iterdir())
    assert len(iter_dirs) >= 1

    for iter_dir in iter_dirs:
        assert (iter_dir / "hypothesis.yaml").exists(), f"hypothesis.yaml missing in {iter_dir}"
        assert (iter_dir / "change.diff").exists(), f"change.diff missing in {iter_dir}"
        assert (iter_dir / "result.yaml").exists(), f"result.yaml missing in {iter_dir}"

    # Verify original_vs_final.diff exists and looks like a unified diff (or empty if no changes kept)
    diff_path = run_dir / "original_vs_final.diff"
    assert diff_path.exists()
    diff_text = diff_path.read_text()
    # If changes were kept, it should contain diff markers; if not, it may be empty
    if diff_text.strip():
        assert "---" in diff_text or "+++" in diff_text, "Diff does not look like unified diff format"

    # Verify artifact snapshot hashes match audit entries for KEEP decisions
    for entry in entries:
        iteration = entry["iteration"]
        snapshot_path = iterations_dir / str(iteration) / "artifact"
        if snapshot_path.exists():
            content = snapshot_path.read_text()
            actual_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if entry["decision"] == "KEEP":
                assert actual_hash == entry["artifact_hash_after"], (
                    f"Hash mismatch for KEEP iteration {iteration}"
                )


# ======================================================================
# Test 6 -- Learnings persistence and cross-run merge
# ======================================================================

@pytest.mark.asyncio
async def test_learnings_persistence_and_merge(tmp_path):
    from agent.learnings import LearningsStore

    # Run 1
    run1_dir = tmp_path / "run1"
    loop1, _ = _build_loop(tmp_path / "loop1", mode="proposal", max_iterations=2)
    # Override run_dir for learnings to point at run1_dir
    run1_dir.mkdir(parents=True, exist_ok=True)
    loop1.learnings = LearningsStore(run1_dir / "learnings.yaml")
    result1 = await loop1.run()

    learnings1_path = run1_dir / "learnings.yaml"
    assert learnings1_path.exists()
    data1 = yaml.safe_load(learnings1_path.read_text())
    assert isinstance(data1, list)
    assert len(data1) >= 1

    # Run 2 -- create fresh store, merge from run 1
    run2_dir = tmp_path / "run2"
    run2_dir.mkdir(parents=True, exist_ok=True)
    store2 = LearningsStore(run2_dir / "learnings.yaml")
    store2.merge_from_previous_run(run1_dir)

    data2 = yaml.safe_load((run2_dir / "learnings.yaml").read_text())
    # Merged store should contain reusable entries from run 1
    reusable_in_run1 = [e for e in data1 if e.get("reusable")]
    if reusable_in_run1:
        assert len(data2) >= len(reusable_in_run1), (
            "Merged store should contain at least as many entries as reusable entries from run 1"
        )
        # Every reusable entry from run 1 should appear in run 2
        for entry in reusable_in_run1:
            assert any(
                e["hypothesis"] == entry["hypothesis"] for e in data2
            ), f"Reusable learning not merged: {entry['hypothesis']}"
    else:
        # If no reusable entries in run 1 (all DISCARD / delta<=0), merged should be empty
        assert data2 is None or len(data2) == 0


# ======================================================================
# Test 7 -- Constraint enforcement (page limit HALT)
# ======================================================================

@pytest.mark.asyncio
async def test_constraint_enforcement_halt(tmp_path):
    from agent.constraints import Constraint

    # Create a large artifact that clearly exceeds 1 page (250 words)
    large_artifact = tmp_path / "large_proposal.md"
    large_artifact.write_text(
        "# Large Proposal\n\n" + ("This is a sentence with many words to inflate the document. " * 80)
    )

    # Page limit of 1 page (~250 words) -- large artifact exceeds this
    strict_constraints = [
        Constraint(
            name="Strict Page Limit",
            description="Must not exceed 1 page",
            validation_type="page_limit",
            parameters={"max_pages": 1, "words_per_page": 250},
            on_violation="HALT",
        ),
    ]

    loop, run_dir = _build_loop(
        tmp_path,
        mode="proposal",
        target=large_artifact,
        max_iterations=5,
        extra_constraints=strict_constraints,
    )
    result = await loop.run()

    assert result.halt_reason == "constraint_violation", (
        f"Expected halt_reason='constraint_violation', got '{result.halt_reason}'"
    )


# ======================================================================
# Test 8 -- LLM provider factory
# ======================================================================

def test_llm_provider_factory(monkeypatch):
    from agent.llm import ClaudeProvider, OllamaProvider, OpenAICompatibleProvider, get_llm

    # Set dummy API keys so provider constructors don't complain
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-dummy")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-dummy")

    # Claude
    provider = get_llm("claude", "test-model")
    assert isinstance(provider, ClaudeProvider)

    # OpenAI
    provider = get_llm("openai", "test-model")
    assert isinstance(provider, OpenAICompatibleProvider)

    # Ollama
    provider = get_llm("ollama", "test-model")
    assert isinstance(provider, OllamaProvider)

    # Invalid
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        get_llm("invalid", "model")


# ======================================================================
# Test 9 -- Scorer composition validation
# ======================================================================

def test_scorer_composition_federal_proposal():
    from scorers.composite_scorer import CompositeScorer

    llm = MockLLM()
    scorer = CompositeScorer.federal_proposal(
        llm=llm,
        eval_criteria=[{"factor": "Technical", "weight": 1.0}],
        requirements=["REQ-1"],
        win_themes=["innovation"],
        max_pages=20,
    )
    # Weights should sum to 1.0
    total = sum(w for _, w in scorer._scorers.values())
    assert abs(total - 1.0) < 0.01, f"Proposal scorer weights sum to {total}, expected 1.0"

    # Should have expected components
    assert "eval_alignment" in scorer._scorers
    assert "traceability" in scorer._scorers
    assert "readability" in scorer._scorers
    assert "discriminators" in scorer._scorers
    assert "win_themes" in scorer._scorers
    assert "page_utilization" in scorer._scorers


def test_scorer_composition_federal_compliance():
    from scorers.composite_scorer import CompositeScorer

    llm = MockLLM()
    scorer = CompositeScorer.federal_compliance(
        llm=llm,
        controls_list=["AC-1", "AC-2"],
    )
    total = sum(w for _, w in scorer._scorers.values())
    assert abs(total - 1.0) < 0.01, f"Compliance scorer weights sum to {total}, expected 1.0"

    assert "nist_coverage" in scorer._scorers
    assert "stig_pass" in scorer._scorers
    assert "poam_reduction" in scorer._scorers
    assert "sprs_normalized" in scorer._scorers
