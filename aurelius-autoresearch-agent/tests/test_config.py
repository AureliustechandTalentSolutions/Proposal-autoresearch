"""Tests for Pydantic configuration models."""

import pytest
from datetime import datetime
from pathlib import Path


def test_run_config_valid():
    from agent.config import RunConfig
    config = RunConfig(
        mode="proposal",
        target_path=Path("/workspace/proposal.md"),
        metric="eval_alignment",
        threshold=90.0,
    )
    assert config.mode == "proposal"
    assert config.max_iterations == 25
    assert config.llm_provider == "claude"


def test_run_config_frozen():
    from agent.config import RunConfig
    config = RunConfig(
        mode="compliance",
        target_path=Path("/test.yaml"),
        metric="stig_pass",
        threshold=95.0,
    )
    with pytest.raises(Exception):
        config.mode = "proposal"


def test_run_config_threshold_validation():
    from agent.config import RunConfig
    with pytest.raises(Exception):
        RunConfig(mode="proposal", target_path=Path("/x"), metric="m", threshold=150.0)


def test_hypothesis_defaults():
    from agent.config import Hypothesis
    h = Hypothesis(description="Test", expected_impact="High", risk="low", priority=1)
    assert h.id  # should have uuid
    assert h.priority == 1


def test_iteration_result():
    from agent.config import IterationResult, Hypothesis
    h = Hypothesis(description="Test", expected_impact="High", risk="low", priority=1)
    result = IterationResult(
        iteration=1,
        hypothesis=h,
        score_before=50.0,
        score_after=55.0,
        delta=5.0,
        decision="KEEP",
        rationale="Score improved",
        artifact_hash_before="abc",
        artifact_hash_after="def",
        diff="@@ -1 +1 @@",
        duration_seconds=1.5,
    )
    assert result.decision == "KEEP"
    assert result.delta == 5.0


def test_run_progress_mutable():
    from agent.config import RunProgress
    p = RunProgress(run_id="test-123")
    p.current_iteration = 5
    p.current_score = 75.0
    assert p.current_iteration == 5


def test_run_result_improvement_percentage():
    from agent.config import RunResult, RunConfig, Hypothesis, IterationResult
    config = RunConfig(mode="proposal", target_path=Path("/x"), metric="m", threshold=90.0)
    h = Hypothesis(description="Test", expected_impact="High", risk="low", priority=1)
    result = RunResult(
        run_id="test-001",
        config=config,
        baseline_score=50.0,
        final_score=65.0,
        total_improvement=15.0,
        iterations=[
            IterationResult(iteration=1, hypothesis=h, score_before=50.0, score_after=65.0,
                          delta=15.0, decision="KEEP", rationale="Good",
                          artifact_hash_before="a", artifact_hash_after="b",
                          diff="diff", duration_seconds=1.0)
        ],
        learnings=[],
        halt_reason="threshold",
        started_at=datetime(2026, 1, 1),
        completed_at=datetime(2026, 1, 1, 1, 0),
    )
    assert result.improvement_percentage == 30.0


def test_run_result_markdown_report():
    from agent.config import RunResult, RunConfig, Hypothesis, IterationResult
    config = RunConfig(mode="compliance", target_path=Path("/x"), metric="stig", threshold=95.0)
    h = Hypothesis(description="Harden security context", expected_impact="High", risk="low", priority=1)
    result = RunResult(
        run_id="test-002",
        config=config,
        baseline_score=60.0,
        final_score=80.0,
        total_improvement=20.0,
        iterations=[
            IterationResult(iteration=1, hypothesis=h, score_before=60.0, score_after=80.0,
                          delta=20.0, decision="KEEP", rationale="Improved",
                          artifact_hash_before="a", artifact_hash_after="b",
                          diff="diff", duration_seconds=2.0)
        ],
        learnings=[{"hypothesis": "Harden security", "insight": "Always works"}],
        halt_reason="threshold",
        started_at=datetime(2026, 1, 1),
        completed_at=datetime(2026, 1, 1, 0, 30),
    )
    report = result.to_markdown_report()
    assert "# Autoresearch Run Report" in report
    assert "Harden security context" in report
    assert "KEEP" in report


def test_run_config_max_iterations_zero_fails():
    """max_iterations=0 should fail validation since ge=1."""
    from agent.config import RunConfig
    with pytest.raises(Exception):
        RunConfig(
            mode="proposal",
            target_path=Path("/x"),
            metric="m",
            threshold=90.0,
            max_iterations=0,
        )


def test_run_result_zero_baseline_score():
    """improvement_percentage should be 0 when baseline_score is 0, not a division error."""
    from agent.config import RunResult, RunConfig, Hypothesis, IterationResult
    config = RunConfig(mode="proposal", target_path=Path("/x"), metric="m", threshold=90.0)
    h = Hypothesis(description="Test", expected_impact="High", risk="low", priority=1)
    result = RunResult(
        run_id="test-zero",
        config=config,
        baseline_score=0.0,
        final_score=10.0,
        total_improvement=10.0,
        iterations=[
            IterationResult(iteration=1, hypothesis=h, score_before=0.0, score_after=10.0,
                          delta=10.0, decision="KEEP", rationale="Good",
                          artifact_hash_before="a", artifact_hash_after="b",
                          diff="diff", duration_seconds=1.0)
        ],
        learnings=[],
        halt_reason="max_iterations",
        started_at=datetime(2026, 1, 1),
        completed_at=datetime(2026, 1, 1, 1, 0),
    )
    # Should return 0.0, not raise ZeroDivisionError
    assert result.improvement_percentage == 0.0


def test_hypothesis_frozen_immutability():
    """Hypothesis model should be frozen / immutable."""
    from agent.config import Hypothesis
    h = Hypothesis(description="Test", expected_impact="High", risk="low", priority=1)
    with pytest.raises(Exception):
        h.description = "Modified"
    with pytest.raises(Exception):
        h.priority = 99
