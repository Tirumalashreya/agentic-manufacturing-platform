# Challenge: Groq gpt-oss-120b flaky structured output

## What happened

While testing the Process Decision Agent (`app/agents/process_agent.py`) against
a real `GROQ_API_KEY`, `pytest app/tests/test_process.py` failed intermittently
— roughly 1 in 4 calls — with:

```
groq.BadRequestError: Error code: 400 - {'error': {'message': "Tool call
validation failed: tool call validation failed: attempted to call tool 'json'
which was not in request.tools", 'type': 'invalid_request_error',
'code': 'tool_use_failed', 'failed_generation': '{"name": "json",
"arguments": {\n  "entry_type": "DIRECT_SALES",\n  "process":
"NEW_SALES_ORDER",\n  "starting_stage": "Sales Order",\n  "reasoning":
"..."\n}}'}}
```

The `failed_generation` field shows the model's reasoning was actually
correct (right `entry_type`, right `process`) — the content was fine. The
failure is purely mechanical: `with_structured_output(ProcessResult)`
registers one real tool (matching the `ProcessResult` schema) via Groq's
tool-calling API, but the model sometimes decides to call a tool literally
named `"json"` instead of that real tool. The Groq API rejects the request
outright because `"json"` isn't a tool it was given, and `langchain_groq`
does not retry — it just raises.

Confirmed this was a model/provider quirk, not a bug in our schema or
prompt, by running `test_intent.py` (same model, same
`with_structured_output` pattern, simpler schema — one `Literal` field
instead of two) — it passed every time. `ProcessResult`'s larger schema (two
`Literal` enums with many options, plus free-text `starting_stage`) appears
to trigger the flake more often than `IntentResult`'s smaller one, but it's
the same root cause and could in principle hit any agent on this model.

## The fix

Wrap the model call in a narrow `tenacity` retry that catches only this
specific error (`BadRequestError` with `code: tool_use_failed`) and retries
up to 5 attempts — not a blanket retry-on-any-exception, so a genuinely bad
request (bad API key, real schema mismatch) still fails fast instead of
silently retrying 5 times.

### Before

```python
def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=os.environ["GROQ_API_KEY"],
    ).with_structured_output(ProcessResult)


async def process_agent(...) -> ProcessResult:
    ...
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ProcessResult = await model.ainvoke(messages)
    return result
```

### After

```python
from groq import BadRequestError
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=os.environ["GROQ_API_KEY"],
    ).with_structured_output(ProcessResult)


def _is_malformed_tool_call(err: BaseException) -> bool:
    # Groq's gpt-oss models occasionally emit a bogus "json" tool call
    # instead of the one real tool we registered — a known provider-side
    # flake, not a real bad request. Retry only that specific case.
    return isinstance(err, BadRequestError) and "tool_use_failed" in str(err)


@retry(
    retry=retry_if_exception(_is_malformed_tool_call),
    stop=stop_after_attempt(5),
    wait=wait_fixed(1),
    reraise=True,
)
async def _invoke(model, messages) -> ProcessResult:
    return await model.ainvoke(messages)


async def process_agent(...) -> ProcessResult:
    ...
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ProcessResult = await _invoke(model, messages)
    return result
```

## Result

Ran `test_process.py` 6 consecutive times after the fix — 6/6 clean passes
(previously failing roughly 1 in 4 runs before the fix, including one run
that still failed with `stop_after_attempt(3)`, which is why the budget was
raised to 5).

## Where else this could bite

`context_agent.py`'s `_fuzzy_model()` and `intent_agent.py`'s `_model()` use
the identical `with_structured_output(...)` pattern on the same
`GROQ_MODEL`. They haven't shown the flake in testing yet (smaller schemas,
fewer calls made), but the same retry wrapper would be the fix if they ever
do. Not applied there speculatively — per feedback from this session, the
retry wrapper only gets added to an agent once it has actually been
observed failing this way, not by pattern-matching a sibling agent using
the same model.

**Update:** confirmed a second time. `fulfillment_agent.py` hit the same
`tool_use_failed` error live during `test_entry_router.py::test_create_order_routes_to_direct_sales`
— this time the bogus tool name was `"commentary"` instead of `"json"`,
same root cause (`code: tool_use_failed`). The identical retry wrapper was
added there once observed, following the rule above. `quotation_agent.py`
had the wrapper added speculatively at one point and was corrected to
remove it, precisely because no failure had actually been seen there —
that correction is what established this rule in the first place.

**Update 2:** confirmed a third time. `billing_agent.py` hit the same
`tool_use_failed` error live during `test_billing.py::test_billing_agent_full_delivery`
(bogus tool name `"json"` again). Same fix, added once observed. Three for
three so far on agents that actually got exercised enough — `intent_agent.py`
and `context_agent.py`'s fuzzy model remain the only two without the
wrapper, still because neither has shown the failure yet, not because
they're exempt.

**Update 3:** confirmed a fourth time — and this one closes the loop on
the rule itself. `quotation_agent.py` hit the same `tool_use_failed` error
live during a full test-suite run (`test_graph.py::test_intent_graph`,
bogus tool name `"json"`). This is the exact agent that had the wrapper
added *speculatively* early in the session and then removed on correction
for not having been observed — it's now legitimately back, because the
failure the rule was waiting for actually happened. Four for four on
agents that got enough real traffic; still nothing on `intent_agent.py`/
`context_agent.py`.

