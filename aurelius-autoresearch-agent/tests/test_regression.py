"""Regression tests for the Aurelius Autoresearch Agent."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).parent.parent


@pytest.fixture
def client():
    """Create a FastAPI test client."""
    from dashboard.app import app

    return TestClient(app)


@pytest.fixture
def tmp_run_dir(tmp_path):
    """Create a temporary run directory for audit tests."""
    run_dir = tmp_path / "test-run"
    run_dir.mkdir()
    return run_dir


@pytest.fixture
def sample_artifact(tmp_path):
    """Create a sample artifact file for testing."""
    artifact = tmp_path / "sample.md"
    artifact.write_text(
        "This is a sample federal proposal document for testing purposes. "
        "The document contains several sentences that demonstrate adequate "
        "readability at a professional level. It discusses technical approaches "
        "to cloud migration including containerization strategies, DevSecOps "
        "pipelines, and continuous integration workflows. The team has extensive "
        "experience delivering similar solutions for Department of Defense clients "
        "with active security clearances. Our past performance includes three "
        "relevant contracts worth over fifty million dollars in total value."
    )
    return artifact


@pytest.fixture
def mock_llm():
    """Create a mock LLM provider."""
    llm = AsyncMock()
    llm.complete = AsyncMock(return_value="Mock LLM response")
    return llm


# ===========================================================================
# Test 1: Config Model Backward Compatibility
# ===========================================================================


class TestConfigModelBackwardCompatibility:
    """Verify RunConfig accepts all fields from config YAML files."""

    def test_default_yaml_creates_valid_run_config(self):
        """Load default.yaml and verify it creates a valid RunConfig (minus target_path)."""
        from agent.config import RunConfig

        config_path = BASE_DIR / "config" / "default.yaml"
        if config_path.exists():
            data = yaml.safe_load(config_path.read_text())
            # target_path and metric are runtime fields, provide them
            data["target_path"] = "/tmp/test.md"
            data["metric"] = "readability"
            config = RunConfig(**data)
            assert config.mode in ("compliance", "proposal")

    def test_compliance_yaml_creates_valid_run_config(self):
        """Load compliance.yaml and verify it creates a valid RunConfig."""
        from agent.config import RunConfig

        config_path = BASE_DIR / "config" / "compliance.yaml"
        if config_path.exists():
            data = yaml.safe_load(config_path.read_text())
            data["target_path"] = "/tmp/test.yaml"
            data["metric"] = "compliance"
            config = RunConfig(**data)
            assert config.mode == "compliance"
            assert config.threshold >= 0
            assert config.threshold <= 100

    def test_proposal_yaml_creates_valid_run_config(self):
        """Load proposal.yaml and verify it creates a valid RunConfig."""
        from agent.config import RunConfig

        config_path = BASE_DIR / "config" / "proposal.yaml"
        if config_path.exists():
            data = yaml.safe_load(config_path.read_text())
            data["target_path"] = "/tmp/test.md"
            data["metric"] = "proposal"
            config = RunConfig(**data)
            assert config.mode == "proposal"
            assert config.max_iterations >= 1

    def test_all_yaml_configs_loadable(self):
        """Every .yaml in config/ must be loadable without error."""
        config_dir = BASE_DIR / "config"
        yaml_files = list(config_dir.glob("*.yaml"))
        for yf in yaml_files:
            data = yaml.safe_load(yf.read_text())
            assert data is not None or yf.stat().st_size == 0, (
                f"Failed to load {yf}"
            )


# ===========================================================================
# Test 2: Scorer Interface Compliance
# ===========================================================================


class TestScorerInterfaceCompliance:
    """Verify all scorer classes conform to the Scorer ABC."""

    def _get_all_scorer_classes(self):
        """Collect all concrete Scorer subclasses."""
        from scorers import Scorer
        from scorers.readability_scorer import ReadabilityScorer, PageUtilizationScorer
        from scorers.composite_scorer import CompositeScorer

        # Scorers that don't require an LLM
        simple_scorers = [
            ("ReadabilityScorer", ReadabilityScorer()),
            ("PageUtilizationScorer", PageUtilizationScorer(max_pages=20)),
        ]

        # Scorers that require an LLM (mock it)
        mock_llm = AsyncMock()
        mock_llm.complete = AsyncMock(return_value='{"AC-1": "SATISFIED"}')

        from scorers.compliance_scorer import (
            NistControlCoverageScorer,
            StigPassRateScorer,
            SprsScorer,
            PoamReductionScorer,
        )
        from scorers.proposal_scorer import (
            EvaluationAlignmentScorer,
            RequirementsTraceabilityScorer,
            DiscriminatorDensityScorer,
            WinThemeScorer,
        )

        llm_scorers = [
            ("NistControlCoverageScorer", NistControlCoverageScorer(["AC-1"], mock_llm)),
            ("StigPassRateScorer", StigPassRateScorer(mock_llm)),
            ("SprsScorer", SprsScorer(mock_llm)),
            ("PoamReductionScorer", PoamReductionScorer(mock_llm)),
            ("EvaluationAlignmentScorer", EvaluationAlignmentScorer([], mock_llm)),
            ("RequirementsTraceabilityScorer", RequirementsTraceabilityScorer([], mock_llm)),
            ("DiscriminatorDensityScorer", DiscriminatorDensityScorer(mock_llm)),
            ("WinThemeScorer", WinThemeScorer([])),
        ]

        # CompositeScorer
        composite = CompositeScorer(
            {"readability": (ReadabilityScorer(), 1.0)}
        )
        composite_scorers = [("CompositeScorer", composite)]

        return simple_scorers + llm_scorers + composite_scorers

    def test_all_scorers_have_score_method(self):
        """Every scorer must have a score() method."""
        for name, scorer in self._get_all_scorer_classes():
            assert hasattr(scorer, "score"), f"{name} missing score() method"

    def test_all_scorers_have_describe_method(self):
        """Every scorer must have a describe() method."""
        for name, scorer in self._get_all_scorer_classes():
            assert hasattr(scorer, "describe"), f"{name} missing describe()"
            desc = scorer.describe()
            assert isinstance(desc, str) and len(desc) > 0, (
                f"{name}.describe() must return non-empty string"
            )

    def test_all_scorers_have_direction_property(self):
        """Every scorer must have a direction property returning valid literal."""
        for name, scorer in self._get_all_scorer_classes():
            assert hasattr(scorer, "direction"), f"{name} missing direction"
            d = scorer.direction
            assert d in ("higher_is_better", "lower_is_better"), (
                f"{name}.direction = {d!r} is not a valid literal"
            )

    def test_score_method_is_async(self):
        """Every scorer's score() method must be async."""
        for name, scorer in self._get_all_scorer_classes():
            assert asyncio.iscoroutinefunction(scorer.score), (
                f"{name}.score() is not async"
            )


