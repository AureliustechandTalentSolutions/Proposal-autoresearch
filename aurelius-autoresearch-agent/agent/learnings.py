"""Compounding knowledge base for autoresearch iterations."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

import yaml

from .config import Hypothesis

logger = logging.getLogger(__name__)


class LearningsStore:
    """Persisted knowledge base that compounds across iterations."""

    def __init__(self, store_path: Path):
        self.store_path = store_path
        self.entries: list[dict] = []
        if self.store_path.exists():
            data = yaml.safe_load(self.store_path.read_text())
            if data:
                self.entries = data
            logger.info(f"Loaded {len(self.entries)} existing learnings")

    def _save(self) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self.store_path.write_text(yaml.dump(self.entries, default_flow_style=False))

    def record(
        self,
        iteration: int,
        hypothesis: Hypothesis,
        outcome: Literal["KEEP", "DISCARD"],
        delta: float,
        insight: str,
    ) -> None:
        """Record a learning from an iteration."""
        entry = {
            "iteration": iteration,
            "hypothesis": hypothesis.description,
            "outcome": outcome,
            "delta": round(delta, 4),
            "insight": insight,
            "reusable": outcome == "KEEP" and delta > 0,
        }
        self.entries.append(entry)
        self._save()
        logger.info(f"Learning recorded: {outcome} (delta={delta:+.2f})")

    def get_successful_patterns(self) -> list[dict]:
        """Returns KEEP outcomes sorted by delta (highest first)."""
        return sorted(
            [e for e in self.entries if e["outcome"] == "KEEP"],
            key=lambda e: e["delta"],
            reverse=True,
        )

    def get_failed_patterns(self) -> list[dict]:
        """Returns DISCARD outcomes."""
        return [e for e in self.entries if e["outcome"] == "DISCARD"]

    def get_context_for_hypothesis_generation(self, max_entries: int = 10) -> str:
        """Format learnings as prompt context for hypothesis generation."""
        successful = self.get_successful_patterns()[:max_entries]
        failed = self.get_failed_patterns()[-max_entries:]

        lines = []
        if successful:
            lines.append("## Successful Patterns (from previous iterations)")
            for s in successful:
                lines.append(f"- [+{s['delta']:.2f}] {s['hypothesis']}: {s['insight']}")

        if failed:
            lines.append("\n## Failed Patterns (DO NOT repeat these)")
            for f in failed:
                lines.append(f"- [{f['delta']:+.2f}] {f['hypothesis']}: {f['insight']}")

        return "\n".join(lines) if lines else "No previous learnings available."

    def merge_from_previous_run(self, previous_run_dir: Path) -> None:
        """Import reusable learnings from a previous run."""
        prev_path = previous_run_dir / "learnings.yaml"
        if not prev_path.exists():
            logger.warning(f"No learnings found at {prev_path}")
            return
        prev_data = yaml.safe_load(prev_path.read_text())
        if not prev_data:
            return
        reusable = [e for e in prev_data if e.get("reusable")]
        self.entries.extend(reusable)
        self._save()
        logger.info(f"Merged {len(reusable)} reusable learnings from {previous_run_dir}")
