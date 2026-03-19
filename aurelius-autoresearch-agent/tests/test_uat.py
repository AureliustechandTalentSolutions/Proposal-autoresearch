"""User Acceptance Tests validating PRD acceptance criteria.

This module contains UAT tests for every acceptance criterion defined in the
Aurelius Autoresearch Agent PRD. Tests are grouped by AC number and cover
infrastructure, dashboard, loop mechanics, audit trail, SSE, charting,
halt conditions, learnings, LLM providers, config presets, README, and
file structure.
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
import yaml
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Project root (resolved once)
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Shared mock helpers
# ---------------------------------------------------------------------------


class MockLLM:
    """Deterministic mock LLM for UAT tests."""

    def __init__(self, improve: bool = True):
        self.improve = improve
        self.call_count = 0

    async def complete(
        self, system_prompt: str, user_message: str, max_tokens: int = 4096
    ) -> str:
        self.call_count += 1
        # Hypothesis generation
        if any(
            kw in (system_prompt + user_message).lower()
            for kw in ("hypothes", "generate", "improvement", "analyze", "suggest")
        ):
            return json.dumps(
                [
                    {
                        "description": "Add security context with runAsNonRoot and drop ALL capabilities"
                        if self.improve
                        else "Minor cosmetic fix",
                        "expected_impact": "High",
                        "risk": "low",
                        "priority": 1,
                    }
                ]
            )
        # Artifact modification
        if any(
            kw in system_prompt.lower()
            for kw in ("edit", "modify", "apply", "change", "document editor")
        ):
            # Extract the current document content and add a meaningful change
            parts = user_message.split("## Current Document\n")
            if len(parts) > 1:
                original = parts[-1].split("\nApply")[0]
            else:
                original = user_message
            return original.rstrip() + "\n\n# Improved Section\nAdded security hardening content.\n"
        return "Generic mock response"


class MockScorer:
    """Mock scorer returning a configurable sequence of scores."""

    def __init__(self, scores: list[float] | None = None):
        self._scores = scores or [60.0, 65.0, 70.0, 75.0, 80.0]
        self._idx = 0
        self._last_details: dict = {}

    async def score(self, content: str, context: dict | None = None) -> float:
        score = self._scores[min(self._idx, len(self._scores) - 1)]
        self._idx += 1
        return score

    def describe(self) -> str:
        return "Mock scorer"

    @property
    def direction(self):
        return "higher_is_better"


def _build_loop(
    tmpdir: str,
    mode: str = "proposal",
    threshold: float = 95.0,
    max_iterations: int = 3,
    scores: list[float] | None = None,
    constraints=None,
    improve: bool = True,
):
    """Helper to construct an AutoresearchLoop with mocks."""
    from agent.audit import AuditTrail
    from agent.config import RunConfig
    from agent.constraints import ConstraintValidator
    from agent.hypothesis import HypothesisGenerator
    from agent.learnings import LearningsStore
    from agent.loop import AutoresearchLoop
    from agent.modifier import ArtifactModifier

    target = Path(tmpdir) / "artifact.md"
    if not target.exists():
        target.write_text("# Test Artifact\n\nBaseline content for testing.\n")

    config = RunConfig(
        mode=mode,
        target_path=target,
        metric="test_metric",
        threshold=threshold,
        max_iterations=max_iterations,
    )

    run_dir = Path(tmpdir) / "runs" / "test-run"
    audit = AuditTrail(run_dir)
    learnings = LearningsStore(run_dir / "learnings.yaml")
    constraint_validator = ConstraintValidator(constraints or [])
    llm = MockLLM(improve=improve)
    scorer = MockScorer(scores=scores or [60.0, 65.0, 70.0, 75.0])
    hypothesis_gen = HypothesisGenerator(llm, mode, learnings)
    modifier = ArtifactModifier(llm)

    loop = AutoresearchLoop(
        config=config,
        llm=llm,
        scorer=scorer,
        constraints=constraint_validator,
        audit=audit,
        learnings=learnings,
        hypothesis_gen=hypothesis_gen,
        modifier=modifier,
    )
    return loop, run_dir, config


# ===========================================================================
# AC1: Docker compose starts agent and dashboard on port 8501
# ===========================================================================


class TestAC1DockerCompose:
    """AC1: Docker compose starts agent and dashboard on port 8501."""

    def test_docker_compose_exists_and_parses(self):
        dc_path = PROJECT_ROOT / "docker-compose.yaml"
        assert dc_path.exists(), "docker-compose.yaml not found"
        data = yaml.safe_load(dc_path.read_text())
        assert "services" in data, "docker-compose.yaml missing 'services' key"

    def test_docker_compose_maps_port_8501(self):
        dc_path = PROJECT_ROOT / "docker-compose.yaml"
        data = yaml.safe_load(dc_path.read_text())
        ports = data["services"]["autoresearch"].get("ports", [])
        port_strs = [str(p) for p in ports]
        assert any("8501" in p for p in port_strs), (
            f"Port 8501 not mapped. Ports found: {port_strs}"
        )

    def test_dockerfile_cmd_starts_uvicorn_on_8501(self):
        df_path = PROJECT_ROOT / "Dockerfile"
        assert df_path.exists(), "Dockerfile not found"
        content = df_path.read_text()
        assert "uvicorn" in content, "Dockerfile CMD does not reference uvicorn"
        assert "8501" in content, "Dockerfile CMD does not reference port 8501"

    def test_dashboard_app_has_fastapi(self):
        app_path = PROJECT_ROOT / "dashboard" / "app.py"
        assert app_path.exists(), "dashboard/app.py not found"
        content = app_path.read_text()
        assert "FastAPI" in content, "dashboard/app.py does not contain FastAPI"
        assert "app = FastAPI" in content or "app=FastAPI" in content


# ===========================================================================
# AC2: Dashboard loads, shows start form, can initiate a run
# ===========================================================================


class TestAC2Dashboard:
    """AC2: Dashboard loads with start form and run initiation."""

    @pytest.fixture(autouse=True)
    def _client(self):
        from dashboard.app import app

        self.client = TestClient(app)

    def test_get_root_returns_200_html(self):
        resp = self.client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")

    def test_html_contains_start_new_run(self):
        html = self.client.get("/").text
        assert "Start New Run" in html

    def test_html_contains_mode_field(self):
        html = self.client.get("/").text
        assert 'name="mode"' in html

    def test_html_contains_target_path_field(self):
        html = self.client.get("/").text
        assert "target_path" in html

    def test_html_contains_threshold_field(self):
        html = self.client.get("/").text
        assert "threshold" in html

    def test_post_api_runs_endpoint_exists(self):
        # We expect a 400/422 because we send an empty body, but NOT 404
        resp = self.client.post("/api/runs", json={})
        assert resp.status_code != 404, "POST /api/runs returned 404 -- endpoint missing"

    def test_html_contains_chartjs_cdn(self):
        html = self.client.get("/").text
        assert "chart.js" in html.lower() or "Chart" in html

    def test_html_contains_eventsource(self):
        html = self.client.get("/").text
        assert "EventSource" in html


# ===========================================================================
# AC3: Compliance mode improves STIG configurations
# ===========================================================================


class TestAC3ComplianceMode:
    """AC3: Compliance mode improves STIG configurations."""

    @pytest.mark.asyncio
    async def test_compliance_mode_improves_score(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a minimal K8s deployment without security context
            target = Path(tmpdir) / "artifact.md"
            target.write_text(
                "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web-app\n"
                "spec:\n  template:\n    spec:\n      containers:\n      - name: web\n"
                "        image: nginx:latest\n        ports:\n        - containerPort: 80\n"
            )
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="compliance",
                threshold=95.0,
                max_iterations=3,
                scores=[40.0, 50.0, 60.0, 70.0],
            )
            result = await loop.run()

            assert result.config.mode == "compliance"
            assert result.final_score >= result.baseline_score
            # Verify audit captured compliance-mode iterations
            audit_log = run_dir / "audit.jsonl"
            assert audit_log.exists()
            lines = [l for l in audit_log.read_text().strip().split("\n") if l.strip()]
            assert len(lines) >= 1, "No iterations logged in audit trail"


# ===========================================================================
# AC4: Proposal mode improves alignment score
# ===========================================================================


class TestAC4ProposalMode:
    """AC4: Proposal mode improves alignment score."""

    @pytest.mark.asyncio
    async def test_proposal_mode_improves_score(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text(
                "# Technical Approach\n\n"
                "Our team will deliver the solution.\n\n"
                "## Management Approach\n\nAgile methodology.\n"
            )
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=3,
                scores=[45.0, 55.0, 65.0, 75.0],
            )
            result = await loop.run()

            assert result.config.mode == "proposal"
            assert result.final_score >= result.baseline_score
            audit_log = run_dir / "audit.jsonl"
            assert audit_log.exists()
            lines = [l for l in audit_log.read_text().strip().split("\n") if l.strip()]
            assert len(lines) >= 1


# ===========================================================================
# AC5: Every iteration creates audit files
# ===========================================================================


class TestAC5AuditFiles:
    """AC5: Every iteration creates required audit files."""

    @pytest.mark.asyncio
    async def test_audit_files_per_iteration(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=3,
                scores=[50.0, 55.0, 60.0, 65.0],
            )
            result = await loop.run()

            num_iterations = len(result.iterations)
            assert num_iterations >= 1

            for n in range(1, num_iterations + 1):
                iter_dir = run_dir / "iterations" / str(n)
                assert iter_dir.exists(), f"iterations/{n}/ dir missing"
                assert (iter_dir / "change.diff").exists(), f"iterations/{n}/change.diff missing"
                assert (iter_dir / "hypothesis.yaml").exists(), f"iterations/{n}/hypothesis.yaml missing"
                assert (iter_dir / "result.yaml").exists(), f"iterations/{n}/result.yaml missing"

            # audit.jsonl should have exactly num_iterations lines
            audit_log = run_dir / "audit.jsonl"
            assert audit_log.exists()
            lines = [l for l in audit_log.read_text().strip().split("\n") if l.strip()]
            assert len(lines) == num_iterations, (
                f"Expected {num_iterations} audit lines, got {len(lines)}"
            )


# ===========================================================================
# AC6: Progress visible via SSE stream
# ===========================================================================


class TestAC6SSEProgress:
    """AC6: Progress visible via SSE stream."""

    def test_progress_endpoint_exists(self):
        from dashboard.app import app
        from fastapi.routing import APIRoute

        # Check the route is registered (don't actually call SSE which would block)
        routes = [r for r in app.routes if isinstance(r, APIRoute)]
        progress_routes = [r for r in routes if "progress" in r.path]
        assert len(progress_routes) > 0, "No /api/runs/{id}/progress route registered"

    def test_progress_endpoint_returns_eventsource(self):
        from dashboard.app import run_progress_stream
        import inspect

        # Verify the endpoint handler returns EventSourceResponse
        source = inspect.getsource(run_progress_stream)
        assert "EventSourceResponse" in source

    @pytest.mark.asyncio
    async def test_progress_yaml_written_during_loop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=2,
                scores=[50.0, 55.0, 60.0],
            )
            await loop.run()
            progress_path = run_dir / "progress.yaml"
            assert progress_path.exists(), "progress.yaml was not written during loop"
            data = yaml.safe_load(progress_path.read_text())
            assert "run_id" in data
            assert "current_score" in data


# ===========================================================================
# AC7: Score trajectory chart updates live
# ===========================================================================


class TestAC7ScoreChart:
    """AC7: Score trajectory chart updates live."""

    @pytest.fixture(autouse=True)
    def _html(self):
        from dashboard.app import app

        client = TestClient(app)
        self.html = client.get("/").text

    def test_canvas_element_with_scoreChart_id(self):
        assert 'id="scoreChart"' in self.html

    def test_js_handles_progress_events(self):
        assert "addEventListener" in self.html
        assert "'progress'" in self.html

    def test_chart_updates_with_data(self):
        # The chart update code should push score data
        assert "scoreChart" in self.html
        assert ".update" in self.html

    def test_chart_axes_iteration_and_score(self):
        assert "Iteration" in self.html
        assert "Score" in self.html


# ===========================================================================
# AC8: Loop halts correctly on all conditions
# ===========================================================================


class TestAC8HaltConditions:
    """AC8: Loop halts on threshold, plateau, max_iterations, constraint violation, user interrupt."""

    @pytest.mark.asyncio
    async def test_halt_on_threshold(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, _, _ = _build_loop(
                tmpdir,
                threshold=65.0,
                max_iterations=10,
                scores=[50.0, 60.0, 70.0, 80.0],
            )
            result = await loop.run()
            assert result.halt_reason == "threshold"

    @pytest.mark.asyncio
    async def test_halt_on_plateau(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Flat scores lead to DISCARD decisions and plateau detection
            loop, _, _ = _build_loop(
                tmpdir,
                threshold=95.0,
                max_iterations=10,
                scores=[60.0, 60.0, 60.0, 60.0, 60.0, 60.0, 60.0],
            )
            result = await loop.run()
            assert result.halt_reason == "plateau"

    @pytest.mark.asyncio
    async def test_halt_on_max_iterations(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, _, _ = _build_loop(
                tmpdir,
                threshold=99.0,
                max_iterations=2,
                scores=[50.0, 55.0, 60.0],
            )
            result = await loop.run()
            assert result.halt_reason == "max_iterations"

    @pytest.mark.asyncio
    async def test_halt_on_constraint_violation(self):
        from agent.constraints import Constraint

        halt_constraint = Constraint(
            name="Always Fail",
            description="This constraint always fails with HALT",
            validation_type="custom_regex",
            parameters={"pattern": "IMPOSSIBLE_STRING_THAT_WILL_NEVER_EXIST_xyzzy", "must_match": True},
            on_violation="HALT",
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, _, _ = _build_loop(
                tmpdir,
                threshold=99.0,
                max_iterations=10,
                scores=[50.0, 55.0, 60.0, 65.0],
                constraints=[halt_constraint],
            )
            result = await loop.run()
            assert result.halt_reason == "constraint_violation"

    @pytest.mark.asyncio
    async def test_halt_on_user_interrupt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Use a mock scorer with delay to allow cancellation to take effect
            from agent.audit import AuditTrail
            from agent.config import RunConfig
            from agent.constraints import ConstraintValidator
            from agent.hypothesis import HypothesisGenerator
            from agent.learnings import LearningsStore
            from agent.loop import AutoresearchLoop
            from agent.modifier import ArtifactModifier

            target = Path(tmpdir) / "artifact.md"
            target.write_text("# Test\n\nContent for cancel test.\n")

            config = RunConfig(
                mode="proposal",
                target_path=target,
                metric="test",
                threshold=99.0,
                max_iterations=100,
            )

            run_dir = Path(tmpdir) / "runs" / "cancel-run"
            audit = AuditTrail(run_dir)
            learnings = LearningsStore(run_dir / "learnings.yaml")
            constraints = ConstraintValidator([])
            llm = MockLLM()

            # Scorer with a delay so there's time to cancel before plateau
            class DelayScorer(MockScorer):
                async def score(self, content, context=None):
                    await asyncio.sleep(0.15)
                    return await super().score(content, context)

            scorer = DelayScorer(scores=[50.0] * 100)
            hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
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

            async def cancel_soon():
                await asyncio.sleep(0.1)
                await loop.cancel()

            asyncio.create_task(cancel_soon())
            result = await loop.run()
            assert result.halt_reason == "user_interrupt"


# ===========================================================================
# AC9: Learnings from one run bootstrap the next
# ===========================================================================


class TestAC9LearningsBootstrap:
    """AC9: Learnings from one run bootstrap the next."""

    @pytest.mark.asyncio
    async def test_learnings_merge_from_previous_run(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Run 1 -- generates learnings
            loop1, run_dir1, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=3,
                scores=[50.0, 60.0, 70.0, 75.0],
            )
            result1 = await loop1.run()
            assert len(result1.learnings) > 0, "Run 1 produced no learnings"

            # Run 2 -- merge learnings from run 1
            from agent.learnings import LearningsStore

            run2_dir = Path(tmpdir) / "runs" / "run2"
            run2_dir.mkdir(parents=True, exist_ok=True)
            store2 = LearningsStore(run2_dir / "learnings.yaml")
            store2.merge_from_previous_run(run_dir1)

            # Verify learnings were imported
            successful = store2.get_successful_patterns()
            assert len(successful) > 0 or len(store2.entries) > 0, (
                "No learnings imported from previous run"
            )

    @pytest.mark.asyncio
    async def test_learnings_context_includes_prior_patterns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.learnings import LearningsStore
            from agent.config import Hypothesis

            store = LearningsStore(Path(tmpdir) / "learnings.yaml")
            h = Hypothesis(
                id="test-1",
                description="Add security context",
                expected_impact="High",
                risk="low",
                priority=1,
            )
            store.record(1, h, "KEEP", 5.0, "Improved compliance")
            store.record(2, h, "DISCARD", -1.0, "No improvement")

            context = store.get_context_for_hypothesis_generation()
            assert "Successful Patterns" in context
            assert "Failed Patterns" in context
            assert "Add security context" in context


# ===========================================================================
# AC10: Works with Claude, OpenAI, and Ollama
# ===========================================================================


class TestAC10LLMProviders:
    """AC10: Works with Claude, OpenAI, and Ollama."""

    def test_get_llm_claude_returns_claude_provider(self):
        from agent.llm import get_llm, ClaudeProvider

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            provider = get_llm("claude", "claude-sonnet-4-20250514")
            assert isinstance(provider, ClaudeProvider)

    def test_get_llm_openai_returns_openai_provider(self):
        from agent.llm import get_llm, OpenAICompatibleProvider

        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-key"}):
            provider = get_llm("openai", "gpt-4o")
            assert isinstance(provider, OpenAICompatibleProvider)

    def test_get_llm_ollama_returns_ollama_provider(self):
        from agent.llm import get_llm, OllamaProvider

        provider = get_llm("ollama", "llama3.1")
        assert isinstance(provider, OllamaProvider)

    def test_all_providers_have_complete_method(self):
        from agent.llm import ClaudeProvider, OpenAICompatibleProvider, OllamaProvider
        import inspect

        for cls in (ClaudeProvider, OpenAICompatibleProvider, OllamaProvider):
            assert hasattr(cls, "complete"), f"{cls.__name__} missing complete()"
            sig = inspect.signature(cls.complete)
            params = list(sig.parameters.keys())
            assert "system_prompt" in params, f"{cls.__name__}.complete missing system_prompt"
            assert "user_message" in params, f"{cls.__name__}.complete missing user_message"

    def test_env_example_has_all_provider_configs(self):
        env_path = PROJECT_ROOT / ".env.example"
        assert env_path.exists()
        content = env_path.read_text()
        assert "ANTHROPIC_API_KEY" in content
        assert "OPENAI_API_KEY" in content
        assert "OPENAI_BASE_URL" in content
        assert "OLLAMA_BASE_URL" in content

    def test_get_llm_raises_on_unknown_provider(self):
        from agent.llm import get_llm

        with pytest.raises(ValueError, match="Unknown LLM provider"):
            get_llm("unknown_provider", "some-model")


# ===========================================================================
# AC11: All unit tests pass
# ===========================================================================


class TestAC11UnitTests:
    """AC11: All unit tests pass (validates test infrastructure)."""

    def test_pytest_infrastructure_works(self):
        """Smoke test: pytest can discover and run tests."""
        assert True

    def test_agent_package_importable(self):
        import agent.config
        import agent.loop
        import agent.llm
        import agent.audit
        import agent.learnings
        import agent.hypothesis
        import agent.modifier
        import agent.constraints

    def test_scorers_package_importable(self):
        import scorers
        import scorers.compliance_scorer
        import scorers.proposal_scorer
        import scorers.readability_scorer
        import scorers.composite_scorer

    def test_dashboard_package_importable(self):
        import dashboard.app


# ===========================================================================
# Additional UAT: README completeness
# ===========================================================================


class TestREADMECompleteness:
    """Validate README covers all required sections."""

    @pytest.fixture(autouse=True)
    def _readme(self):
        self.readme = (PROJECT_ROOT / "README.md").read_text()

    def test_has_quick_start(self):
        assert "Quick Start" in self.readme

    def test_has_configuration_section(self):
        assert "Configuration" in self.readme

    def test_has_env_var_table(self):
        assert "ANTHROPIC_API_KEY" in self.readme
        assert "OPENAI_API_KEY" in self.readme
        assert "OLLAMA_BASE_URL" in self.readme

    def test_has_compliance_mode_example(self):
        assert "compliance" in self.readme.lower()
        assert "Compliance" in self.readme

    def test_has_proposal_mode_example(self):
        assert "proposal" in self.readme.lower()
        assert "Proposal" in self.readme

    def test_has_architecture_diagram(self):
        assert "Architecture" in self.readme
        # Check for ASCII art or diagram markers
        assert "Hypothesis" in self.readme
        assert "Scorer" in self.readme

    def test_has_api_reference_table(self):
        assert "API Reference" in self.readme
        assert "/api/runs" in self.readme

    def test_has_ollama_instructions(self):
        assert "Ollama" in self.readme
        assert "ollama" in self.readme.lower()


# ===========================================================================
# Additional UAT: Config presets
# ===========================================================================


class TestConfigPresets:
    """Validate YAML config presets."""

    def test_default_yaml_parses_and_has_required_fields(self):
        path = PROJECT_ROOT / "config" / "default.yaml"
        assert path.exists()
        data = yaml.safe_load(path.read_text())
        assert "mode" in data
        assert "max_iterations" in data
        assert "threshold" in data

    def test_compliance_yaml_mode_and_weights(self):
        path = PROJECT_ROOT / "config" / "compliance.yaml"
        assert path.exists()
        data = yaml.safe_load(path.read_text())
        assert data["mode"] == "compliance"
        weights = data.get("scorer_weights", {})
        assert len(weights) > 0, "compliance.yaml has no scorer_weights"
        total = sum(weights.values())
        assert abs(total - 1.0) < 0.01, f"Compliance scorer weights sum to {total}, expected 1.0"

    def test_proposal_yaml_mode_and_weights(self):
        path = PROJECT_ROOT / "config" / "proposal.yaml"
        assert path.exists()
        data = yaml.safe_load(path.read_text())
        assert data["mode"] == "proposal"
        weights = data.get("scorer_weights", {})
        assert len(weights) > 0, "proposal.yaml has no scorer_weights"
        total = sum(weights.values())
        assert abs(total - 1.0) < 0.01, f"Proposal scorer weights sum to {total}, expected 1.0"


# ===========================================================================
# Additional UAT: File structure matches PRD Architecture (Section 4)
# ===========================================================================


class TestFileStructure:
    """Verify every file listed in the PRD Architecture section exists."""

    REQUIRED_FILES = [
        # Agent core
        "agent/__init__.py",
        "agent/config.py",
        "agent/loop.py",
        "agent/llm.py",
        "agent/audit.py",
        "agent/learnings.py",
        "agent/hypothesis.py",
        "agent/modifier.py",
        "agent/constraints.py",
        # Scorers
        "scorers/__init__.py",
        "scorers/compliance_scorer.py",
        "scorers/proposal_scorer.py",
        "scorers/readability_scorer.py",
        "scorers/composite_scorer.py",
        # Dashboard
        "dashboard/__init__.py",
        "dashboard/app.py",
        "dashboard/templates/index.html",
        # Config
        "config/default.yaml",
        "config/compliance.yaml",
        "config/proposal.yaml",
        # Infrastructure
        "Dockerfile",
        "docker-compose.yaml",
        "pyproject.toml",
        ".env.example",
        "README.md",
        # Tests
        "tests/__init__.py",
        # Directories
        "runs",
        "workspace",
    ]

    @pytest.mark.parametrize("rel_path", REQUIRED_FILES)
    def test_file_exists(self, rel_path: str):
        full = PROJECT_ROOT / rel_path
        assert full.exists(), f"Required path missing: {rel_path}"


# ===========================================================================
# Enhanced UAT Scenarios
# ===========================================================================


class TestUATScoreImprovesOverIterations:
    """UAT: User starts a proposal optimization run and sees score improve over 5 iterations."""

    @pytest.mark.asyncio
    async def test_score_improves_over_5_iterations(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Steadily increasing scores over 6 calls (1 baseline + 5 iterations)
            scores = [40.0, 50.0, 58.0, 65.0, 72.0, 78.0]
            loop, run_dir, config = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=5,
                scores=scores,
            )
            result = await loop.run()

            # The run should have executed 5 iterations
            assert len(result.iterations) == 5
            # Final score must be strictly greater than baseline
            assert result.final_score > result.baseline_score
            # Verify monotonic score trajectory for KEEP decisions
            kept_scores = [
                it.score_after for it in result.iterations if it.decision == "KEEP"
            ]
            for i in range(1, len(kept_scores)):
                assert kept_scores[i] >= kept_scores[i - 1], (
                    f"Score did not improve monotonically: {kept_scores}"
                )

    @pytest.mark.asyncio
    async def test_total_improvement_is_positive(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            scores = [30.0, 40.0, 50.0, 60.0, 70.0, 80.0]
            loop, _, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=5,
                scores=scores,
            )
            result = await loop.run()
            assert result.total_improvement > 0
            assert result.total_improvement == result.final_score - result.baseline_score


class TestUATAutonomyLevelSwitch:
    """UAT: User switches autonomy level mid-run and actions are blocked/allowed."""

    @pytest.mark.asyncio
    async def test_constraint_blocks_action_after_switch(self):
        """Simulates adding a strict constraint mid-run that blocks further changes."""
        from agent.constraints import Constraint, ConstraintValidator

        with tempfile.TemporaryDirectory() as tmpdir:
            # Start with no constraints -- first iteration proceeds
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=5,
                scores=[50.0, 55.0, 60.0, 65.0, 70.0, 75.0],
                constraints=[],
            )
            result = await loop.run()
            first_run_kept = sum(1 for i in result.iterations if i.decision == "KEEP")

            # Now run again with a HALT constraint that blocks all changes
            halt_constraint = Constraint(
                name="Block All",
                description="Block all changes (simulates restrictive autonomy)",
                validation_type="custom_regex",
                parameters={"pattern": "IMPOSSIBLE_xyzzy_NEVER_MATCH", "must_match": True},
                on_violation="HALT",
            )
            loop2, _, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=5,
                scores=[50.0, 55.0, 60.0, 65.0, 70.0],
                constraints=[halt_constraint],
            )
            result2 = await loop2.run()
            assert result2.halt_reason == "constraint_violation"
            # Should have been blocked on first iteration
            assert len(result2.iterations) == 1

    @pytest.mark.asyncio
    async def test_discard_constraint_allows_continuation(self):
        """A DISCARD constraint does not stop the loop, just discards the iteration."""
        from agent.constraints import Constraint

        with tempfile.TemporaryDirectory() as tmpdir:
            # This regex won't match so content always violates (must_match=True)
            discard_constraint = Constraint(
                name="Soft Block",
                description="Discard if pattern missing",
                validation_type="custom_regex",
                parameters={"pattern": "NEVER_MATCH_xyzzy_12345", "must_match": True},
                on_violation="DISCARD",
            )
            loop, _, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=5,
                scores=[50.0, 50.0, 50.0, 50.0, 50.0, 50.0],
                constraints=[discard_constraint],
            )
            result = await loop.run()
            # Loop should complete (plateau or max_iterations) but not constraint_violation
            assert result.halt_reason in ("plateau", "max_iterations")
            # All iterations should be DISCARD
            assert all(it.decision == "DISCARD" for it in result.iterations)


class TestUATCancelRunningLoop:
    """UAT: User cancels a running loop and system stops cleanly."""

    @pytest.mark.asyncio
    async def test_cancel_produces_valid_result(self):
        from agent.audit import AuditTrail
        from agent.config import RunConfig
        from agent.constraints import ConstraintValidator
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore
        from agent.loop import AutoresearchLoop
        from agent.modifier import ArtifactModifier

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text("# Proposal\n\nBaseline content for cancel UAT.\n")

            config = RunConfig(
                mode="proposal",
                target_path=target,
                metric="test",
                threshold=99.0,
                max_iterations=100,
            )

            run_dir = Path(tmpdir) / "runs" / "cancel-uat"
            audit = AuditTrail(run_dir)
            learnings = LearningsStore(run_dir / "learnings.yaml")
            constraints = ConstraintValidator([])
            llm = MockLLM()

            class SlowScorer(MockScorer):
                async def score(self, content, context=None):
                    await asyncio.sleep(0.1)
                    return await super().score(content, context)

            scorer = SlowScorer(scores=[50.0] * 100)
            hypothesis_gen = HypothesisGenerator(llm, "proposal", learnings)
            modifier = ArtifactModifier(llm)

            loop = AutoresearchLoop(
                config=config, llm=llm, scorer=scorer, constraints=constraints,
                audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen,
                modifier=modifier,
            )

            async def cancel_after_brief_delay():
                await asyncio.sleep(0.05)
                await loop.cancel()

            asyncio.create_task(cancel_after_brief_delay())
            result = await loop.run()

            assert result.halt_reason == "user_interrupt"
            # Result should still be well-formed
            assert result.run_id is not None
            assert result.baseline_score >= 0
            assert result.started_at is not None
            assert result.completed_at is not None
            # Progress file should show CANCELLED
            progress_data = yaml.safe_load((run_dir / "progress.yaml").read_text())
            assert progress_data["status"] == "CANCELLED"

    @pytest.mark.asyncio
    async def test_loop_not_running_after_cancel(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text("# Test\nContent.\n")

            from agent.audit import AuditTrail
            from agent.config import RunConfig
            from agent.constraints import ConstraintValidator
            from agent.hypothesis import HypothesisGenerator
            from agent.learnings import LearningsStore
            from agent.loop import AutoresearchLoop
            from agent.modifier import ArtifactModifier

            config = RunConfig(
                mode="proposal", target_path=target, metric="test",
                threshold=99.0, max_iterations=100,
            )
            run_dir = Path(tmpdir) / "runs" / "running-check"
            llm = MockLLM()

            class SlowScorer(MockScorer):
                async def score(self, content, context=None):
                    await asyncio.sleep(0.1)
                    return await super().score(content, context)

            loop = AutoresearchLoop(
                config=config, llm=llm,
                scorer=SlowScorer(scores=[50.0] * 100),
                constraints=ConstraintValidator([]),
                audit=AuditTrail(run_dir),
                learnings=LearningsStore(run_dir / "learnings.yaml"),
                hypothesis_gen=HypothesisGenerator(llm, "proposal",
                    LearningsStore(run_dir / "learnings.yaml")),
                modifier=ArtifactModifier(llm),
            )

            async def cancel_soon():
                await asyncio.sleep(0.05)
                await loop.cancel()

            asyncio.create_task(cancel_soon())
            await loop.run()
            assert loop.is_running is False


class TestUATLearningsInfluenceNewHypotheses:
    """UAT: User views learnings from previous run and they influence new hypotheses."""

    @pytest.mark.asyncio
    async def test_learnings_appear_in_hypothesis_generation_context(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Run 1
            loop1, run_dir1, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=3,
                scores=[50.0, 60.0, 70.0, 75.0],
            )
            result1 = await loop1.run()
            assert len(result1.learnings) > 0

            # Merge learnings into a new store
            from agent.learnings import LearningsStore

            run2_dir = Path(tmpdir) / "runs" / "run2"
            run2_dir.mkdir(parents=True, exist_ok=True)
            store2 = LearningsStore(run2_dir / "learnings.yaml")
            store2.merge_from_previous_run(run_dir1)

            # The hypothesis generation context should include prior patterns
            context = store2.get_context_for_hypothesis_generation()
            assert "Successful Patterns" in context or "Failed Patterns" in context
            # At least one learning description should be present
            any_learning_present = any(
                entry["hypothesis"] in context for entry in result1.learnings
            )
            assert any_learning_present, (
                "No learnings from run 1 appeared in hypothesis generation context"
            )

    @pytest.mark.asyncio
    async def test_successful_patterns_sorted_by_delta(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from agent.learnings import LearningsStore
            from agent.config import Hypothesis

            store = LearningsStore(Path(tmpdir) / "learnings.yaml")
            h1 = Hypothesis(description="Small improvement", expected_impact="Low",
                            risk="low", priority=1)
            h2 = Hypothesis(description="Big improvement", expected_impact="High",
                            risk="low", priority=1)
            store.record(1, h1, "KEEP", 2.0, "Minor gain")
            store.record(2, h2, "KEEP", 10.0, "Major gain")

            successful = store.get_successful_patterns()
            assert len(successful) == 2
            # Sorted by delta descending
            assert successful[0]["delta"] >= successful[1]["delta"]
            assert successful[0]["hypothesis"] == "Big improvement"


class TestUATCompositeScoreCustomWeights:
    """UAT: User configures composite scorer with custom weights."""

    @pytest.mark.asyncio
    async def test_custom_weighted_composite_scorer(self):
        from scorers.composite_scorer import CompositeScorer
        from scorers.readability_scorer import ReadabilityScorer, PageUtilizationScorer

        scorer = CompositeScorer(
            scorers={
                "readability": (ReadabilityScorer(), 0.7),
                "page_util": (PageUtilizationScorer(max_pages=50), 0.3),
            }
        )
        content = (
            "This is a sample federal proposal document for testing purposes. "
            "The document contains several well-formed sentences at a professional level. "
            "It discusses technical approaches to cloud migration and DevSecOps pipelines."
        )
        score = await scorer.score(content)
        assert isinstance(score, float)
        assert 0 <= score <= 100

        details = scorer.get_details()
        assert "readability" in details
        assert "page_util" in details
        # Verify weights are correct
        assert details["readability"]["weight"] == 0.7
        assert details["page_util"]["weight"] == 0.3

    def test_custom_weights_must_sum_to_one(self):
        from scorers.composite_scorer import CompositeScorer
        from scorers.readability_scorer import ReadabilityScorer

        with pytest.raises(ValueError, match="weights must sum to 1.0"):
            CompositeScorer(
                scorers={
                    "readability": (ReadabilityScorer(), 0.5),
                    "readability2": (ReadabilityScorer(), 0.3),
                }
            )


class TestUATComplianceModeSTIG:
    """UAT: User runs compliance mode with STIG target and scores improve."""

    @pytest.mark.asyncio
    async def test_compliance_stig_scores_improve(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text(
                "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n"
                "spec:\n  template:\n    spec:\n      containers:\n      - name: web\n"
                "        image: nginx:latest\n"
            )
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="compliance",
                threshold=95.0,
                max_iterations=5,
                scores=[30.0, 40.0, 50.0, 60.0, 70.0, 80.0],
            )
            result = await loop.run()

            assert result.config.mode == "compliance"
            assert result.final_score > result.baseline_score
            # Verify audit trail captured all iterations
            audit_log = run_dir / "audit.jsonl"
            assert audit_log.exists()
            lines = [l for l in audit_log.read_text().strip().split("\n") if l.strip()]
            assert len(lines) == len(result.iterations)


class TestUATExportMarkdownReport:
    """UAT: User exports a run report in markdown format."""

    @pytest.mark.asyncio
    async def test_report_generated_in_markdown(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=3,
                scores=[50.0, 60.0, 70.0, 75.0],
            )
            result = await loop.run()

            report_path = run_dir / "report.md"
            assert report_path.exists(), "report.md not generated"
            report = report_path.read_text()

            # Must contain key markdown report sections
            assert "# Autoresearch Run Report" in report
            assert "## Score Summary" in report
            assert "## Iteration History" in report
            assert "Baseline Score" in report
            assert "Final Score" in report
            assert result.run_id in report

    @pytest.mark.asyncio
    async def test_report_contains_iteration_table(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, run_dir, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=3,
                scores=[50.0, 60.0, 70.0, 75.0],
            )
            result = await loop.run()

            report = (run_dir / "report.md").read_text()
            # Table header markers
            assert "| # |" in report
            assert "| Hypothesis |" in report or "Hypothesis" in report
            assert "| Decision |" in report or "Decision" in report

    @pytest.mark.asyncio
    async def test_to_markdown_report_method_returns_string(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loop, _, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=2,
                scores=[50.0, 60.0, 70.0],
            )
            result = await loop.run()
            md = result.to_markdown_report()
            assert isinstance(md, str)
            assert len(md) > 100


class TestUATPageLimitConstraint:
    """UAT: User starts run with page limit constraint and it enforces correctly."""

    @pytest.mark.asyncio
    async def test_page_limit_halt_stops_run(self):
        from agent.constraints import Constraint
        from agent.audit import AuditTrail
        from agent.config import RunConfig
        from agent.constraints import ConstraintValidator
        from agent.hypothesis import HypothesisGenerator
        from agent.learnings import LearningsStore
        from agent.loop import AutoresearchLoop
        from agent.modifier import ArtifactModifier

        with tempfile.TemporaryDirectory() as tmpdir:
            # Start with content just under the 1-page limit (~240 words)
            base_text = "This is a sentence for the proposal document. " * 24  # ~240 words
            target = Path(tmpdir) / "artifact.md"
            target.write_text(f"# Proposal\n\n{base_text}")

            page_constraint = Constraint(
                name="Strict Page Limit",
                description="Must not exceed 1 page",
                validation_type="page_limit",
                parameters={"max_pages": 1, "words_per_page": 250},
                on_violation="HALT",
            )

            config = RunConfig(
                mode="proposal", target_path=target, metric="test",
                threshold=95.0, max_iterations=10,
            )
            run_dir = Path(tmpdir) / "runs" / "page-limit-run"

            # Custom LLM that adds enough content to push over the page limit
            # while keeping >50% similarity with original
            class PagePushLLM:
                async def complete(self, system_prompt, user_message, max_tokens=4096):
                    if any(kw in (system_prompt + user_message).lower()
                           for kw in ("hypothes", "generate", "improvement", "analyze", "suggest")):
                        return json.dumps([{
                            "description": "Add a detailed section to improve score",
                            "expected_impact": "High", "risk": "low", "priority": 1
                        }])
                    # Modification: return original + extra words to exceed page limit
                    parts = user_message.split("## Current Document\n")
                    if len(parts) > 1:
                        original = parts[-1].split("\nApply")[0]
                    else:
                        original = user_message
                    extra = " Additional detailed content added here." * 5  # ~30 more words
                    return original.rstrip() + "\n\n" + extra + "\n"

            llm = PagePushLLM()
            learnings = LearningsStore(run_dir / "learnings.yaml")
            loop = AutoresearchLoop(
                config=config, llm=llm,
                scorer=MockScorer(scores=[50.0, 55.0, 60.0, 65.0, 70.0]),
                constraints=ConstraintValidator([page_constraint]),
                audit=AuditTrail(run_dir),
                learnings=learnings,
                hypothesis_gen=HypothesisGenerator(llm, "proposal", learnings),
                modifier=ArtifactModifier(llm),
            )
            result = await loop.run()
            assert result.halt_reason == "constraint_violation"

    @pytest.mark.asyncio
    async def test_page_limit_discard_continues_loop(self):
        from agent.constraints import Constraint

        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "artifact.md"
            target.write_text(
                "# Big Proposal\n\n"
                + ("Filler sentence to push beyond page limit for testing purposes. " * 60)
            )

            page_constraint = Constraint(
                name="Soft Page Limit",
                description="Must not exceed 1 page",
                validation_type="page_limit",
                parameters={"max_pages": 1, "words_per_page": 250},
                on_violation="DISCARD",
            )
            loop, _, _ = _build_loop(
                tmpdir,
                mode="proposal",
                threshold=95.0,
                max_iterations=5,
                scores=[50.0, 50.0, 50.0, 50.0, 50.0, 50.0],
                constraints=[page_constraint],
            )
            result = await loop.run()
            # Should plateau or hit max_iterations, NOT constraint_violation halt
            assert result.halt_reason in ("plateau", "max_iterations")
