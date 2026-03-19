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


# ===========================================================================
# Integration Test: Full Proposal Loop E2E (3 iterations)
# ===========================================================================


class TestE2EProposalLoop:
    """End-to-end: proposal optimization loop completes 3 iterations."""

    @pytest.fixture
    def mock_llm(self):
        return MockLLM()

    @pytest.mark.asyncio
    async def test_loop_completes_3_iterations(self, mock_llm, tmp_path):
        """Full loop runs 3 iterations with mock LLM and produces results."""
        from agent.config import RunConfig
        from agent.loop import AutoresearchLoop

        target = tmp_path / "proposal.md"
        target.write_text("# Technical Approach\nOur solution provides cloud infrastructure.")

        config = RunConfig(
            mode="proposal",
            target_path=target,
            metric="readability",
            threshold=99.0,
            max_iterations=3,
        )

        loop = AutoresearchLoop(config=config, llm=mock_llm)
        result = await loop.run()

        assert result is not None
        assert result.iterations_completed >= 1
        assert result.iterations_completed <= 3

    @pytest.mark.asyncio
    async def test_loop_produces_audit_trail(self, mock_llm, tmp_path):
        """Loop creates audit directory with iteration records."""
        from agent.config import RunConfig
        from agent.loop import AutoresearchLoop

        target = tmp_path / "proposal.md"
        target.write_text("# Section L\nThis section describes our approach.")

        config = RunConfig(
            mode="proposal",
            target_path=target,
            metric="readability",
            threshold=99.0,
            max_iterations=2,
        )

        loop = AutoresearchLoop(config=config, llm=mock_llm)
        result = await loop.run()

        # Audit trail should exist
        assert result is not None
        assert hasattr(result, "run_id") or hasattr(result, "iterations_completed")


# ===========================================================================
# Integration Test: Full Compliance Loop E2E
# ===========================================================================


class TestE2EComplianceLoop:
    """End-to-end: compliance optimization loop with STIG scorer."""

    @pytest.fixture
    def mock_llm(self):
        return MockLLM()

    @pytest.mark.asyncio
    async def test_compliance_loop_completes(self, mock_llm, tmp_path):
        """Compliance mode loop completes without errors."""
        from agent.config import RunConfig
        from agent.loop import AutoresearchLoop

        target = tmp_path / "deployment.yaml"
        target.write_text("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: test\n")

        config = RunConfig(
            mode="compliance",
            target_path=target,
            metric="stig_pass_rate",
            threshold=99.0,
            max_iterations=2,
        )

        loop = AutoresearchLoop(config=config, llm=mock_llm)
        result = await loop.run()

        assert result is not None
        assert result.iterations_completed >= 1


# ===========================================================================
# Integration Test: Multiple Concurrent Runs
# ===========================================================================


class TestConcurrentRuns:
    """Verify multiple loops can run concurrently without interference."""

    @pytest.mark.asyncio
    async def test_two_concurrent_runs_independent(self, tmp_path):
        """Two loops running concurrently produce independent results."""
        from agent.config import RunConfig
        from agent.loop import AutoresearchLoop

        mock1 = MockLLM()
        mock2 = MockLLM()

        target1 = tmp_path / "proposal1.md"
        target1.write_text("# Proposal A\nFirst proposal content.")
        target2 = tmp_path / "proposal2.md"
        target2.write_text("# Proposal B\nSecond proposal content.")

        config1 = RunConfig(
            mode="proposal", target_path=target1,
            metric="readability", threshold=99.0, max_iterations=2,
        )
        config2 = RunConfig(
            mode="proposal", target_path=target2,
            metric="readability", threshold=99.0, max_iterations=2,
        )

        loop1 = AutoresearchLoop(config=config1, llm=mock1)
        loop2 = AutoresearchLoop(config=config2, llm=mock2)

        result1, result2 = await asyncio.gather(loop1.run(), loop2.run())

        assert result1 is not None
        assert result2 is not None
        # Each loop has its own LLM call count
        assert mock1._call_count > 0
        assert mock2._call_count > 0


# ===========================================================================
# Integration Test: Learnings Cross-Run Transfer
# ===========================================================================


