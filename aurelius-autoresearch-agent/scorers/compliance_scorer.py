"""Compliance scoring for NIST, STIG, SPRS, and POA&M assessments."""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal

from . import Scorer

logger = logging.getLogger(__name__)


class NistControlCoverageScorer(Scorer):
    """Scores documents for NIST 800-53/800-171 control coverage using LLM evaluation."""

    def __init__(self, controls_list: list[str], llm: Any):
        self.controls_list = controls_list
        self.llm = llm
        self._last_details: dict = {}

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return f"NIST control coverage assessment across {len(self.controls_list)} controls"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        if not self.controls_list:
            return 100.0

        # Batch controls to reduce LLM calls (groups of 10)
        batch_size = 10
        results: dict[str, float] = {}

        for i in range(0, len(self.controls_list), batch_size):
            batch = self.controls_list[i:i + batch_size]
            prompt = self._build_evaluation_prompt(artifact_content, batch)

            response = await self.llm.complete(
                system_prompt="You are a NIST compliance assessor. Evaluate each control narrative strictly. Respond ONLY with a JSON object mapping control IDs to status.",
                user_message=prompt,
            )

            batch_results = self._parse_response(response, batch)
            results.update(batch_results)

        # Calculate score
        values = {"SATISFIED": 1.0, "PARTIAL": 0.5, "NOT_SATISFIED": 0.0}
        total = sum(values.get(v, 0.0) for v in results.values())
        score = (total / len(self.controls_list)) * 100

        self._last_details = {"control_results": results, "total_controls": len(self.controls_list)}
        return round(score, 2)

    def _build_evaluation_prompt(self, artifact: str, controls: list[str]) -> str:
        controls_str = "\n".join(f"- {c}" for c in controls)
        return (
            f"Evaluate the following document against these NIST controls:\n\n"
            f"Controls to assess:\n{controls_str}\n\n"
            f"Document:\n{artifact[:8000]}\n\n"
            f'For each control, respond with a JSON object like: {{"AC-1": "SATISFIED", "AC-2": "PARTIAL", "AC-3": "NOT_SATISFIED"}}\n'
            f"Status must be exactly one of: SATISFIED, PARTIAL, NOT_SATISFIED"
        )

    def _parse_response(self, response: str, controls: list[str]) -> dict[str, str]:
        results = {}
        try:
            # Try to extract JSON from response
            json_match = re.search(r'\{[^{}]*\}', response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                for control in controls:
                    status = parsed.get(control, "NOT_SATISFIED")
                    if status in ("SATISFIED", "PARTIAL", "NOT_SATISFIED"):
                        results[control] = status
                    else:
                        results[control] = "NOT_SATISFIED"
        except (json.JSONDecodeError, AttributeError):
            logger.warning("Failed to parse LLM response for NIST evaluation")

        # Fill in missing controls
        for control in controls:
            if control not in results:
                results[control] = "NOT_SATISFIED"
        return results


class StigPassRateScorer(Scorer):
    """STIG compliance pass rate scorer with severity weighting."""

    SEVERITY_WEIGHTS = {"CAT_I": 10, "CAT_II": 5, "CAT_III": 2}

    def __init__(self, llm: Any, stig_items: list[dict] | None = None):
        self.llm = llm
        self.stig_items = stig_items or []
        self._last_details: dict = {}

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return "STIG pass rate with CAT I/II/III severity weighting"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        if not self.stig_items:
            # Use LLM to evaluate general STIG compliance
            return await self._llm_evaluate(artifact_content)

        weighted_passes = 0.0
        weighted_total = 0.0

        for item in self.stig_items:
            severity = item.get("severity", "CAT_III")
            weight = self.SEVERITY_WEIGHTS.get(severity, 2)
            weighted_total += weight

            response = await self.llm.complete(
                system_prompt="You are a STIG compliance assessor. Respond with ONLY 'PASS' or 'FAIL'.",
                user_message=f"STIG Check: {item.get('description', '')}\n\nArtifact:\n{artifact_content[:6000]}\n\nDoes this artifact satisfy the STIG requirement? Respond PASS or FAIL.",
            )
            if "PASS" in response.upper():
                weighted_passes += weight

        score = (weighted_passes / weighted_total * 100) if weighted_total > 0 else 0
        self._last_details = {"weighted_passes": weighted_passes, "weighted_total": weighted_total}
        return round(score, 2)

    async def _llm_evaluate(self, artifact_content: str) -> float:
        response = await self.llm.complete(
            system_prompt="You are a STIG compliance assessor. Score the overall STIG compliance of this artifact on a scale of 0-100.",
            user_message=f"Evaluate STIG compliance:\n\n{artifact_content[:8000]}\n\nProvide a numeric score 0-100 and brief justification. Format: SCORE: XX",
        )
        match = re.search(r'SCORE:\s*(\d+)', response)
        return float(match.group(1)) if match else 50.0


class SprsScorer(Scorer):
    """SPRS (Supplier Performance Risk System) score calculator."""

    def __init__(self, llm: Any):
        self.llm = llm

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return "SPRS score normalized from NIST 800-171 assessment (range -203 to 110)"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        response = await self.llm.complete(
            system_prompt=(
                "You are a CMMC/SPRS assessor. Evaluate this NIST 800-171 implementation. "
                "The SPRS score starts at 110 and deducts security values for each unimplemented practice. "
                "Range is -203 to 110. Respond with ONLY: SPRS_SCORE: <number>"
            ),
            user_message=f"Evaluate SPRS score:\n\n{artifact_content[:8000]}",
        )
        match = re.search(r'SPRS_SCORE:\s*(-?\d+)', response)
        sprs = float(match.group(1)) if match else 0
        # Normalize: (sprs + 203) / 313 * 100
        normalized = max(0, min(100, (sprs + 203) / 313 * 100))
        return round(normalized, 2)


class PoamReductionScorer(Scorer):
    """POA&M reduction scorer with severity weighting."""

    def __init__(self, llm: Any):
        self.llm = llm

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return "POA&M reduction score (fewer open items = higher score)"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        response = await self.llm.complete(
            system_prompt=(
                "You are a compliance assessor reviewing a Plan of Action & Milestones document. "
                "Count the total items and open/unresolved items with severity. "
                "Respond with ONLY: TOTAL: <n> OPEN_HIGH: <n> OPEN_MED: <n> OPEN_LOW: <n>"
            ),
            user_message=f"Evaluate POA&M:\n\n{artifact_content[:8000]}",
        )

        total = int(m.group(1)) if (m := re.search(r'TOTAL:\s*(\d+)', response)) else 10
        open_high = int(m.group(1)) if (m := re.search(r'OPEN_HIGH:\s*(\d+)', response)) else 0
        open_med = int(m.group(1)) if (m := re.search(r'OPEN_MED:\s*(\d+)', response)) else 0
        open_low = int(m.group(1)) if (m := re.search(r'OPEN_LOW:\s*(\d+)', response)) else 0

        weighted_open = open_high * 10 + open_med * 5 + open_low * 2
        weighted_total = total * 10  # Assume worst case for total

        if weighted_total == 0:
            return 100.0
        score = 100 - (weighted_open / weighted_total * 100)
        return round(max(0, min(100, score)), 2)
