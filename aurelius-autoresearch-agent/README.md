# Aurelius Autoresearch Agent

**Autonomous federal compliance and proposal optimization powered by LLM-driven iterative improvement.**

The Aurelius Autoresearch Agent implements the Karpathy autoresearch loop pattern to continuously improve federal deliverables -- proposals, compliance artifacts, and security configurations -- without constant human supervision.

## Quick Start

### Docker (Recommended)

```bash
# Clone and configure
cp .env.example .env
# Edit .env with your API keys

# Start agent + dashboard
docker compose up -d

# Open dashboard
open http://localhost:8501
```

### Local Development

```bash
# Install dependencies
pip install -e ".[dev]"

# Run a proposal optimization
python -m agent run --mode proposal --target ./workspace/proposal.md --metric eval_alignment --threshold 90

# Start the dashboard
python -m agent dashboard
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | LLM backend: `claude`, `openai`, `ollama` | `claude` |
| `LLM_MODEL` | Model identifier | `claude-sonnet-4-20250514` |
| `ANTHROPIC_API_KEY` | Anthropic API key (for Claude) | |
| `OPENAI_API_KEY` | OpenAI API key | |
| `OPENAI_BASE_URL` | Custom base URL (for LeapfrogAI) | |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://localhost:11434` |
| `DASHBOARD_PORT` | Dashboard port | `8501` |

### Config Files

YAML config files in `config/` define presets:

- `default.yaml` - Base configuration
- `compliance.yaml` - NIST/STIG compliance optimization
- `proposal.yaml` - Federal proposal optimization

## Modes

### Compliance Mode

Optimizes security configurations and compliance documents against NIST 800-53, NIST 800-171, STIG, and CMMC frameworks.

```bash
python -m agent run --mode compliance --target ./workspace/deployment.yaml --metric stig_pass_rate --threshold 95
```

### Proposal Mode

Optimizes federal proposal sections against evaluation criteria, improving alignment scores, readability, and discriminator density.

```bash
python -m agent run --mode proposal --target ./workspace/technical-volume.md --metric eval_alignment --threshold 90
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Autoresearch Loop                         │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │Hypothesis│→ │ Modifier  │→ │  Scorer  │→ │ Decision │   │
│  │Generator │  │  Engine   │  │  Engine  │  │KEEP/DISC │   │
│  └────┬─────┘  └──────────┘  └──────────┘  └────┬─────┘   │
│       │                                          │          │
│  ┌────┴─────┐                              ┌────┴─────┐   │
│  │Learnings │                              │  Audit   │   │
│  │  Store   │                              │  Trail   │   │
│  └──────────┘                              └──────────┘   │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │Constraint│  │   LLM    │  │Dashboard │                  │
│  │Validator │  │Abstraction│  │  (SSE)   │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

## Scoring Functions

| Scorer | Description | Mode |
|--------|-------------|------|
| `NistControlCoverageScorer` | NIST 800-53/171 control coverage | Compliance |
| `StigPassRateScorer` | STIG pass rate with severity weighting | Compliance |
| `SprsScorer` | SPRS score (normalized 0-100) | Compliance |
| `PoamReductionScorer` | POA&M open item reduction | Compliance |
| `EvaluationAlignmentScorer` | Eval criteria alignment (FAR 15.305) | Proposal |
| `RequirementsTraceabilityScorer` | PWS/SOW requirements traceability | Proposal |
| `DiscriminatorDensityScorer` | Unique discriminators per section | Proposal |
| `WinThemeScorer` | Win theme presence across sections | Proposal |
| `ReadabilityScorer` | Flesch-Kincaid grade level targeting | Both |
| `PageUtilizationScorer` | Page limit utilization | Proposal |
| `CompositeScorer` | Weighted multi-metric composite | Both |

## Constraints

Built-in constraint sets:

- **FEDERAL_PROPOSAL_CONSTRAINTS**: Page limit, readability range (8-10), no fabrication
- **COMPLIANCE_CONSTRAINTS**: Valid YAML, no fabricated evidence
- **KUBERNETES_CONSTRAINTS**: Valid YAML syntax

## Dashboard

The web dashboard at `http://localhost:8501` provides:

- Real-time score trajectory chart
- Iteration-by-iteration history with KEEP/DISCARD decisions
- Start new runs via web form
- Run history and reports

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/api/runs` | GET | List all runs |
| `/api/runs/{id}` | GET | Get run details |
| `/api/runs/{id}/progress` | GET | SSE progress stream |
| `/api/runs/{id}/report` | GET | Markdown report |
| `/api/runs` | POST | Start new run |
| `/api/runs/{id}` | DELETE | Cancel running loop |

## Using with Ollama (Free Local Inference)

```bash
# Start with local LLM profile
docker compose --profile local-llm up -d

# Pull a model
docker exec aurelius-ollama ollama pull llama3.1

# Configure
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1
```

## Running Tests

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## Integration with Aurelius Ecosystem

- **Lula**: Validate OSCAL compliance artifacts
- **InSpec**: Automated STIG validation
- **BMAD**: Agent persona orchestration
- **Zarf**: Air-gapped deployment packaging
