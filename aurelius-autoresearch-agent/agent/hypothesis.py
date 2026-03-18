"""Hypothesis generation engine for autoresearch loops."""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

logger = logging.getLogger(__name__)

# Import will work at runtime when all modules exist
# Using string for type hints to avoid circular imports

COMPLIANCE_PATTERNS = """
Compliance Mode Hypothesis Patterns:
- Harden container security context (runAsNonRoot, readOnlyRootFilesystem, drop ALL capabilities)
- Add resource limits and requests for CPU/memory
- Implement network policies for pod-to-pod communication
- Add seccomp/AppArmor profiles
- Enable audit logging
- Implement RBAC with least-privilege principles
- Add pod security standards (restricted profile)
- Configure TLS for all service communication
- Add health checks (liveness, readiness probes)
- Implement secrets management (external secrets, sealed secrets)
"""

PROPOSAL_PATTERNS = """
Proposal Mode Hypothesis Patterns:
- Strengthen discriminators with quantified past performance metrics
- Add Cialdini influence principles (social proof, authority, scarcity)
- Apply SPIN framework (Situation, Problem, Implication, Need-payoff)
- Improve section transitions and narrative flow
- Add specific technical approach details with implementation timelines
- Strengthen management approach with named key personnel qualifications
- Add risk mitigation strategies with contingency plans
- Improve executive summary with clear win themes in first paragraph
- Add proof points: certifications, clearances, contract values, team size
- Reference Shipley review focus: compliance, responsiveness, strengths/weaknesses
"""

PERSONA_PROMPTS = {
    "capture_manager": (
        "You are a federal capture manager. Focus on competitive intelligence, "
        "price-to-win positioning, and teaming strategy. Identify gaps in the proposal's "
        "competitive positioning and suggest improvements that highlight unique value."
    ),
    "solution_architect": (
        "You are a solution architect. Focus on technical approach clarity, "
        "architecture diagrams descriptions, integration points, and scalability. "
        "Suggest specific technical improvements that demonstrate deep understanding."
    ),
    "customer_advocate": (
        "You are the customer's advocate. Read the proposal as if you are the "
        "government evaluator. Identify sections that are vague, miss requirements, "
        "or lack evidence. Suggest improvements that directly address evaluation criteria."
    ),
    "pricing_analyst": (
        "You are a pricing analyst. Focus on value proposition, cost efficiency, "
        "ROI claims, and staffing justification. Suggest improvements that strengthen "
        "the price-technical tradeoff narrative."
    ),
    "devsecops_expert": (
        "You are a DevSecOps expert. Focus on CI/CD pipeline descriptions, "
        "security automation, ATO acceleration, and infrastructure as code. "
        "Suggest specific technical improvements for security and operations sections."
    ),
    "di_champion": (
        "You are a Diversity & Inclusion champion. Focus on SDVOSB advantages, "
        "small business subcontracting plans, mentor-protege relationships, and "
        "workforce diversity. Suggest improvements that strengthen socioeconomic positioning."
    ),
}


class Hypothesis:
    """Represents a hypothesis for improving an artifact."""
    def __init__(self, id: str, description: str, expected_impact: str, risk: str, priority: int):
        self.id = id
        self.description = description
        self.expected_impact = expected_impact
        self.risk = risk
        self.priority = priority