**Update 4:** confirmed a fifth time, and a new variant of the same
underlying bug. `service_agent.py` (built same session, Service process
family) hit `code: tool_use_failed` live on its very first test run —
but this time the message was `"Tool choice is required, but model did
not call a tool"`, not a bogus tool name like `"json"`/`"commentary"`.
Same root cause, same fix (`"tool_use_failed" in str(err)` already
catches this variant too, no predicate change needed). Confirms the
flake isn't one specific failure mode — it's Groq's gpt-oss tool-calling
being generally unreliable under `with_structured_output`, in more than
one concrete way.

**Update 5:** confirmed a sixth time. `negotiation_agent.py` hit
`tool_use_failed` (bogus tool name `"json"`) live during a full
test-suite run. Same fix, added once observed. Six for six on agents
that got enough real traffic; `intent_agent.py` and `context_agent.py`'s
fuzzy model remain the only two agents in this codebase without the
wrapper — at this point that's a strong hint every `with_structured_output`
call on this model eventually needs it, but the rule stays: added on
observation, not by extrapolation.

**Update 6:** confirmed a seventh time. `subscription_agent.py` (built
same session, Subscription process family) hit `tool_use_failed` (bogus
tool name `"json"`) live on its own test run. Same fix. Seven for seven
on agents that got real traffic — `intent_agent.py`/`context_agent.py`
remain untouched only because they haven't been observed failing, which
given the pattern above is likely a matter of time, not immunity.

**Update 7:** confirmed an eighth time. `post_sales_agent.py` hit
`tool_use_failed` (bogus tool name `"json"`) live during
`test_post_sales.py::test_post_sales_agent_extracts_return` on a full
test-suite run. Same fix, added once observed. Eight for eight on agents
that got real traffic — `intent_agent.py`/`context_agent.py`'s fuzzy
model are now the only two `with_structured_output` call sites in this
codebase without the wrapper.

**Update 8:** a genuinely new failure *code*, not just a new tool-name
variant of the old one. `billing_agent.py` (which already had the
wrapper from Update 2) hit a live `groq.BadRequestError` with
`code: output_parse_failed` — the model dumped raw chain-of-thought text
("We need to decide payment_terms_days = 30 always...") instead of
calling the tool at all, and Groq's own parser rejected it before it
ever got a chance to be a malformed tool call. The existing predicate
(`"tool_use_failed" in str(err)`) didn't match this code, so the retry
never fired on the first hit. Widened `_is_malformed_tool_call` in
`billing_agent.py` to also match `output_parse_failed` — still a narrow,
named-code check, not a blanket retry-on-any-exception. Not applied
speculatively to the other seven agents' identical wrappers; per the
standing rule, that happens if/when each one is actually observed
hitting this specific code too.

**Update 9:** confirmed a ninth time, on a brand-new agent built this
session. `project_agent.py` (Project workflow) hit `tool_use_failed`
(bogus tool name `"JSON"`, capitalized this time — same underlying
flake, just another arbitrary name) live during a full test-suite run.
It was deliberately built *without* the wrapper at first, per the
standing rule — added only once observed, exactly as it was here.
`intent_agent.py`/`context_agent.py`'s fuzzy model remain the only two
`with_structured_output` call sites in this codebase without it.

**Update 10:** confirmed a tenth time, on another brand-new agent built
this session. `export_agent.py` (Export workflow) hit `tool_use_failed`
(bogus tool name `"json"`) live during a full test-suite run — same
"built without it, added once observed" sequence as `project_agent.py`
just above.

**Update 11:** confirmed an eleventh time. `financial_agent.py` (Financial
workflow, the last new agent built this session) hit `tool_use_failed`
(bogus tool name `"json"`) live on its own test run — same sequence
again. At this point every agent built this session that has actually
been exercised (`project_agent.py`, `export_agent.py`,
`financial_agent.py`) has hit this within its first few live runs;
`consignment_agent.py` (smallest schema, one string field) hasn't yet,
consistent with the pattern that a smaller schema flakes less often, not
that it's exempt.

**Update 12:** confirmed a twelfth time, and the first hit on a
pre-existing (not this-session-built) agent. `procurement_agent.py` hit
`tool_use_failed` (bogus tool name `"json"`) live during a full
test-suite run. Wrapper added once observed, same as every other case —
this one simply hadn't been exercised enough times before to have shown
it yet, confirming again this is a property of the model/pattern, not of
any specific agent's prompt.

**Update 13:** a genuinely new *shape* of the flake, not just a new
tool-name variant, hit live while driving the app manually through the
new frontend (not a pytest run) — `process_agent.py` failed with
`langchain_core.exceptions.OutputParserException: Unknown tool type:
'processes=functions.ProcessResult'`. This one never reaches
`groq.BadRequestError` at all: the mangled tool name
("processes=functions.ProcessResult" instead of "ProcessResult") is
syntactically acceptable to Groq's own API, so it returns normally, and
it's langchain's structured-output parser that then can't match it to
the one registered tool and raises `OutputParserException` instead.
`process_agent.py`'s existing `_is_malformed_tool_call` predicate only
checked `BadRequestError`, so this slipped through uncaught and crashed
the request with no retry. Widened the predicate to also catch
`OutputParserException` containing "Unknown tool type" — same narrow,
named-condition approach, not a blanket catch. Only applied to
`process_agent.py`, where it was actually observed; other agents get the
same widening if/when they show this specific shape too, per the
standing rule.
