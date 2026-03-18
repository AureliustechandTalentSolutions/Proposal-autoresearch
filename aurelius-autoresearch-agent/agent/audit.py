"""Audit trail system with SHA-256 hashing and complete iteration logging."""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
from datetime import datetime
from pathlib import Path

import yaml

from .config import IterationResult, RunProgress, RunResult

logger = logging.getLogger(__name__)


class AuditTrail:
    """Immutable audit trail for autoresearch runs."""

    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / "iterations").mkdir(exist_ok=True)
        self.audit_log_path = self.run_dir / "audit.jsonl"
        logger.info(f"Audit trail initialized at {self.run_dir}")

    def hash_artifact(self, content: str) -> str:
        """Compute SHA-256 hash of artifact content."""
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def log_iteration(self, result: IterationResult) -> None:
        """Log a complete iteration result."""
        # Append to JSONL audit log
        with open(self.audit_log_path, "a") as f:
            f.write(result.model_dump_json() + "\n")

        # Save iteration artifacts
        iter_dir = self.run_dir / "iterations" / str(result.iteration)
        iter_dir.mkdir(parents=True, exist_ok=True)

        (iter_dir / "change.diff").write_text(result.diff)
        (iter_dir / "hypothesis.yaml").write_text(
            yaml.dump(result.hypothesis.model_dump(), default_flow_style=False)
        )
        (iter_dir / "result.yaml").write_text(
            yaml.dump(
                {
                    "iteration": result.iteration,
                    "score_before": result.score_before,
                    "score_after": result.score_after,
                    "delta": result.delta,
                    "decision": result.decision,
                    "rationale": result.rationale,
                    "artifact_hash_before": result.artifact_hash_before,
                    "artifact_hash_after": result.artifact_hash_after,
                    "timestamp": result.timestamp.isoformat(),
                    "duration_seconds": result.duration_seconds,
                },
                default_flow_style=False,
            )
        )
        logger.info(f"Iteration {result.iteration} logged: {result.decision} (delta={result.delta:+.2f})")

    def save_artifact_snapshot(self, iteration: int, content: str) -> None:
        """Save artifact snapshot for an iteration."""
        iter_dir = self.run_dir / "iterations" / str(iteration)
        iter_dir.mkdir(parents=True, exist_ok=True)
        (iter_dir / "artifact").write_text(content)

    def log_baseline(self, artifact_content: str, score: float) -> None:
        """Log the baseline artifact and score."""
        (self.run_dir / "original").write_text(artifact_content)
        (self.run_dir / "baseline.yaml").write_text(
            yaml.dump(
                {
                    "score": score,
                    "hash": self.hash_artifact(artifact_content),
                    "timestamp": datetime.utcnow().isoformat(),
                    "word_count": len(artifact_content.split()),
                },
                default_flow_style=False,
            )
        )
        logger.info(f"Baseline logged: score={score:.2f}")

    def update_progress(self, progress: RunProgress) -> None:
        """Write current progress (overwritten each iteration)."""
        (self.run_dir / "progress.yaml").write_text(
            yaml.dump(progress.model_dump(), default_flow_style=False)
        )

    def finalize(self, result: RunResult, final_artifact: str) -> None:
        """Write final results and reports."""
        (self.run_dir / "result.json").write_text(result.model_dump_json(indent=2))
        (self.run_dir / "report.md").write_text(result.to_markdown_report())

        # Write original vs final diff
        original = (self.run_dir / "original").read_text() if (self.run_dir / "original").exists() else ""
        diff = "\n".join(
            difflib.unified_diff(
                original.splitlines(),
                final_artifact.splitlines(),
                fromfile="original",
                tofile="final",
                lineterm="",
            )
        )
        (self.run_dir / "original_vs_final.diff").write_text(diff)
        (self.run_dir / "final").write_text(final_artifact)
        logger.info(f"Run finalized: {result.run_id}")