# ===========================================================================
# Test 3: Audit Trail Format Stability
# ===========================================================================


class TestAuditTrailFormatStability:
    """Verify audit trail file formats remain consistent."""

    def test_audit_jsonl_entries_are_valid_json(self, tmp_run_dir):
        """Run a simulated iteration, read audit.jsonl, verify valid JSON."""
        from agent.audit import AuditTrail
        from agent.config import Hypothesis, IterationResult

        audit = AuditTrail(tmp_run_dir)

        hyp = Hypothesis(
            description="Test hypothesis",
            expected_impact="Moderate",
            risk="low",
            priority=1,
        )
        result = IterationResult(
            iteration=1,
            hypothesis=hyp,
            score_before=50.0,
            score_after=55.0,
            delta=5.0,
            decision="KEEP",
            rationale="Score improved",
            artifact_hash_before="abc123",
            artifact_hash_after="def456",
            diff="--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
            duration_seconds=1.5,
        )
        audit.log_iteration(result)

        # Read audit.jsonl and verify each line is valid JSON with required fields
        audit_path = tmp_run_dir / "audit.jsonl"
        assert audit_path.exists()
        for line in audit_path.read_text().strip().split("\n"):
            if line.strip():
                data = json.loads(line)
                assert "iteration" in data
                assert "hypothesis" in data
                assert "score_before" in data
                assert "score_after" in data
                assert "delta" in data
                assert "decision" in data
                assert "artifact_hash_before" in data
                assert "artifact_hash_after" in data

    def test_baseline_yaml_has_required_fields(self, tmp_run_dir):
        """baseline.yaml must have: score, hash, timestamp, word_count."""
        from agent.audit import AuditTrail

        audit = AuditTrail(tmp_run_dir)
        content = "Sample artifact content for baseline testing purposes here."
        audit.log_baseline(content, 72.5)

        baseline_data = yaml.safe_load(
            (tmp_run_dir / "baseline.yaml").read_text()
        )
        assert "score" in baseline_data
        assert "hash" in baseline_data
        assert "timestamp" in baseline_data
        assert "word_count" in baseline_data
        assert baseline_data["score"] == 72.5

    def test_progress_yaml_has_required_fields(self, tmp_run_dir):
        """progress.yaml must have: run_id, current_iteration, current_score, status."""
        from agent.audit import AuditTrail
        from agent.config import RunProgress

        audit = AuditTrail(tmp_run_dir)
        progress = RunProgress(
            run_id="test-123",
            current_iteration=3,
            current_score=65.0,
            baseline_score=50.0,
            improvement=15.0,
            kept=2,
            discarded=1,
            status="RUNNING",
        )
        audit.update_progress(progress)

        progress_data = yaml.safe_load(
            (tmp_run_dir / "progress.yaml").read_text()
        )
        assert progress_data["run_id"] == "test-123"
        assert progress_data["current_iteration"] == 3
        assert progress_data["current_score"] == 65.0
        assert progress_data["status"] == "RUNNING"


# ===========================================================================
# Test 4: LLM Provider Interface Consistency
# ===========================================================================