class HypothesisGenerator:
    """Generates improvement hypotheses using LLM analysis."""

    def __init__(self, llm: Any, mode: str, learnings: Any):
        self.llm = llm
        self.mode = mode
        self.learnings = learnings

    async def generate(
        self,
        artifact_content: str,
        current_score: float,
        score_details: dict,
        constraints: list[str],
        num_hypotheses: int = 5,
    ) -> list:
        """Generate ranked hypotheses for artifact improvement."""
        from .config import Hypothesis as HypothesisModel

        learnings_context = self.learnings.get_context_for_hypothesis_generation()
        mode_patterns = COMPLIANCE_PATTERNS if self.mode == "compliance" else PROPOSAL_PATTERNS

        # Truncate artifact if too long
        artifact_summary = artifact_content[:6000]
        if len(artifact_content) > 6000:
            artifact_summary += "\n\n[... artifact truncated for analysis ...]"

        details_str = json.dumps(score_details, indent=2, default=str) if score_details else "No detailed breakdown available"

        prompt = f"""Analyze this artifact and generate exactly {num_hypotheses} specific, actionable hypotheses for improvement.

## Current State
- Score: {current_score:.2f}/100
- Score Breakdown: {details_str}

## Constraints (must not violate)
{chr(10).join(f'- {c}' for c in constraints) if constraints else '- None'}

## Mode-Specific Patterns
{mode_patterns}

## Previous Learnings
{learnings_context}

## Artifact
{artifact_summary}

Generate exactly {num_hypotheses} hypotheses. For each, provide:
1. A specific, actionable description of what to change
2. Expected impact on the score
3. Risk assessment (low/medium/high)
4. Priority ranking (1 = do first)

Do NOT suggest changes that have already been tried and DISCARDED in previous iterations.

Respond in this exact JSON format:
[
  {{"description": "...", "expected_impact": "...", "risk": "low|medium|high", "priority": 1}},
  ...
]"""

        response = await self.llm.complete(
            system_prompt=f"You are an expert {'compliance' if self.mode == 'compliance' else 'proposal'} optimization analyst. Generate precise, actionable improvement hypotheses.",
            user_message=prompt,
        )

        return self._parse_hypotheses(response, num_hypotheses)

    async def generate_with_persona(
        self,
        artifact_content: str,
        current_score: float,
        score_details: dict,
        constraints: list[str],
        persona: str,
        num_hypotheses: int = 5,
    ) -> list:
        """Generate hypotheses from a specific persona perspective."""
        from .config import Hypothesis as HypothesisModel

        persona_prompt = PERSONA_PROMPTS.get(persona, PERSONA_PROMPTS["customer_advocate"])
        learnings_context = self.learnings.get_context_for_hypothesis_generation()

        artifact_summary = artifact_content[:6000]
        details_str = json.dumps(score_details, indent=2, default=str) if score_details else "N/A"

        prompt = f"""As a {persona.replace('_', ' ')}, analyze this artifact and suggest {num_hypotheses} improvements.

## Current Score: {current_score:.2f}/100
## Score Breakdown: {details_str}

## Constraints
{chr(10).join(f'- {c}' for c in constraints) if constraints else '- None'}

## Previous Learnings
{learnings_context}

## Artifact
{artifact_summary}

Respond in JSON format:
[
  {{"description": "...", "expected_impact": "...", "risk": "low|medium|high", "priority": 1}},
  ...
]"""

        response = await self.llm.complete(
            system_prompt=persona_prompt,
            user_message=prompt,
        )

        return self._parse_hypotheses(response, num_hypotheses)

    def _parse_hypotheses(self, response: str, expected_count: int) -> list:
        """Parse LLM response into Hypothesis objects."""
        from .config import Hypothesis as HypothesisModel

        hypotheses = []
        try:
            # Extract JSON array from response
            json_match = re.search(r'\[[\s\S]*\]', response)
            if json_match:
                parsed = json.loads(json_match.group())
                for i, item in enumerate(parsed[:expected_count]):
                    hypotheses.append(HypothesisModel(
                        id=str(uuid.uuid4()),
                        description=item.get("description", "No description"),
                        expected_impact=item.get("expected_impact", "Unknown"),
                        risk=item.get("risk", "medium"),
                        priority=item.get("priority", i + 1),
                    ))
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            logger.warning(f"Failed to parse hypotheses: {e}")

        # Fallback: create a generic hypothesis if parsing failed
        if not hypotheses:
            hypotheses.append(HypothesisModel(
                id=str(uuid.uuid4()),
                description="Improve overall quality and completeness of the artifact",
                expected_impact="Moderate improvement expected",
                risk="low",
                priority=1,
            ))

        return sorted(hypotheses, key=lambda h: h.priority)
