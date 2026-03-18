"""Core autoresearch loop engine."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .audit import AuditTrail
from .config import Hypothesis, IterationResult, RunConfig, RunProgress, RunResult
from .constraints import ConstraintValidator
from .hypothesis import HypothesisGenerator
from .learnings import LearningsStore
from .modifier import ArtifactModifier

logger = logging.getLogger(__name__)

PERSONAS = [
    "capture_manager",
    "solution_architect",
    "customer_advocate",
    "devsecops_expert",
    "di_champion",
]


class AutoresearchLoop:
    """Core autoresearch optimization loop."""

    def __init__(
        self,
        config: RunConfig,
        llm: Any,
        scorer: Any,
        constraints: ConstraintValidator,
        audit: AuditTrail,
        learnings: LearningsStore,
        hypothesis_gen: HypothesisGenerator,
        modifier: ArtifactModifier,
    ):
        self.config = config
        self.llm = llm
        self.scorer = scorer
        self.constraints = constraints
        self.audit = audit
        self.learnings = learnings
        self.hypothesis_gen = hypothesis_gen
        self.modifier = modifier
        self.run_id = str(uuid.uuid4())[:8]
        self._cancel_event = asyncio.Event()
        self._running = False
        self._progress = RunProgress(run_id=self.run_id)

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def progress(self) -> RunProgress:
        return self._progress

    async def cancel(self) -> None:
        """Signal the loop to cancel."""
        self._cancel_event.set()
        logger.info(f"Cancellation requested for run {self.run_id}")

    async def run(self) -> RunResult:
        """Execute the full autoresearch loop."""
        self._running = True
        started_at = datetime.utcnow()
        iterations: list[IterationResult] = []
        halt_reason = "max_iterations"
        no_improvement_streak = 0

        try:
            # 1. Read target artifact
            artifact_content = self.config.target_path.read_text()
            current_artifact = artifact_content

            # 2. Score baseline
            baseline_score = await self.scorer.score(current_artifact)
            current_score = baseline_score
            score_details = getattr(self.scorer, '_last_details', {})

            self.audit.log_baseline(current_artifact, baseline_score)
            logger.info(f"Baseline score: {baseline_score:.2f}")

            # Initialize progress
            self._progress = RunProgress(
                run_id=self.run_id,
                current_iteration=0,
                current_score=current_score,
                baseline_score=baseline_score,
                improvement=0.0,
                kept=0,
                discarded=0,
                status="RUNNING",
            )
            self.audit.update_progress(self._progress)

            # 3. Main loop
            for iteration in range(1, self.config.max_iterations + 1):
                if self._cancel_event.is_set():
                    halt_reason = "user_interrupt"
                    break

                iter_start = time.time()
                logger.info(f"--- Iteration {iteration}/{self.config.max_iterations} ---")

                # Generate hypotheses (rotate persona every 5 iterations in proposal mode)
                if self.config.mode == "proposal" and iteration % 5 == 0:
                    persona_idx = (iteration // 5 - 1) % len(PERSONAS)
                    persona = PERSONAS[persona_idx]
                    logger.info(f"Using persona: {persona}")
                    hypotheses = await self.hypothesis_gen.generate_with_persona(
                        current_artifact, current_score, score_details,
                        self.config.constraints, persona,
                    )
                else:
                    hypotheses = await self.hypothesis_gen.generate(
                        current_artifact, current_score, score_details,
                        self.config.constraints,
                    )

                if not hypotheses:
                    logger.warning("No hypotheses generated, skipping iteration")
                    continue

                # Take top hypothesis
                top_hypothesis = hypotheses[0]
                logger.info(f"Testing: {top_hypothesis.description[:80]}...")

                # Apply modification
                modified, diff = await self.modifier.apply_hypothesis(
                    current_artifact, top_hypothesis, self.config.constraints,
                )

                # Validate modification
                is_valid, validation_msg = self.modifier.validate_modification(
                    current_artifact, modified, top_hypothesis,
                )

                artifact_hash_before = self.audit.hash_artifact(current_artifact)
                artifact_hash_after = self.audit.hash_artifact(modified)

                if not is_valid:
                    # Invalid modification, discard
                    decision = "DISCARD"
                    rationale = f"Invalid modification: {validation_msg}"
                    new_score = current_score
                    delta = 0.0
                else:
                    # Validate constraints
                    constraints_ok, violations = self.constraints.validate(modified)

                    if not constraints_ok:
                        if self.constraints.has_halt_violation(violations):
                            halt_reason = "constraint_violation"
                            decision = "DISCARD"
                            rationale = f"HALT constraint violated: {'; '.join(violations)}"
                            new_score = current_score
                            delta = 0.0
                            # Log and break
                            iter_result = IterationResult(
                                iteration=iteration,
                                hypothesis=top_hypothesis,
                                score_before=current_score,
                                score_after=current_score,
                                delta=0.0,
                                decision="DISCARD",
                                rationale=rationale,
                                artifact_hash_before=artifact_hash_before,
                                artifact_hash_after=artifact_hash_after,
                                diff=diff,
                                duration_seconds=time.time() - iter_start,
                            )
                            iterations.append(iter_result)
                            self.audit.log_iteration(iter_result)
                            break
                        decision = "DISCARD"
                        rationale = f"Constraint violations: {'; '.join(violations)}"
                        new_score = current_score
                        delta = 0.0
                    else:
                        # Score modified artifact
                        new_score = await self.scorer.score(modified)
                        score_details = getattr(self.scorer, '_last_details', {})
                        delta = new_score - current_score

                        if delta > 0:
                            decision = "KEEP"
                            rationale = f"Score improved by {delta:+.2f}"
                        else:
                            decision = "DISCARD"
                            rationale = f"Score did not improve (delta={delta:+.2f})"

                # Record iteration
                iter_result = IterationResult(
                    iteration=iteration,
                    hypothesis=top_hypothesis,
                    score_before=current_score,
                    score_after=new_score if decision == "KEEP" else current_score,
                    delta=delta if decision == "KEEP" else 0.0,
                    decision=decision,
                    rationale=rationale,
                    artifact_hash_before=artifact_hash_before,
                    artifact_hash_after=artifact_hash_after,
                    diff=diff,
                    duration_seconds=time.time() - iter_start,
                )
                iterations.append(iter_result)
                self.audit.log_iteration(iter_result)
                self.audit.save_artifact_snapshot(iteration, modified if decision == "KEEP" else current_artifact)

                # Record learning
                insight = rationale
                self.learnings.record(iteration, top_hypothesis, decision, delta, insight)

                # Update state if KEEP
                if decision == "KEEP":
                    current_artifact = modified
                    current_score = new_score
                    no_improvement_streak = 0
                else:
                    no_improvement_streak += 1

                # Update progress
                self._progress = RunProgress(
                    run_id=self.run_id,
                    current_iteration=iteration,
                    current_score=current_score,
                    baseline_score=baseline_score,
                    improvement=current_score - baseline_score,
                    kept=sum(1 for i in iterations if i.decision == "KEEP"),
                    discarded=sum(1 for i in iterations if i.decision == "DISCARD"),
                    status="RUNNING",
                )
                self.audit.update_progress(self._progress)

                logger.info(f"  {decision}: score {current_score:.2f} (delta={delta:+.2f})")

                # Check halt conditions
                if current_score >= self.config.threshold:
                    halt_reason = "threshold"
                    logger.info(f"Threshold {self.config.threshold} reached!")
                    break

                if no_improvement_streak >= 3:
                    halt_reason = "plateau"
                    logger.info("Plateau detected (3 consecutive no-improvement iterations)")
                    break

            # 4. Finalize
            completed_at = datetime.utcnow()
            result = RunResult(
                run_id=self.run_id,
                config=self.config,
                baseline_score=baseline_score,
                final_score=current_score,
                total_improvement=current_score - baseline_score,
                iterations=iterations,
                learnings=self.learnings.entries,
                halt_reason=halt_reason,
                started_at=started_at,
                completed_at=completed_at,
            )

            self.audit.finalize(result, current_artifact)

            # Update final progress
            self._progress = RunProgress(
                run_id=self.run_id,
                current_iteration=len(iterations),
                current_score=current_score,
                baseline_score=baseline_score,
                improvement=current_score - baseline_score,
                kept=sum(1 for i in iterations if i.decision == "KEEP"),
                discarded=sum(1 for i in iterations if i.decision == "DISCARD"),
                status="COMPLETED" if halt_reason != "user_interrupt" else "CANCELLED",
                halt_reason=halt_reason,
            )
            self.audit.update_progress(self._progress)

            logger.info(f"Run complete: {baseline_score:.2f} -> {current_score:.2f} ({halt_reason})")
            return result

        except Exception as e:
            logger.exception(f"Run failed: {e}")
            self._progress.status = "HALTED"
            self._progress.halt_reason = str(e)
            self.audit.update_progress(self._progress)
            raise
        finally:
            self._running = False