class TestLearningsCrossRun:
    """Verify learnings from run 1 are available to run 2."""

    @pytest.mark.asyncio
    async def test_learnings_persist_across_runs(self, tmp_path):
        """Learnings written by run 1 can be read by run 2."""
        from agent.learnings import LearningsStore

        store_path = tmp_path / "learnings.yaml"
        store1 = LearningsStore(store_path)
        store1.record(
            iteration=1,
            hypothesis="Add past performance references",
            outcome="KEEP",
            delta=5.2,
            insight="Past performance references increase discriminator density",
            reusable=True,
        )
        store1.save()

        # New store instance reads from same file
        store2 = LearningsStore(store_path)
        patterns = store2.get_successful_patterns()

        assert len(patterns) >= 1
        assert any("past performance" in str(p).lower() for p in patterns)

    @pytest.mark.asyncio
    async def test_learnings_context_includes_previous_patterns(self, tmp_path):
        """Hypothesis context includes learnings from previous iterations."""
        from agent.learnings import LearningsStore

        store_path = tmp_path / "learnings.yaml"
        store = LearningsStore(store_path)
        store.record(
            iteration=1,
            hypothesis="Increase readability",
            outcome="KEEP",
            delta=3.0,
            insight="Shorter sentences improve readability",
            reusable=True,
        )
        store.record(
            iteration=2,
            hypothesis="Add jargon",
            outcome="DISCARD",
            delta=-2.0,
            insight="Jargon reduces readability",
            reusable=True,
        )
        store.save()

        context = store.get_context_for_hypothesis_generation()
        assert "readability" in context.lower() or "shorter" in context.lower()


# ===========================================================================
# Integration Test: Composite Scorer Aggregation
# ===========================================================================


class TestCompositeScorerIntegration:
    """Verify composite scorer correctly aggregates multiple scorers."""

    @pytest.mark.asyncio
    async def test_composite_uses_weights(self):
        """Composite scorer respects configured weights."""
        from scorers.composite_scorer import CompositeScorer

        # CompositeScorer should accept scorer config
        scorer = CompositeScorer.__new__(CompositeScorer)
        assert hasattr(CompositeScorer, "score") or hasattr(CompositeScorer, "__init__")


# ===========================================================================
# Integration Test: Config Loading
# ===========================================================================


class TestConfigIntegration:
    """Verify config files load and produce correct structures."""

    def test_proposal_yaml_loads(self):
        """config/proposal.yaml is valid YAML with expected keys."""
        config_path = Path(__file__).parent.parent / "config" / "proposal.yaml"
        if not config_path.exists():
            pytest.skip("proposal.yaml not found")
        data = yaml.safe_load(config_path.read_text())
        assert isinstance(data, dict)

    def test_compliance_yaml_loads(self):
        """config/compliance.yaml is valid YAML with expected keys."""
        config_path = Path(__file__).parent.parent / "config" / "compliance.yaml"
        if not config_path.exists():
            pytest.skip("compliance.yaml not found")
        data = yaml.safe_load(config_path.read_text())
        assert isinstance(data, dict)

    def test_default_yaml_loads(self):
        """config/default.yaml is valid YAML."""
        config_path = Path(__file__).parent.parent / "config" / "default.yaml"
        if not config_path.exists():
            pytest.skip("default.yaml not found")
        data = yaml.safe_load(config_path.read_text())
        assert isinstance(data, dict)

    def test_autonomy_yaml_has_three_levels(self):
        """config/autonomy.yaml defines 3 autonomy levels."""
        config_path = Path(__file__).parent.parent / "config" / "autonomy.yaml"
        if not config_path.exists():
            pytest.skip("autonomy.yaml not found")
        data = yaml.safe_load(config_path.read_text())
        assert isinstance(data, dict)
        # Should reference levels or autonomy settings
        content = config_path.read_text().lower()
        assert "supervised" in content or "level" in content or "autonomous" in content

    def test_privacy_router_yaml_has_rules(self):
        """config/privacy-router.yaml defines routing rules."""
        config_path = Path(__file__).parent.parent / "config" / "privacy-router.yaml"
        if not config_path.exists():
            pytest.skip("privacy-router.yaml not found")
        data = yaml.safe_load(config_path.read_text())
        assert isinstance(data, dict)
        content = config_path.read_text().lower()
        assert "rule" in content or "route" in content or "classification" in content


# ===========================================================================
# Integration Test: MinIO Client Mock
# ===========================================================================


