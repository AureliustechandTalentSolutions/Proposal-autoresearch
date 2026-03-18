"""Artifact modification engine for applying hypotheses."""

from __future__ import annotations

import difflib
import logging
from typing import Any

logger = logging.getLogger(__name__)


class ArtifactModifier:
    """Applies hypothesis-driven modifications to artifacts."""

    def __init__(self, llm: Any):
        self.llm = llm

    async def apply_hypothesis(
        self,
        artifact_content: str,
        hypothesis: Any,
        constraints: list[str],
    ) -> tuple[str, str]:
        """Apply a hypothesis to modify an artifact. Returns (modified_content, unified_diff)."""
        constraints_str = "\n".join(f"- {c}" for c in constraints) if constraints else "- None"

        response = await self.llm.complete(
            system_prompt=(
                "You are an expert document editor. Apply the requested change precisely and completely. "
                "Output ONLY the full modified document with no commentary, no markdown code fences, "
                "and no explanations. Preserve all existing content that is not directly related to the change."
            ),
            user_message=(
                f"## Change to Apply\n{hypothesis.description}\n\n"
                f"## Constraints (must not violate)\n{constraints_str}\n\n"
                f"## Current Document\n{artifact_content}\n\n"
                f"Apply ONLY the change described above. Output the complete modified document."
            ),
        )

        modified = response.strip()
        # Strip markdown code fences if present
        if modified.startswith("```"):
            lines = modified.split("\n")
            if len(lines) > 2:
                modified = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

        diff = self.compute_diff(artifact_content, modified)
        return modified, diff

    def compute_diff(self, before: str, after: str) -> str:
        """Compute unified diff between two versions."""
        return "\n".join(
            difflib.unified_diff(
                before.splitlines(),
                after.splitlines(),
                fromfile="before",
                tofile="after",
                lineterm="",
            )
        )

    def validate_modification(
        self, before: str, after: str, hypothesis: Any
    ) -> tuple[bool, str]:
        """Validate that a modification is reasonable."""
        if after == before:
            return False, "No changes were made"
        if not after.strip():
            return False, "Modified artifact is empty"

        # Check change proportion
        before_lines = before.splitlines()
        after_lines = after.splitlines()
        differ = difflib.SequenceMatcher(None, before_lines, after_lines)
        ratio = differ.ratio()

        if ratio < 0.5:
            return False, f"Change too large: only {ratio:.0%} similarity (>50% of content changed)"

        return True, "Modification is valid"
