"""Proposal evaluation scoring for federal proposals."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal

from . import Scorer

logger = logging.getLogger(__name__)


class EvaluationAlignmentScorer(Scorer):
    """Scores proposal alignment with evaluation criteria."""

    RATINGS = {"OUTSTANDING": 5, "GOOD": 4, "ACCEPTABLE": 3, "MARGINAL": 2, "UNACCEPTABLE": 1}

    def __init__(self, evaluation_criteria: list[dict], llm: Any):
        self.evaluation_criteria = evaluation_criteria
        self.llm = llm
        self._last_details: dict = {}

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return f"Evaluation criteria alignment across {len(self.evaluation_criteria)} factors"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        criteria_results = []

        for criterion in self.evaluation_criteria:
            factor = criterion.get("factor", "Unknown")
            subfactor = criterion.get("subfactor", "")
            weight = criterion.get("weight", 1.0)
            description = criterion.get("description", "")

            response = await self.llm.complete(
                system_prompt=(
                    "You are a federal proposal evaluation expert. Rate this proposal section against "
                    "the evaluation criterion using EXACTLY one of: OUTSTANDING, GOOD, ACCEPTABLE, MARGINAL, UNACCEPTABLE.\n\n"
                    "Rating definitions:\n"
                    "- OUTSTANDING (5): Exceeds requirements, innovative approach, quantified evidence, clear discriminators\n"
                    "- GOOD (4): Fully meets requirements, specific evidence provided\n"
                    "- ACCEPTABLE (3): Meets minimum requirements, general evidence\n"
                    "- MARGINAL (2): Partially addresses, vague or incomplete\n"
                    "- UNACCEPTABLE (1): Does not address the requirement\n\n"
                    "Respond with: RATING: <rating>\nJUSTIFICATION: <brief explanation>"
                ),
                user_message=(
                    f"Evaluation Criterion:\n"
                    f"Factor: {factor}\n"
                    f"Subfactor: {subfactor}\n"
                    f"Description: {description}\n\n"
                    f"Proposal Section:\n{artifact_content[:6000]}"
                ),
            )

            rating_str = "ACCEPTABLE"
            match = re.search(r'RATING:\s*(OUTSTANDING|GOOD|ACCEPTABLE|MARGINAL|UNACCEPTABLE)', response, re.IGNORECASE)
            if match:
                rating_str = match.group(1).upper()

            rating_value = self.RATINGS.get(rating_str, 3)
            criteria_results.append({
                "factor": factor,
                "subfactor": subfactor,
                "weight": weight,
                "rating": rating_str,
                "rating_value": rating_value,
            })

        # Weighted score calculation
        weighted_sum = sum(r["rating_value"] * r["weight"] for r in criteria_results)
        max_possible = sum(5 * r["weight"] for r in criteria_results)
        score = (weighted_sum / max_possible * 100) if max_possible > 0 else 0

        self._last_details = {"criteria_results": criteria_results}
        return round(score, 2)


class RequirementsTraceabilityScorer(Scorer):
    """Scores traceability of requirements in a proposal."""

    def __init__(self, requirements: list[str], llm: Any):
        self.requirements = requirements
        self.llm = llm
        self._last_details: dict = {}

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return f"Requirements traceability across {len(self.requirements)} PWS/SOW requirements"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        if not self.requirements:
            return 100.0

        batch_size = 5
        results: dict[str, float] = {}

        for i in range(0, len(self.requirements), batch_size):
            batch = self.requirements[i:i + batch_size]
            reqs_str = "\n".join(f"{j+1}. {r}" for j, r in enumerate(batch))

            response = await self.llm.complete(
                system_prompt=(
                    "You are a proposal compliance reviewer. For each requirement, assess if the proposal "
                    "EXPLICITLY addresses it (1.0), IMPLICITLY addresses it (0.5), or is MISSING (0.0). "
                    "Respond with ONLY a JSON object mapping requirement numbers to scores."
                ),
                user_message=(
                    f"Requirements:\n{reqs_str}\n\n"
                    f"Proposal:\n{artifact_content[:6000]}\n\n"
                    f'Respond as JSON: {{"1": 1.0, "2": 0.5, ...}}'
                ),
            )

            try:
                json_match = re.search(r'\{[^{}]*\}', response)
                if json_match:
                    parsed = json.loads(json_match.group())
                    for j, req in enumerate(batch):
                        val = parsed.get(str(j + 1), 0.0)
                        results[req] = float(val)
            except (json.JSONDecodeError, ValueError):
                for req in batch:
                    results[req] = 0.0

        score = (sum(results.values()) / len(self.requirements)) * 100
        self._last_details = {"requirement_scores": results}
        return round(score, 2)


class DiscriminatorDensityScorer(Scorer):
    """Scores density of unique discriminators across proposal sections."""

    DEFAULT_DISCRIMINATORS = [
        "SDVOSB", "Service-Disabled Veteran", "MBE", "SDB",
        "past performance", "technical innovation", "veteran",
        "Microsoft partnership", "security clearance", "DevSecOps",
    ]

    def __init__(self, llm: Any, custom_discriminators: list[str] | None = None):
        self.llm = llm
        self.discriminators = custom_discriminators or self.DEFAULT_DISCRIMINATORS

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return "Discriminator density per major section"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        # Split into sections by markdown headers or paragraph breaks
        sections = re.split(r'\n#{1,3}\s+', artifact_content)
        sections = [s.strip() for s in sections if len(s.strip()) > 100]

        if not sections:
            sections = [artifact_content]

        section_scores = []
        for section in sections:
            response = await self.llm.complete(
                system_prompt=(
                    "You are a proposal evaluator. Count unique discriminators in this section. "
                    "Discriminators include: SDVOSB status, past performance examples, technical innovations, "
                    "veteran mission alignment, partnerships, certifications, unique capabilities. "
                    "Respond with ONLY: COUNT: <number>"
                ),
                user_message=f"Section:\n{section[:4000]}",
            )
            match = re.search(r'COUNT:\s*(\d+)', response)
            count = int(match.group(1)) if match else 0

            if count >= 3:
                section_scores.append(100)
            elif count == 2:
                section_scores.append(75)
            elif count == 1:
                section_scores.append(50)
            else:
                section_scores.append(0)

        return round(sum(section_scores) / len(section_scores), 2) if section_scores else 0.0


class WinThemeScorer(Scorer):
    """Scores win theme presence across proposal sections."""

    def __init__(self, win_themes: list[str]):
        self.win_themes = win_themes

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return f"Win theme presence across sections ({len(self.win_themes)} themes)"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        sections = re.split(r'\n#{1,3}\s+', artifact_content)
        sections = [s.strip() for s in sections if len(s.strip()) > 50]

        if not sections:
            sections = [artifact_content]

        if not self.win_themes:
            return 100.0

        sections_with_all = 0
        for section in sections:
            section_lower = section.lower()
            if all(theme.lower() in section_lower for theme in self.win_themes):
                sections_with_all += 1

        score = (sections_with_all / len(sections)) * 100
        return round(score, 2)
