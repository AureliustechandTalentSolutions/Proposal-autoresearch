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