class TestLLMProviderInterfaceConsistency:
    """Verify all LLM providers have consistent interfaces."""

    def test_all_providers_have_complete_method(self):
        """All providers must have complete(system_prompt, user_message, max_tokens)."""
        from agent.llm import ClaudeProvider, OpenAICompatibleProvider, OllamaProvider

        for cls in (ClaudeProvider, OpenAICompatibleProvider, OllamaProvider):
            sig = inspect.signature(cls.complete)
            params = list(sig.parameters.keys())
            assert "self" in params, f"{cls.__name__} missing self"
            assert "system_prompt" in params, f"{cls.__name__} missing system_prompt"
            assert "user_message" in params, f"{cls.__name__} missing user_message"
            assert "max_tokens" in params, f"{cls.__name__} missing max_tokens"

    def test_default_max_tokens_is_4096(self):
        """All providers default max_tokens to 4096."""
        from agent.llm import ClaudeProvider, OpenAICompatibleProvider, OllamaProvider

        for cls in (ClaudeProvider, OpenAICompatibleProvider, OllamaProvider):
            sig = inspect.signature(cls.complete)
            default = sig.parameters["max_tokens"].default
            assert default == 4096, (
                f"{cls.__name__}.complete() default max_tokens={default}, expected 4096"
            )

    def test_complete_is_async_for_all_providers(self):
        """All providers' complete() method must be async."""
        from agent.llm import ClaudeProvider, OpenAICompatibleProvider, OllamaProvider

        for cls in (ClaudeProvider, OpenAICompatibleProvider, OllamaProvider):
            assert asyncio.iscoroutinefunction(cls.complete), (
                f"{cls.__name__}.complete() is not async"
            )

    def test_get_llm_factory_returns_correct_types(self):
        """get_llm returns proper provider for each string."""
        from agent.llm import get_llm, OllamaProvider

        # Ollama doesn't need an API key, safe to instantiate
        provider = get_llm("ollama", "llama3.1")
        assert isinstance(provider, OllamaProvider)

    def test_get_llm_factory_rejects_unknown_provider(self):
        """get_llm raises ValueError for unknown provider."""
        from agent.llm import get_llm

        with pytest.raises(ValueError, match="Unknown LLM provider"):
            get_llm("unknown_provider")


# ===========================================================================
# Test 5: Dashboard Response Format Stability
# ===========================================================================


class TestDashboardResponseFormatStability:
    """Verify API response formats remain consistent."""

    def test_list_runs_returns_runs_array(self, client):
        """GET /api/runs always returns {"runs": [...]}."""
        response = client.get("/api/runs")
        assert response.status_code == 200
        data = response.json()
        assert "runs" in data
        assert isinstance(data["runs"], list)

    def test_get_run_nonexistent_returns_404_with_detail(self, client):
        """GET /api/runs/{id} returns 404 with detail for unknown run."""
        response = client.get("/api/runs/nonexistent-id")
        assert response.status_code == 404
        data = response.json()
        assert "detail" in data

    def test_post_runs_missing_fields_returns_400(self, client):
        """POST /api/runs with bad data returns 400 with detail."""
        response = client.post("/api/runs", json={})
        assert response.status_code == 400
        data = response.json()
        assert "detail" in data

    def test_list_runs_entries_have_run_id(self, client, tmp_path):
        """Runs listed must include run_id field."""
        # Create a fake run directory in the runs dir
        from dashboard.app import RUNS_DIR

        fake_run_dir = RUNS_DIR / "fake-test-run"
        fake_run_dir.mkdir(parents=True, exist_ok=True)
        try:
            progress = {
                "run_id": "fake-test-run",
                "current_iteration": 0,
                "current_score": 0,
                "status": "RUNNING",
            }
            (fake_run_dir / "progress.yaml").write_text(
                yaml.dump(progress)
            )

            response = client.get("/api/runs")
            data = response.json()
            found = [r for r in data["runs"] if r["run_id"] == "fake-test-run"]
            assert len(found) == 1
            assert "status" in found[0]
        finally:
            import shutil

            shutil.rmtree(fake_run_dir, ignore_errors=True)


# ===========================================================================
# Test 6: Concurrent Run Safety
# ===========================================================================


class TestConcurrentRunSafety:
    """Verify that concurrent runs get distinct IDs and don't interfere."""

    def test_concurrent_loops_get_different_run_ids(self, tmp_path, mock_llm):
        """Two loops instantiated simultaneously get different run_ids."""
        from agent.config import RunConfig
        from agent.loop import AutoresearchLoop
        from agent.audit import AuditTrail
        from agent.constraints import ConstraintValidator
        from agent.learnings import LearningsStore
        from agent.hypothesis import HypothesisGenerator
        from agent.modifier import ArtifactModifier

        artifact = tmp_path / "art.md"
        artifact.write_text("Sample content for concurrent test.")

        config = RunConfig(
            mode="proposal",
            target_path=artifact,
            metric="readability",
            threshold=90.0,
            max_iterations=2,
        )

        def make_loop(name):
            run_dir = tmp_path / name
            audit = AuditTrail(run_dir)
            learnings = LearningsStore(run_dir / "learnings.yaml")
            constraints = ConstraintValidator([])
            hyp_gen = HypothesisGenerator(mock_llm, "proposal", learnings)
            modifier = ArtifactModifier(mock_llm)
            scorer = AsyncMock()
            scorer.score = AsyncMock(return_value=50.0)
            return AutoresearchLoop(
                config=config,
                llm=mock_llm,
                scorer=scorer,
                constraints=constraints,
                audit=audit,
                learnings=learnings,
                hypothesis_gen=hyp_gen,
                modifier=modifier,
            )

        loop_a = make_loop("run_a")
        loop_b = make_loop("run_b")
        assert loop_a.run_id != loop_b.run_id

    def test_concurrent_audit_trails_are_separate(self, tmp_path):
        """Two audit trails in different dirs don't interfere."""
        from agent.audit import AuditTrail

        audit_a = AuditTrail(tmp_path / "run_a")
        audit_b = AuditTrail(tmp_path / "run_b")

        audit_a.log_baseline("Content A", 60.0)
        audit_b.log_baseline("Content B", 70.0)

        data_a = yaml.safe_load(
            (tmp_path / "run_a" / "baseline.yaml").read_text()
        )
        data_b = yaml.safe_load(
            (tmp_path / "run_b" / "baseline.yaml").read_text()
        )

        assert data_a["score"] == 60.0
        assert data_b["score"] == 70.0
        assert data_a["hash"] != data_b["hash"]