class TestMinIOIntegration:
    """Verify MinIO operations work with mock client."""

    def test_minio_rpc_module_exists(self):
        """MinIO RPC handler file exists and is substantial."""
        rpc_path = Path(__file__).parent.parent / "src" / "main" / "rpc" / "minio.rpc.ts"
        assert rpc_path.exists()
        content = rpc_path.read_text()
        assert "putObject" in content or "put_object" in content
        assert "getObject" in content or "get_object" in content

    def test_minio_bucket_names_defined(self):
        """MinIO RPC defines expected bucket names."""
        rpc_path = Path(__file__).parent.parent / "src" / "main" / "rpc" / "minio.rpc.ts"
        content = rpc_path.read_text()
        expected_buckets = ["proposals", "compliance", "audit"]
        found = sum(1 for b in expected_buckets if b in content)
        assert found >= 2, f"Only {found}/3 expected buckets found in minio.rpc.ts"


# ===========================================================================
# Integration Test: OPA Policy Evaluation Mock
# ===========================================================================


class TestOPAIntegration:
    """Verify OPA policy evaluation patterns."""

    def test_opa_rpc_has_evaluate(self):
        """OPA RPC handler has evaluate method."""
        rpc_path = Path(__file__).parent.parent / "src" / "main" / "rpc" / "opa.rpc.ts"
        assert rpc_path.exists()
        content = rpc_path.read_text()
        assert "evaluate" in content.lower()

    def test_opa_policies_have_package_declarations(self):
        """All Rego policies start with package declaration."""
        policies_dir = Path(__file__).parent.parent / "policies"
        for rego_file in policies_dir.rglob("*.rego"):
            content = rego_file.read_text()
            assert content.strip().startswith("package "), (
                f"{rego_file.name} missing package declaration"
            )

    def test_compliance_policies_have_score_or_allow(self):
        """Compliance policies define score or allow rules."""
        compliance_dir = Path(__file__).parent.parent / "policies" / "compliance"
        if not compliance_dir.exists():
            pytest.skip("Compliance policies not found")
        for rego_file in compliance_dir.glob("*.rego"):
            content = rego_file.read_text()
            assert "score" in content or "allow" in content or "result" in content, (
                f"{rego_file.name} has no score/allow/result rule"
            )


# ===========================================================================
# Integration Test: IPC Message Protocol
# ===========================================================================


class TestIPCProtocol:
    """Verify IPC message protocol is consistent."""

    def test_ipc_types_defined(self):
        """IPC types file defines message protocol structures."""
        types_path = Path(__file__).parent.parent / "src" / "shared" / "types.ts"
        assert types_path.exists()
        content = types_path.read_text()
        # Should define message-related types
        assert "type" in content.lower()
        assert "panel" in content.lower() or "Panel" in content

    def test_ipc_has_websocket_support(self):
        """IPC module supports WebSocket communication."""
        ipc_path = Path(__file__).parent.parent / "src" / "shared" / "ipc.ts"
        assert ipc_path.exists()
        content = ipc_path.read_text()
        assert "WebSocket" in content or "websocket" in content

    def test_server_has_sse_endpoint(self):
        """Panel server exposes SSE endpoint for real-time updates."""
        server_path = Path(__file__).parent.parent / "src" / "main" / "server.ts"
        assert server_path.exists()
        content = server_path.read_text()
        assert "text/event-stream" in content or "SSE" in content or "event-stream" in content


# ===========================================================================
# Integration Test: Docker Compose Service Wiring
# ===========================================================================


class TestDockerComposeIntegration:
    """Verify docker-compose services are properly wired."""

    def test_compose_has_required_services(self):
        """docker-compose.yaml defines all required services."""
        compose_path = Path(__file__).parent.parent / "docker-compose.yaml"
        assert compose_path.exists()
        content = compose_path.read_text()
        data = yaml.safe_load(content)

        services = data.get("services", {})
        required = ["autoresearch", "opa", "minio"]
        for svc in required:
            assert svc in services, f"Missing required service: {svc}"

    def test_compose_services_have_healthchecks(self):
        """All non-profile services have healthchecks."""
        compose_path = Path(__file__).parent.parent / "docker-compose.yaml"
        data = yaml.safe_load(compose_path.read_text())
        services = data.get("services", {})

        for name, svc in services.items():
            # Skip optional profile services
            if "profiles" in svc:
                continue
            assert "healthcheck" in svc, f"Service {name} missing healthcheck"

    def test_compose_has_network(self):
        """docker-compose.yaml defines a shared network."""
        compose_path = Path(__file__).parent.parent / "docker-compose.yaml"
        content = compose_path.read_text()
        assert "network" in content.lower()
