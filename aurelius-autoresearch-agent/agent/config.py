"""Pydantic configuration models for the autoresearch agent."""

from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, computed_field


class RunConfig(BaseModel):
    """Configuration for an autoresearch run."""
    model_config = {"frozen": True}

    mode: Literal["compliance", "proposal"]
    target_path: Path
    metric: str
    threshold: float = Field(ge=0, le=100)
    max_iterations: int = Field(default=25, ge=1, le=1000)
    constraints: list[str] = Field(default_factory=list)
    scorer_weights: dict[str, float] = Field(default_factory=dict)
    llm_provider: Literal["claude", "openai", "ollama"] = "claude"
    llm_model: str = "claude-sonnet-4-20250514"


class Hypothesis(BaseModel):
    """A hypothesis for improving an artifact."""
    model_config = {"frozen": True}

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    description: str
    expected_impact: str
    risk: str
    priority: int = Field(ge=1)


class IterationResult(BaseModel):
    """Result of a single autoresearch iteration."""
    model_config = {"frozen": True}

    iteration: int
    hypothesis: Hypothesis
    score_before: float
    score_after: float
    delta: float
    decision: Literal["KEEP", "DISCARD"]
    rationale: str
    artifact_hash_before: str
    artifact_hash_after: str
    diff: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    duration_seconds: float


class RunProgress(BaseModel):
    """Mutable progress tracking for a running loop."""

    run_id: str
    current_iteration: int = 0
    current_score: float = 0.0
    baseline_score: float = 0.0
    improvement: float = 0.0
    kept: int = 0
    discarded: int = 0
    status: Literal["RUNNING", "COMPLETED", "HALTED", "CANCELLED"] = "RUNNING"
    halt_reason: Optional[str] = None


class RunResult(BaseModel):
    """Final result of an autoresearch run."""
    model_config = {"frozen": True}

    run_id: str
    config: RunConfig
    baseline_score: float
    final_score: float
    total_improvement: float
    iterations: list[IterationResult]
    learnings: list[dict[str, Any]]
    halt_reason: str
    started_at: datetime
    completed_at: datetime

    @computed_field
    @property
    def improvement_percentage(self) -> float:
        if self.baseline_score == 0:
            return 0.0
        return (self.total_improvement / self.baseline_score) * 100

    def to_markdown_report(self) -> str:
        kept = [i for i in self.iterations if i.decision == "KEEP"]
        discarded = [i for i in self.iterations if i.decision == "DISCARD"]

        lines = [
            f"# Autoresearch Run Report: {self.run_id}",
            "",
            f"**Mode**: {self.config.mode}",
            f"**Target**: {self.config.target_path}",
            f"**Started**: {self.started_at.isoformat()}",
            f"**Completed**: {self.completed_at.isoformat()}",
            f"**Halt Reason**: {self.halt_reason}",
            "",
            "## Score Summary",
            "",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Baseline Score | {self.baseline_score:.2f} |",
            f"| Final Score | {self.final_score:.2f} |",
            f"| Total Improvement | {self.total_improvement:+.2f} |",
            f"| Improvement % | {self.improvement_percentage:+.1f}% |",
            f"| Iterations | {len(self.iterations)} |",
            f"| Kept | {len(kept)} |",
            f"| Discarded | {len(discarded)} |",
            "",
            "## Iteration History",
            "",
            "| # | Hypothesis | Delta | Decision |",
            "|---|-----------|-------|----------|",
        ]
        for it in self.iterations:
            desc = it.hypothesis.description[:60] + "..." if len(it.hypothesis.description) > 60 else it.hypothesis.description
            lines.append(f"| {it.iteration} | {desc} | {it.delta:+.2f} | {it.decision} |")

        if self.learnings:
            lines.extend(["", "## Key Learnings", ""])
            for learning in self.learnings:
                lines.append(f"- **{learning.get('hypothesis', 'N/A')}**: {learning.get('insight', 'N/A')}")

        return "\n".join(lines)