# ===========================================================================
# Test 7: Empty/Minimal Input Handling
# ===========================================================================


class TestEmptyMinimalInputHandling:
    """Verify graceful handling of empty and minimal inputs."""

    @pytest.mark.asyncio
    async def test_empty_artifact_readability_scorer(self):
        """Empty artifact -> readability scorer should not crash."""
        from scorers.readability_scorer import ReadabilityScorer

        scorer = ReadabilityScorer()
        score = await scorer.score("")
        assert isinstance(score, float)
        assert 0 <= score <= 100

    @pytest.mark.asyncio
    async def test_single_word_artifact_readability_scorer(self):
        """Single word artifact -> readability scorer should not crash."""
        from scorers.readability_scorer import ReadabilityScorer

        scorer = ReadabilityScorer()
        score = await scorer.score("Hello")
        assert isinstance(score, float)
        assert 0 <= score <= 100

    @pytest.mark.asyncio
    async def test_whitespace_only_artifact_readability_scorer(self):
        """Whitespace-only artifact -> readability scorer should not crash."""
        from scorers.readability_scorer import ReadabilityScorer

        scorer = ReadabilityScorer()
        score = await scorer.score("   \n\t\n   ")
        assert isinstance(score, float)
        assert 0 <= score <= 100

    @pytest.mark.asyncio
    async def test_empty_artifact_page_utilization_scorer(self):
        """Empty artifact -> page utilization scorer should not crash."""
        from scorers.readability_scorer import PageUtilizationScorer

        scorer = PageUtilizationScorer(max_pages=20)
        score = await scorer.score("")
        assert isinstance(score, float)
        assert 0 <= score <= 100

    @pytest.mark.asyncio
    async def test_win_theme_scorer_empty_themes(self):
        """WinThemeScorer with empty themes list should return 100."""
        from scorers.proposal_scorer import WinThemeScorer

        scorer = WinThemeScorer([])
        score = await scorer.score("Some content here")
        assert score == 100.0

    @pytest.mark.asyncio
    async def test_win_theme_scorer_empty_content(self):
        """WinThemeScorer with empty content should not crash."""
        from scorers.proposal_scorer import WinThemeScorer

        scorer = WinThemeScorer(["theme1"])
        score = await scorer.score("")
        assert isinstance(score, float)

    def test_empty_learnings_store_context(self, tmp_path):
        """Empty learnings store returns valid context string."""
        from agent.learnings import LearningsStore

        store = LearningsStore(tmp_path / "learnings.yaml")
        ctx = store.get_context_for_hypothesis_generation()
        assert isinstance(ctx, str)
        assert len(ctx) > 0

    def test_constraint_validator_with_empty_artifact(self):
        """Constraint validator handles empty artifact content."""
        from agent.constraints import ConstraintValidator

        validator = ConstraintValidator([])
        passed, violations = validator.validate("")
        assert passed is True
        assert violations == []

    def test_modifier_validate_empty_output(self):
        """ArtifactModifier rejects empty modified output."""
        from agent.modifier import ArtifactModifier

        modifier = ArtifactModifier(mock_llm)
        valid, msg = modifier.validate_modification("before", "", None)
        assert valid is False
        assert "empty" in msg.lower()

    def test_modifier_validate_no_change(self):
        """ArtifactModifier rejects when modified == original."""
        from agent.modifier import ArtifactModifier

        modifier = ArtifactModifier(mock_llm)
        content = "Same content"
        valid, msg = modifier.validate_modification(content, content, None)
        assert valid is False


# ===========================================================================
# Test 8: Large Input Handling
# ===========================================================================


class TestLargeInputHandling:
    """Verify handling of large artifacts."""

    @pytest.mark.asyncio
    async def test_large_artifact_readability_scorer(self):
        """Artifact with 50,000 words -> readability scorer handles it."""
        from scorers.readability_scorer import ReadabilityScorer

        scorer = ReadabilityScorer()
        # Generate a large artifact (~50k words)
        sentence = "The quick brown fox jumps over the lazy dog and runs across the field. "
        large_content = sentence * 5000  # ~50k words
        score = await scorer.score(large_content)
        assert isinstance(score, float)
        assert 0 <= score <= 100

    def test_hypothesis_generator_truncates_long_artifacts(self):
        """HypothesisGenerator truncates artifacts over 6000 chars in prompts."""
        from agent.hypothesis import HypothesisGenerator

        # Verify the truncation constant exists in the source
        source = inspect.getsource(HypothesisGenerator.generate)
        assert "6000" in source, (
            "HypothesisGenerator.generate should truncate artifacts at 6000 chars"
        )

    def test_modifier_compute_diff_with_large_input(self):
        """ArtifactModifier.compute_diff handles large inputs."""
        from agent.modifier import ArtifactModifier

        modifier = ArtifactModifier(None)
        line = "This is a line of text that repeats many times.\n"
        before = line * 1000
        after = line * 999 + "Modified final line.\n"
        diff = modifier.compute_diff(before, after)
        assert isinstance(diff, str)
        assert len(diff) > 0

    @pytest.mark.asyncio
    async def test_large_artifact_page_utilization_scorer(self):
        """PageUtilizationScorer with content exceeding page limit returns 0."""
        from scorers.readability_scorer import PageUtilizationScorer

        scorer = PageUtilizationScorer(max_pages=2, words_per_page=250)
        # 600 words = 2.4 pages, exceeds 2-page limit
        large_content = " ".join(["word"] * 600)
        score = await scorer.score(large_content)
        assert score == 0.0  # Over limit


