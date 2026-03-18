"""Tests for hypothesis generation."""

import pytest
import json


class MockLLM:
    """Mock LLM that returns structured hypothesis JSON."""

    def __init__(self, response=None):
        self._response = response

    async def complete(self, system_prompt: str, user_message: str, max_tokens: int = 4096) -> str:
        if self._response:
            return self._response
        return json.dumps([
            {"description": "Add security context", "expected_impact": "High", "risk": "low", "priority": 1},
            {"description": "Enable audit logging", "expected_impact": "Medium", "risk": "medium", "priority": 2},
            {"description": "Add resource limits", "expected_impact": "Low", "risk": "low", "priority": 3},
        ])


class MockLearnings:
    def get_context_for_hypothesis_generation(self, max_entries=10):
        return "No previous learnings."

    def get_failed_patterns(self):
        return []


@pytest.mark.asyncio
async def test_generate_hypotheses():
    from agent.hypothesis import HypothesisGenerator
    gen = HypothesisGenerator(llm=MockLLM(), mode="compliance", learnings=MockLearnings())
    hypotheses = await gen.generate(
        artifact_content="apiVersion: apps/v1\nkind: Deployment",
        current_score=60.0,
        score_details={},
        constraints=[],
        num_hypotheses=3,
    )
    assert len(hypotheses) == 3
    assert hypotheses[0].priority <= hypotheses[1].priority


@pytest.mark.asyncio
async def test_generate_with_persona():
    from agent.hypothesis import HypothesisGenerator
    gen = HypothesisGenerator(llm=MockLLM(), mode="proposal", learnings=MockLearnings())
    hypotheses = await gen.generate_with_persona(
        artifact_content="Technical Approach section...",
        current_score=70.0,
        score_details={},
        constraints=[],
        persona="solution_architect",
    )
    assert len(hypotheses) > 0


@pytest.mark.asyncio
async def test_parse_fallback_on_invalid_json():
    from agent.hypothesis import HypothesisGenerator
    llm = MockLLM(response="This is not valid JSON")
    gen = HypothesisGenerator(llm=llm, mode="compliance", learnings=MockLearnings())
    hypotheses = await gen.generate(
        artifact_content="test content",
        current_score=50.0,
        score_details={},
        constraints=[],
    )
    # Should return fallback hypothesis
    assert len(hypotheses) >= 1


@pytest.mark.asyncio
async def test_learnings_injected():
    from agent.hypothesis import HypothesisGenerator

    class CaptureLLM:
        captured_prompt = ""
        async def complete(self, system_prompt, user_message, max_tokens=4096):
            CaptureLLM.captured_prompt = user_message
            return json.dumps([{"description": "Test", "expected_impact": "Low", "risk": "low", "priority": 1}])

    class LearningsWithData:
        def get_context_for_hypothesis_generation(self, max_entries=10):
            return "## Successful Patterns\n- [+5.0] Added security context: Works great"
        def get_failed_patterns(self):
            return [{"hypothesis": "Bad idea", "delta": -2.0}]

    gen = HypothesisGenerator(llm=CaptureLLM(), mode="compliance", learnings=LearningsWithData())
    await gen.generate("content", 50.0, {}, [])
    assert "Successful Patterns" in CaptureLLM.captured_prompt
