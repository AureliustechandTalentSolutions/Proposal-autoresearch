"""Composite scorer that combines multiple scorers with weights."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from . import Scorer
from .compliance_scorer import NistControlCoverageScorer, PoamReductionScorer, SprsScorer, StigPassRateScorer
from .proposal_scorer import DiscriminatorDensityScorer, EvaluationAlignmentScorer, RequirementsTraceabilityScorer, WinThemeScorer
from .readability_scorer import PageUtilizationScorer, ReadabilityScorer


class CompositeScorer(Scorer):
    """Weighted composite of multiple scorers."""

    def __init__(self, scorers: dict[str, tuple[Scorer, float]]):
        total_weight = sum(w for _, w in scorers.values())
        if abs(total_weight - 1.0) > 0.01:
            raise ValueError(f"Scorer weights must sum to 1.0, got {total_weight}")
        self._scorers = scorers
        self._last_details: dict = {}

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        components = ", ".join(f"{name}({w:.0%})" for name, (_, w) in self._scorers.items())
        return f"Composite: {components}"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        # Run all scorers in parallel
        async def score_one(name: str, scorer: Scorer, weight: float) -> tuple[str, float, float]:
            s = await scorer.score(artifact_content, context)
            return name, s, weight

        tasks = [score_one(name, scorer, weight) for name, (scorer, weight) in self._scorers.items()]
        results = await asyncio.gather(*tasks)

        weighted_sum = 0.0
        details: dict[str, Any] = {}
        for name, sub_score, weight in results:
            weighted_sum += sub_score * weight
            details[name] = {"score": sub_score, "weight": weight, "weighted": sub_score * weight}

        self._last_details = details
        return round(weighted_sum, 2)

    def get_details(self) -> dict:
        return self._last_details

    @classmethod
    def federal_compliance(cls, llm: Any, controls_list: list[str]) -> CompositeScorer:
        return cls(
            scorers={
                "nist_coverage": (NistControlCoverageScorer(controls_list, llm), 0.40),
                "stig_pass": (StigPassRateScorer(llm), 0.30),
                "poam_reduction": (PoamReductionScorer(llm), 0.20),
                "sprs_normalized": (SprsScorer(llm), 0.10),
            }
        )

    @classmethod
    def federal_proposal(
        cls,
        llm: Any,
        eval_criteria: list[dict],
        requirements: list[str],
        win_themes: list[str],
        max_pages: int = 20,
    ) -> CompositeScorer:
        return cls(
            scorers={
                "eval_alignment": (EvaluationAlignmentScorer(eval_criteria, llm), 0.35),
                "traceability": (RequirementsTraceabilityScorer(requirements, llm), 0.20),
                "readability": (ReadabilityScorer(), 0.15),
                "discriminators": (DiscriminatorDensityScorer(llm), 0.15),
                "win_themes": (WinThemeScorer(win_themes), 0.10),
                "page_utilization": (PageUtilizationScorer(max_pages), 0.05),
            }
        )