# ===========================================================================
# Test 9: Empty Artifact Does Not Crash Hypothesis Generator
# ===========================================================================


class TestEmptyArtifactHypothesisGenerator:
    """Verify hypothesis generator handles empty artifacts gracefully."""

    @pytest.mark.asyncio
    async def test_empty_artifact_generates_hypotheses(self):
        """Empty artifact should still produce at least one hypothesis."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        llm.complete = AsyncMock(return_value=json.dumps([
            {"description": "Add baseline content", "expected_impact": "High",
             "risk": "low", "priority": 1}
        ]))

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "proposal", store)
        hypotheses = await gen.generate("", 0.0, {}, [])
        assert len(hypotheses) >= 1
        assert hypotheses[0].description is not None

    @pytest.mark.asyncio
    async def test_none_like_empty_artifact(self):
        """Whitespace-only artifact should not crash the generator."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        llm.complete = AsyncMock(return_value=json.dumps([
            {"description": "Add content", "expected_impact": "High",
             "risk": "low", "priority": 1}
        ]))

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "compliance", store)
        hypotheses = await gen.generate("   \n\t  ", 0.0, {}, [])
        assert len(hypotheses) >= 1


# ===========================================================================
# Test 10: LLM Returning Malformed JSON Is Handled Gracefully
# ===========================================================================


class TestMalformedLLMJsonHandling:
    """Verify hypothesis generator handles malformed LLM JSON responses."""

    @pytest.mark.asyncio
    async def test_malformed_json_falls_back_to_generic_hypothesis(self):
        """When LLM returns garbage, generator should fall back to generic hypothesis."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        llm.complete = AsyncMock(return_value="This is not JSON at all {{{broken")

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "proposal", store)
        hypotheses = await gen.generate("Some artifact content.", 50.0, {}, [])
        # Should fall back to at least one generic hypothesis
        assert len(hypotheses) >= 1
        assert "improve" in hypotheses[0].description.lower() or len(hypotheses[0].description) > 0

    @pytest.mark.asyncio
    async def test_partial_json_still_parses_valid_entries(self):
        """If LLM returns partial JSON with some valid entries, those should be parsed."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        # Valid JSON array but with missing fields in some entries
        llm.complete = AsyncMock(return_value=json.dumps([
            {"description": "Valid hypothesis", "expected_impact": "High",
             "risk": "low", "priority": 1},
            {"description": "Another valid one", "expected_impact": "Medium",
             "risk": "medium", "priority": 2},
        ]))

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "proposal", store)
        hypotheses = await gen.generate("Content.", 40.0, {}, [])
        assert len(hypotheses) == 2
        assert hypotheses[0].description == "Valid hypothesis"

    @pytest.mark.asyncio
    async def test_empty_string_response_produces_fallback(self):
        """Empty LLM response should produce a fallback hypothesis."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        llm.complete = AsyncMock(return_value="")

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "compliance", store)
        hypotheses = await gen.generate("Some content.", 60.0, {}, [])
        assert len(hypotheses) >= 1


# ===========================================================================
# Test 11: Scorer Returning NaN Is Handled (Defaults to 0)
# ===========================================================================


class TestScorerNaNHandling:
    """Verify that NaN scores are handled gracefully in the loop."""

    @pytest.mark.asyncio
    async def test_nan_score_treated_as_no_improvement(self):
        """A scorer returning NaN should result in DISCARD, not crash."""
        import math
        import tempfile
        from agent.audit import AuditTrail
        from agent.config import RunConfig
        from agent.constraints import ConstraintValidator
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore
        from agent.loop import AutoresearchLoop
        from agent.modifier import ArtifactModifier

        class NaNScorer:
            """Scorer that returns NaN on second call."""
            def __init__(self):
                self._call = 0
            async def score(self, content, context=None):
                self._call += 1
                if self._call == 1:
                    return 50.0  # baseline
                return float("nan")  # NaN on subsequent calls
            def describe(self):
                return "NaN test scorer"
            @property
            def direction(self):
                return "higher_is_better"

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text("# Test\nContent for NaN test.\n")

            config = RunConfig(
                mode="proposal", target_path=target, metric="test",
                threshold=95.0, max_iterations=3,
            )
            run_dir = Path(tmpdir) / "run"

            llm = AsyncMock()
            llm.complete = AsyncMock(side_effect=[
                # hypothesis generation
                json.dumps([{"description": "Improve", "expected_impact": "High",
                             "risk": "low", "priority": 1}]),
                # modification
                "# Test\nContent for NaN test.\n\nImproved section.\n",
                # subsequent hypothesis calls
                json.dumps([{"description": "Improve 2", "expected_impact": "High",
                             "risk": "low", "priority": 1}]),
                "# Test\nContent for NaN test.\n\nImproved section 2.\n",
                json.dumps([{"description": "Improve 3", "expected_impact": "High",
                             "risk": "low", "priority": 1}]),
                "# Test\nContent for NaN test.\n\nImproved section 3.\n",
            ])

            loop = AutoresearchLoop(
                config=config, llm=llm,
                scorer=NaNScorer(),
                constraints=ConstraintValidator([]),
                audit=AuditTrail(run_dir),
                learnings=LearningsStore(run_dir / "learnings.yaml"),
                hypothesis_gen=HypothesisGenerator(llm, "proposal",
                    LearningsStore(run_dir / "learnings.yaml")),
                modifier=ArtifactModifier(llm),
            )

            # The loop should not crash -- NaN delta means no improvement
            result = await loop.run()
            assert result is not None
            # NaN comparisons are always False, so delta > 0 is False => DISCARD
            assert result.halt_reason in ("plateau", "max_iterations")


# ===========================================================================
# Test 12: Constraint Violation During Iteration Triggers DISCARD Not Crash
# ===========================================================================


class TestConstraintViolationDiscard:
    """Verify DISCARD constraint violations don't crash the loop."""

    @pytest.mark.asyncio
    async def test_discard_constraint_continues_loop(self):
        """A DISCARD constraint violation should skip the iteration, not crash."""
        import tempfile
        from agent.constraints import Constraint

        with tempfile.TemporaryDirectory() as tmpdir:
            from tests.test_uat import _build_loop as uat_build_loop

            discard_constraint = Constraint(
                name="Word Count Limit",
                description="Max 5 words",
                validation_type="word_count",
                parameters={"max": 5},
                on_violation="DISCARD",
            )

            target = Path(tmpdir) / "artifact.md"
            target.write_text("Short text only.")

            from agent.audit import AuditTrail
            from agent.config import RunConfig
            from agent.constraints import ConstraintValidator
            from agent.hypothesis import HypothesisGenerator
            from agent.learnings import LearningsStore
            from agent.loop import AutoresearchLoop
            from agent.modifier import ArtifactModifier

            config = RunConfig(
                mode="proposal", target_path=target, metric="test",
                threshold=95.0, max_iterations=5,
            )
            run_dir = Path(tmpdir) / "run"

            llm = AsyncMock()
            llm.complete = AsyncMock(side_effect=[
                json.dumps([{"description": "Add content", "expected_impact": "High",
                             "risk": "low", "priority": 1}]),
                "Short text only. Plus a lot more words added here to violate the constraint.",
                json.dumps([{"description": "Add more", "expected_impact": "High",
                             "risk": "low", "priority": 1}]),
                "Short text only. Even more words added to violate constraint again.",
                json.dumps([{"description": "Add even more", "expected_impact": "High",
                             "risk": "low", "priority": 1}]),
                "Short text only. Yet another expansion of content beyond the limit.",
            ])

            class FixedScorer:
                async def score(self, content, context=None):
                    return 50.0
                def describe(self):
                    return "Fixed scorer"
                @property
                def direction(self):
                    return "higher_is_better"

            loop = AutoresearchLoop(
                config=config, llm=llm,
                scorer=FixedScorer(),
                constraints=ConstraintValidator([discard_constraint]),
                audit=AuditTrail(run_dir),
                learnings=LearningsStore(run_dir / "learnings.yaml"),
                hypothesis_gen=HypothesisGenerator(llm, "proposal",
                    LearningsStore(run_dir / "learnings.yaml")),
                modifier=ArtifactModifier(llm),
            )

            result = await loop.run()
            # Should not crash -- ends on plateau or max_iterations
            assert result.halt_reason in ("plateau", "max_iterations")
            # All iterations should be DISCARD (constraint violation)
            for it in result.iterations:
                assert it.decision == "DISCARD"


