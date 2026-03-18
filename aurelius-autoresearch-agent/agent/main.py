"""CLI entry point for the autoresearch agent."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import yaml


def main():
    parser = argparse.ArgumentParser(
        prog="aurelius-autoresearch",
        description="Aurelius Autoresearch Agent - Autonomous federal compliance and proposal optimization",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # Run command
    run_parser = subparsers.add_parser("run", help="Start an autoresearch optimization loop")
    run_parser.add_argument("--config", type=str, help="Path to YAML config file")
    run_parser.add_argument("--mode", choices=["compliance", "proposal"], help="Optimization mode")
    run_parser.add_argument("--target", type=str, help="Path to target artifact")
    run_parser.add_argument("--metric", type=str, help="Metric to optimize")
    run_parser.add_argument("--threshold", type=float, default=90.0, help="Score threshold to reach")
    run_parser.add_argument("--max-iterations", type=int, default=25, help="Maximum iterations")
    run_parser.add_argument("--llm-provider", choices=["claude", "openai", "ollama"], default="claude")
    run_parser.add_argument("--llm-model", type=str, default="claude-sonnet-4-20250514")
    run_parser.add_argument("--eval-criteria", type=str, help="Path to evaluation criteria YAML")
    run_parser.add_argument("--daemon", action="store_true", help="Run in background")

    # Status command
    status_parser = subparsers.add_parser("status", help="Check run status")
    status_parser.add_argument("--run-id", required=True, help="Run ID to check")

    # Report command
    report_parser = subparsers.add_parser("report", help="View run report")
    report_parser.add_argument("--run-id", required=True, help="Run ID")

    # Dashboard command
    subparsers.add_parser("dashboard", help="Start the web dashboard")

    args = parser.parse_args()

    if args.command == "run":
        asyncio.run(cmd_run(args))
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "report":
        cmd_report(args)
    elif args.command == "dashboard":
        cmd_dashboard()
    else:
        parser.print_help()


async def cmd_run(args):
    """Execute an autoresearch run."""
    from dotenv import load_dotenv
    load_dotenv()

    from .config import RunConfig
    from .llm import get_llm
    from .audit import AuditTrail
    from .constraints import ConstraintValidator, FEDERAL_PROPOSAL_CONSTRAINTS, COMPLIANCE_CONSTRAINTS
    from .learnings import LearningsStore
    from .hypothesis import HypothesisGenerator
    from .modifier import ArtifactModifier
    from .loop import AutoresearchLoop
    from scorers.readability_scorer import ReadabilityScorer

    # Build config from file or CLI args
    if args.config:
        with open(args.config) as f:
            config_data = yaml.safe_load(f)
        if args.target:
            config_data["target_path"] = args.target
        config = RunConfig(**config_data)
    else:
        if not args.mode or not args.target or not args.metric:
            print("Error: --mode, --target, and --metric required when not using --config")
            sys.exit(1)
        config = RunConfig(
            mode=args.mode,
            target_path=Path(args.target),
            metric=args.metric,
            threshold=args.threshold,
            max_iterations=args.max_iterations,
            llm_provider=args.llm_provider,
            llm_model=args.llm_model,
        )

    # Initialize components
    llm = get_llm(config.llm_provider, config.llm_model)

    import uuid
    run_id = str(uuid.uuid4())[:8]
    runs_dir = Path("runs")
    run_dir = runs_dir / run_id

    audit = AuditTrail(run_dir)
    learnings = LearningsStore(run_dir / "learnings.yaml")

    if config.mode == "compliance":
        constraint_set = COMPLIANCE_CONSTRAINTS
    else:
        constraint_set = FEDERAL_PROPOSAL_CONSTRAINTS
    constraints = ConstraintValidator(constraint_set)

    scorer = ReadabilityScorer()
    hypothesis_gen = HypothesisGenerator(llm, config.mode, learnings)
    modifier = ArtifactModifier(llm)

    loop = AutoresearchLoop(
        config=config, llm=llm, scorer=scorer, constraints=constraints,
        audit=audit, learnings=learnings, hypothesis_gen=hypothesis_gen, modifier=modifier,
    )
    loop.run_id = run_id  # Sync run_id so CLI status/report can find the run

    print(f"Starting autoresearch loop.")
    print(f"  Run ID: {loop.run_id}")
    print(f"  Mode: {config.mode}")
    print(f"  Target: {config.target_path}")
    print(f"  Threshold: {config.threshold}")
    print(f"  Max iterations: {config.max_iterations}")
    print()

    result = await loop.run()

    print(f"\nRun complete!")
    print(f"  Baseline: {result.baseline_score:.2f}")
    print(f"  Final: {result.final_score:.2f}")
    print(f"  Improvement: {result.total_improvement:+.2f} ({result.improvement_percentage:+.1f}%)")
    print(f"  Halt reason: {result.halt_reason}")
    print(f"  Report: {run_dir / 'report.md'}")


def cmd_status(args):
    """Check run status."""
    run_dir = Path("runs") / args.run_id
    progress_path = run_dir / "progress.yaml"

    if not progress_path.exists():
        print(f"Run {args.run_id} not found")
        sys.exit(1)

    with open(progress_path) as f:
        progress = yaml.safe_load(f)

    print(f"Run: {args.run_id}")
    print(f"  Status: {progress.get('status', 'unknown')}")
    print(f"  Iteration: {progress.get('current_iteration', 0)}")
    print(f"  Score: {progress.get('current_score', 0):.2f}")
    print(f"  Baseline: {progress.get('baseline_score', 0):.2f}")
    print(f"  Improvement: {progress.get('improvement', 0):+.2f}")


def cmd_report(args):
    """View run report."""
    report_path = Path("runs") / args.run_id / "report.md"
    if not report_path.exists():
        print(f"Report not found for run {args.run_id}")
        sys.exit(1)
    print(report_path.read_text())


def cmd_dashboard():
    """Start the web dashboard."""
    from dashboard.app import start_dashboard
    start_dashboard()


if __name__ == "__main__":
    main()
