# Agentic systems engineering review

## Verified architecture

- LangGraph in `app/graph.py` (3,322 lines); 24 agent modules; 26 tool modules; model via Groq (`config.py`: `GROQ_MODEL = "openai/gpt-oss-120b"`, per-agent API keys to spread rate limits).
- `langgraph-checkpoint-postgres` is installed; run and stage results persisted (`AgentPipelineRun`, `AgentStageResult`).
- Safety pattern: LLM output is explanation or proposal; deterministic facts decide status (`production_planning_agent` clamp); approval is hash-bound and revalidated against current state at commit.
- Capability registry (`capabilities/registry.py`) and manufacturing capabilities; `plan_executor.py` executes plans through tools.

## Assessment against the brief's dimensions

| Dimension | State |
|---|---|
| Responsibilities | Mostly clear. Nine agents unaudited for write-path safety |
| State management | Postgres-backed runs/stages; good |
| Tool schemas | Typed functions and Pydantic schemas |
| Tool permissions | Allow-list per agent **not verified or enforced by mechanism** |
| Structured outputs | Schemas per agent in `app/schemas/` |
| Model selection | Single model for all agents; no routing by task difficulty or cost |
| Prompt versioning | **None** |
| Evaluation datasets | **None** (grep = 0) |
| Hallucination controls | Deterministic override on key verdicts; others unverified |
| Failure handling | Bounded HTTP retries; behavior on LLM failure not verified |
| Observability | Trace ids; no token/cost/latency metrics |
| Replayability | Persisted stage results enable replay in principle |
| Cost/latency | Unmeasured; Groq daily token limits already forced multi-key workaround (rate limiting is a live constraint) |
| Deterministic fallbacks | Present for some flows (milestones list deterministic delay explanation); not systematic |
| Security | Prompt-injection controls are structural only |
| Multi-agent coordination | Composition by deterministic orchestration plus read-only verdict writers; sound |

## Agent quality metrics to adopt

Task success rate, factual accuracy against deterministic truth, policy-compliance violations (target 0), action correctness (approved proposal equals ground-truth action), p50/p95 latency, cost per run, STALE-approval rate, human edit rate on proposals.

## Actions

1. Build the eval harness (50+ cases per workflow incl. adversarial/injection cases) and run on every prompt/model change.
2. Record `model`, `prompt_hash`, `tool_allowlist_version` in each run.
3. Add per-agent tool allow-list with a test that fails if an agent imports a write tool it is not entitled to.
4. Re-audit the nine agents; move fulfillment strategy and vendor selection to rules if still LLM-decided.
5. Model routing: small model for classification, larger for explanation, to cut cost; measure first.