# ===========================================================================
# Test 13: HALT Constraint Stops the Loop Immediately
# ===========================================================================


class TestHaltConstraintStopsLoop:
    """Verify HALT constraint stops the loop immediately."""

    @pytest.mark.asyncio
    async def test_halt_constraint_stops_on_first_violation(self):
        """HALT constraint should stop the loop on first violation."""
        import tempfile
        from agent.constraints import Constraint
        from agent.audit import AuditTrail
        from agent.config import RunConfig
        from agent.constraints import ConstraintValidator
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore
        from agent.loop import AutoresearchLoop
        from agent.modifier import ArtifactModifier

        with tempfile.TemporaryDirectory() as tmpdir:
            # Use a multi-line artifact so the modification passes the 50%
            # similarity check but still violates the word count constraint.
            original_lines = [
                "Line one of the document.",
                "Line two of the document.",
                "Line three of the document.",
                "Line four of the document.",
                "Line five of the document.",
                "Line six of the document.",
                "Line seven of the document.",
                "Line eight of the document.",
            ]
            original_text = "\n".join(original_lines)
            target = Path(tmpdir) / "artifact.md"
            target.write_text(original_text)

            halt_constraint = Constraint(
                name="Word Count HALT",
                description="Max 10 words",
                validation_type="word_count",
                parameters={"max": 10},
                on_violation="HALT",
            )

            config = RunConfig(
                mode="proposal", target_path=target, metric="test",
                threshold=95.0, max_iterations=10,
            )
            run_dir = Path(tmpdir) / "run"

            class HaltTestLLM:
                """Returns modifications that keep most lines but still
                exceed the word count constraint."""
                async def complete(self, system_prompt, user_message, max_tokens=4096):
                    if any(kw in (system_prompt + user_message).lower()
                           for kw in ("hypothes", "generate", "improvement",
                                      "analyze", "suggest")):
                        return json.dumps([{"description": "Add content",
                                            "expected_impact": "High",
                                            "risk": "low", "priority": 1}])
                    # Return mostly the same content with a small addition
                    # so validate_modification passes (>50% similarity)
                    # but total words exceed 10
                    modified_lines = list(original_lines)
                    modified_lines.append("Additional line added here.")
                    return "\n".join(modified_lines)

            class FixedScorer:
                async def score(self, content, context=None):
                    return 50.0
                def describe(self):
                    return "Fixed scorer"
                @property
                def direction(self):
                    return "higher_is_better"

            llm = HaltTestLLM()
            learnings = LearningsStore(run_dir / "learnings.yaml")
            loop = AutoresearchLoop(
                config=config, llm=llm,
                scorer=FixedScorer(),
                constraints=ConstraintValidator([halt_constraint]),
                audit=AuditTrail(run_dir),
                learnings=learnings,
                hypothesis_gen=HypothesisGenerator(llm, "proposal", learnings),
                modifier=ArtifactModifier(llm),
            )

            result = await loop.run()
            assert result.halt_reason == "constraint_violation"
            assert len(result.iterations) == 1
            assert result.iterations[0].decision == "DISCARD"


