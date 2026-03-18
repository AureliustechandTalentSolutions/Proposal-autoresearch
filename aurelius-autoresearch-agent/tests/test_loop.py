"""Integration tests for the autoresearch loop."""

import asyncio
import pytest
import tempfile
from pathlib import Path
from datetime import datetime

from agent.config import RunConfig
from agent.audit import AuditTrail
from agent.constraints import ConstraintValidator, Constraint
from agent.learnings import LearningsStore
from agent.hypothesis import HypothesisGenerator
from agent.modifier import ArtifactModifier
from agent.loop import AutoresearchLoop


class MockLLM:
    """Mock LLM that returns predictable responses."""

    def __init__(self, improve=True):
        self.improve = improve
        self.call_count = 0

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str:
        self.call_count += 1

        if "hypotheses" in user_message.lower() or "hypothesis" in system_prompt.lower() or "generate" in system_prompt.lower() or "improvement" in system_prompt.lower() or "analyze" in system_prompt.lower():
            import json
            return json.dumps([
                {"description": "Improve section clarity", "expected_impact": "High", "risk": "low", "priority": 1},
            ])

        if "edit" in system_prompt.lower() or "modify" in system_prompt.lower() or "apply" in system_prompt.lower() or "change" in system_prompt.lower():
            return user_message.split("## Current Document\n")[-1].split("\n\nApply")[0] + "\n\nImproved content added here."

        return "Generic response"


class MockScorer:
    """Mock scorer that returns increasing or flat scores."""

    def __init__(self, scores=None, delay: float = 0.0):
        self._scores = scores or [60.0, 65.0, 70.0, 75.0, 80.0]
        self._idx = 0
        self._last_details = {}
        self._delay = delay

    async def score(self, content, context=None):
        if self._delay > 0:
            await asyncio.sleep(self._delay)
        score = self._scores[min(self._idx, len(self._scores) - 1)]
        self._idx += 1
        return score

    def describe(self):
        return "Mock scorer"

    @property
    def direction(self):
        return "higher_is_better"


@pytest.mark.asyncio
async def test_loop_basic_run():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("# Test Proposal\n\nThis is a test proposal for evaluation.")

        config = RunConfig(
            mode="proposal", target_path=target, metric="test",
            threshold=95.0, max_iterations=3,
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([])
        llm = MockLLM()
        scorer = MockScorer(scores=[60.0, 65.0, 70.0, 72.0])
        hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        result = await loop.run()
        assert result.baseline_score == 60.0
        assert result.final_score >= 60.0
        assert len(result.iterations) <= 3
        assert result.halt_reason in ("max_iterations", "threshold", "plateau")


@pytest.mark.asyncio
async def test_loop_plateau_detection():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("Test content")

        config = RunConfig(
            mode="compliance", target_path=target, metric="test",
            threshold=95.0, max_iterations=10,
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([])
        llm = MockLLM()
        # Flat scores = plateau after 3 iterations
        scorer = MockScorer(scores=[60.0, 60.0, 60.0, 60.0, 60.0])
        hypothesis_gen = HypothesisGenerator(llm, "compliance", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        result = await loop.run()
        assert result.halt_reason == "plateau"


@pytest.mark.asyncio
async def test_loop_threshold_halt():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("Test content for threshold test")

        config = RunConfig(
            mode="proposal", target_path=target, metric="test",
            threshold=70.0, max_iterations=10,
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([])
        llm = MockLLM()
        scorer = MockScorer(scores=[50.0, 60.0, 70.0, 80.0])
        hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        result = await loop.run()
        assert result.halt_reason == "threshold"
        assert result.final_score >= 70.0


@pytest.mark.asyncio
async def test_loop_cancellation():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("Test content")

        config = RunConfig(
            mode="proposal", target_path=target, metric="test",
            threshold=99.0, max_iterations=100,
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([])
        llm = MockLLM()
        scorer = MockScorer(scores=[50.0] * 100, delay=0.05)
        hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        # Cancel after brief delay — must fire before 3 no-improvement
        # iterations complete (which would trigger plateau detection)
        async def cancel_after_delay():
            await asyncio.sleep(0.08)
            await loop.cancel()

        asyncio.create_task(cancel_after_delay())
        result = await loop.run()
        assert result.halt_reason == "user_interrupt"


@pytest.mark.asyncio
async def test_audit_trail_created():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("Test artifact content")

        config = RunConfig(
            mode="proposal", target_path=target, metric="test",
            threshold=95.0, max_iterations=2,
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([])
        llm = MockLLM()
        scorer = MockScorer(scores=[50.0, 55.0, 60.0])
        hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        await loop.run()

        assert (run_dir / "original").exists()
        assert (run_dir / "baseline.yaml").exists()
        assert (run_dir / "audit.jsonl").exists()
        assert (run_dir / "result.json").exists()
        assert (run_dir / "report.md").exists()


@pytest.mark.asyncio
async def test_audit_files_contain_valid_data():
    """Verify that audit files contain valid JSON/YAML after a run."""
    import json
    import yaml

    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("Test artifact content for audit validation")

        config = RunConfig(
            mode="proposal", target_path=target, metric="test",
            threshold=95.0, max_iterations=2,
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([])
        llm = MockLLM()
        scorer = MockScorer(scores=[50.0, 55.0, 60.0])
        hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        await loop.run()

        # Validate audit.jsonl contains valid JSON lines
        audit_lines = (run_dir / "audit.jsonl").read_text().strip().split("\n")
        assert len(audit_lines) > 0
        for line in audit_lines:
            parsed = json.loads(line)
            assert "iteration" in parsed
            assert "decision" in parsed

        # Validate result.json is valid JSON
        result_data = json.loads((run_dir / "result.json").read_text())
        assert "run_id" in result_data
        assert "baseline_score" in result_data

        # Validate baseline.yaml is valid YAML
        baseline_data = yaml.safe_load((run_dir / "baseline.yaml").read_text())
        assert "score" in baseline_data
        assert "hash" in baseline_data


@pytest.mark.asyncio
async def test_loop_constraint_violation_halt():
    """Loop should halt when a HALT constraint is violated."""
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "artifact.md"
        target.write_text("Short text")

        config = RunConfig(
            mode="proposal", target_path=target, metric="test",
            threshold=95.0, max_iterations=10,
        )

        # Add a HALT constraint that limits word count to 5 words.
        # The modifier will add content, pushing it over the limit.
        halt_constraint = Constraint(
            name="strict_word_limit", description="Max 5 words",
            validation_type="word_count",
            parameters={"max": 5},
            on_violation="HALT",
        )

        run_dir = Path(tmpdir) / "run"
        audit = AuditTrail(run_dir)
        learnings = LearningsStore(run_dir / "learnings.yaml")
        constraints = ConstraintValidator([halt_constraint])
        llm = MockLLM()
        scorer = MockScorer(scores=[50.0, 55.0, 60.0, 65.0, 70.0])
        hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
        modifier = ArtifactModifier(llm)

        loop = AutoresearchLoop(
            config=config, llm=llm, scorer=scorer, constraints=constraints,
            audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
        )

        result = await loop.run()
        assert result.halt_reason == "constraint_violation"