# ===========================================================================
# Test 14: Learnings Store Handles Concurrent Read/Write Safely
# ===========================================================================


class TestLearningsConcurrentSafety:
    """Verify learnings store handles concurrent operations."""

    @pytest.mark.asyncio
    async def test_concurrent_writes_produce_consistent_state(self, tmp_path):
        """Multiple concurrent writes should all be recorded."""
        from agent.learnings import LearningsStore
        from agent.config import Hypothesis

        store = LearningsStore(tmp_path / "learnings.yaml")

        hypotheses = [
            Hypothesis(description=f"Hypothesis {i}", expected_impact="High",
                       risk="low", priority=1)
            for i in range(10)
        ]

        # Write entries sequentially (file I/O is not truly concurrent in Python
        # but we verify consistency after rapid sequential writes)
        for i, h in enumerate(hypotheses):
            store.record(i + 1, h, "KEEP" if i % 2 == 0 else "DISCARD",
                         float(i), f"Insight {i}")

        # Verify all entries persisted
        assert len(store.entries) == 10
        # Reload from disk and verify
        store2 = LearningsStore(tmp_path / "learnings.yaml")
        assert len(store2.entries) == 10

    def test_read_after_write_is_consistent(self, tmp_path):
        """Reading immediately after writing returns latest data."""
        from agent.learnings import LearningsStore
        from agent.config import Hypothesis

        store = LearningsStore(tmp_path / "learnings.yaml")
        h = Hypothesis(description="Test hypothesis", expected_impact="Medium",
                       risk="low", priority=1)
        store.record(1, h, "KEEP", 5.0, "Good result")

        # Read back from a fresh store instance
        store2 = LearningsStore(tmp_path / "learnings.yaml")
        assert len(store2.entries) == 1
        assert store2.entries[0]["hypothesis"] == "Test hypothesis"
        assert store2.entries[0]["delta"] == 5.0

    def test_empty_store_get_patterns_returns_empty(self, tmp_path):
        """Empty store returns empty pattern lists."""
        from agent.learnings import LearningsStore

        store = LearningsStore(tmp_path / "learnings.yaml")
        assert store.get_successful_patterns() == []
        assert store.get_failed_patterns() == []


# ===========================================================================
# Test 15: Audit Trail Creates Proper Directory Structure
# ===========================================================================


class TestAuditDirectoryStructure:
    """Verify audit trail creates correct directory hierarchy."""

    def test_audit_trail_creates_run_dir_and_iterations(self, tmp_path):
        """AuditTrail.__init__ should create run_dir and iterations/ subdir."""
        from agent.audit import AuditTrail

        run_dir = tmp_path / "new-run"
        assert not run_dir.exists()

        audit = AuditTrail(run_dir)
        assert run_dir.exists()
        assert (run_dir / "iterations").exists()
        assert run_dir.is_dir()
        assert (run_dir / "iterations").is_dir()

    def test_log_iteration_creates_numbered_iteration_dirs(self, tmp_path):
        """Each logged iteration creates iterations/<n>/ with expected files."""
        from agent.audit import AuditTrail
        from agent.config import Hypothesis, IterationResult

        audit = AuditTrail(tmp_path / "run")
        hyp = Hypothesis(description="Test", expected_impact="High",
                         risk="low", priority=1)

        for i in range(1, 4):
            result = IterationResult(
                iteration=i, hypothesis=hyp, score_before=50.0,
                score_after=55.0, delta=5.0, decision="KEEP",
                rationale="Improved", artifact_hash_before="aaa",
                artifact_hash_after="bbb", diff="--- a\n+++ b",
                duration_seconds=1.0,
            )
            audit.log_iteration(result)

        for i in range(1, 4):
            iter_dir = tmp_path / "run" / "iterations" / str(i)
            assert iter_dir.exists(), f"iterations/{i}/ missing"
            assert (iter_dir / "change.diff").exists()
            assert (iter_dir / "hypothesis.yaml").exists()
            assert (iter_dir / "result.yaml").exists()

    def test_nested_run_dir_creation(self, tmp_path):
        """Deeply nested run_dir should be created without error."""
        from agent.audit import AuditTrail

        deep_dir = tmp_path / "a" / "b" / "c" / "d" / "run"
        audit = AuditTrail(deep_dir)
        assert deep_dir.exists()
        assert (deep_dir / "iterations").exists()


# ===========================================================================
# Test 16: Loop Handles Network Timeout from LLM Gracefully
# ===========================================================================


class TestNetworkTimeoutHandling:
    """Verify the loop handles LLM network timeouts gracefully."""

    @pytest.mark.asyncio
    async def test_llm_timeout_raises_and_loop_catches(self):
        """When LLM raises a timeout exception, the loop should propagate it
        and set progress to HALTED."""
        import tempfile
        from agent.audit import AuditTrail
        from agent.config import RunConfig
        from agent.constraints import ConstraintValidator
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore
        from agent.loop import AutoresearchLoop
        from agent.modifier import ArtifactModifier

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text("# Test\nTimeout test content.\n")

            config = RunConfig(
                mode="proposal", target_path=target, metric="test",
                threshold=95.0, max_iterations=3,
            )
            run_dir = Path(tmpdir) / "run"

            llm = AsyncMock()
            # First call (baseline scoring) works, then hypothesis gen times out
            llm.complete = AsyncMock(side_effect=TimeoutError("Connection timed out"))

            class BaselineOnlyScorer:
                """Returns baseline score then times out."""
                def __init__(self):
                    self._call = 0
                async def score(self, content, context=None):
                    self._call += 1
                    return 50.0
                def describe(self):
                    return "Baseline scorer"
                @property
                def direction(self):
                    return "higher_is_better"

            loop = AutoresearchLoop(
                config=config, llm=llm,
                scorer=BaselineOnlyScorer(),
                constraints=ConstraintValidator([]),
                audit=AuditTrail(run_dir),
                learnings=LearningsStore(run_dir / "learnings.yaml"),
                hypothesis_gen=HypothesisGenerator(llm, "proposal",
                    LearningsStore(run_dir / "learnings.yaml")),
                modifier=ArtifactModifier(llm),
            )

            with pytest.raises(TimeoutError):
                await loop.run()

            # Progress should be set to HALTED
            assert loop.progress.status == "HALTED"
            assert loop.is_running is False


# ===========================================================================
# Test 17: CompositeScorer with Zero Weights Doesn't Divide by Zero
# ===========================================================================


class TestCompositeScorerZeroWeights:
    """Verify CompositeScorer handles edge cases with weights."""

    def test_zero_total_weight_raises_error(self):
        """CompositeScorer with all-zero weights should raise ValueError."""
        from scorers.composite_scorer import CompositeScorer
        from scorers.readability_scorer import ReadabilityScorer

        with pytest.raises(ValueError, match="weights must sum to 1.0"):
            CompositeScorer(
                scorers={
                    "readability": (ReadabilityScorer(), 0.0),
                    "readability2": (ReadabilityScorer(), 0.0),
                }
            )

    def test_weights_not_summing_to_one_raises_error(self):
        """Weights not summing to 1.0 should raise ValueError."""
        from scorers.composite_scorer import CompositeScorer
        from scorers.readability_scorer import ReadabilityScorer

        with pytest.raises(ValueError, match="weights must sum to 1.0"):
            CompositeScorer(
                scorers={
                    "a": (ReadabilityScorer(), 0.3),
                    "b": (ReadabilityScorer(), 0.3),
                }
            )

    @pytest.mark.asyncio
    async def test_single_scorer_weight_one(self):
        """Single scorer with weight 1.0 should return that scorer's score directly."""
        from scorers.composite_scorer import CompositeScorer
        from scorers.readability_scorer import ReadabilityScorer

        scorer = CompositeScorer(
            scorers={"readability": (ReadabilityScorer(), 1.0)}
        )
        content = (
            "This is a well-written document with multiple sentences. "
            "It covers technical topics at a professional reading level."
        )
        score = await scorer.score(content)
        assert isinstance(score, float)
        assert 0 <= score <= 100


# ===========================================================================
# Test 18: hypothesis_count=0 Returns Empty List
# ===========================================================================


class TestHypothesisCountZero:
    """Verify requesting zero hypotheses returns an empty or minimal list."""

    @pytest.mark.asyncio
    async def test_zero_hypotheses_requested(self):
        """Requesting 0 hypotheses should return a fallback (the generator always
        produces at least 1 as a safety net)."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        # Return empty array -- the generator's fallback should kick in
        llm.complete = AsyncMock(return_value="[]")

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "proposal", store)
        hypotheses = await gen.generate("Some content.", 50.0, {}, [], num_hypotheses=0)
        # The generator always returns at least 1 fallback hypothesis
        assert len(hypotheses) >= 1

    @pytest.mark.asyncio
    async def test_one_hypothesis_requested(self):
        """Requesting 1 hypothesis should return exactly 1."""
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore

        llm = AsyncMock()
        llm.complete = AsyncMock(return_value=json.dumps([
            {"description": "Single improvement", "expected_impact": "High",
             "risk": "low", "priority": 1},
            {"description": "Extra one", "expected_impact": "Low",
             "risk": "low", "priority": 2},
        ]))

        store = LearningsStore(Path("/tmp") / f"test-{uuid.uuid4()}" / "learnings.yaml")
        gen = HypothesisGenerator(llm, "proposal", store)
        hypotheses = await gen.generate("Content.", 50.0, {}, [], num_hypotheses=1)
        assert len(hypotheses) == 1
        assert hypotheses[0].description == "Single improvement"
