# app/agents/process_agent.py
from groq import BadRequestError
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from dotenv import load_dotenv
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_fixed

from app.config import GROQ_MODEL, groq_api_key
from app.schemas.process import ProcessResult

load_dotenv()


SYSTEM_PROMPT = """You are the process decision agent for an ERP sales system.

Given the customer's intent and what we know about the customer and product,
produce three things: entry_type, process, and starting_stage.

entry_type — the broad business category:
- PRE_SALES: an inquiry or quote request, no commitment yet.
- DIRECT_SALES: the customer is placing a new order now.
- POST_SALES: a follow-up to an existing order — returns, replacements,
  credit/debit memos tied to a prior sale, complaints.
- SUBSCRIPTION: a recurring/subscription commitment, not a one-off order.
- SERVICE: a service engagement rather than a physical product sale.
- PROJECT: a large, milestone-based engagement rather than a standard order.
- FINANCIAL: a standalone financial adjustment not tied to a specific prior
  order (e.g. a general account credit with no referenced order).

process — the specific process within that category. Pick the closest match:
QUOTE_REQUEST, NEW_SALES_ORDER, PRODUCT_RETURN, REPLACEMENT,
NEW_SUBSCRIPTION, SUBSCRIPTION_RENEWAL, SERVICE_REQUEST, PROJECT_ORDER,
CREDIT_MEMO, DEBIT_MEMO, FINANCIAL_ADJUSTMENT.

starting_stage — the lifecycle stage this request begins at (free text for
now, e.g. "Lead", "Inquiry", "Quotation", "Sales Order", "Return", "Renewal",
"Credit Memo", "Delivery", "Billing", "Payment"). Pick whichever stage name
best matches where execution should start.

Use the given intent as the primary signal for entry_type and process.
intent=service_request always maps to entry_type=SERVICE,
process=SERVICE_REQUEST, starting_stage="Service Request" — never
DIRECT_SALES, even if a quantity or piece of equipment was mentioned;
service_request means work is being requested, not a product purchased.

intent=subscription_request always maps to entry_type=SUBSCRIPTION,
starting_stage="Renewal" if the request sounds like renewing/continuing
something already in place (e.g. mentions "renew", "continue", "extend"),
otherwise starting_stage="New Subscription". Pick process=NEW_SUBSCRIPTION
for a first-time signup, process=SUBSCRIPTION_RENEWAL if it sounds like a
renewal — this is only a best-effort guess from limited context; the
Subscription workflow itself makes the definitive call from the full
request text.

You are not told whether a credit_memo references a specific past order — you do
not have order/invoice data here — so default credit_memo to
POST_SALES/CREDIT_MEMO starting at "Credit Memo". The deciding signal is
whether a PRODUCT is involved, not whether a customer is known — a known
customer does not by itself mean POST_SALES, since financial adjustments
still happen for a specific customer. Choose
FINANCIAL/FINANCIAL_ADJUSTMENT specifically when product_valid is false
or no product was given at all, meaning this isn't tied to any particular
item/order, regardless of whether the customer is known.

Examples:
- "ABC wants a quote for 100 laptops." ->
  entry_type=PRE_SALES, process=QUOTE_REQUEST, starting_stage="Quotation"
- "ABC wants to return 5 laptops from order SO123." ->
  entry_type=POST_SALES, process=PRODUCT_RETURN, starting_stage="Return"
- "ABC wants to renew their annual software subscription." ->
  entry_type=SUBSCRIPTION, process=SUBSCRIPTION_RENEWAL, starting_stage="Renewal"

Give one concise sentence of reasoning for the decision.
Return valid JSON only."""


def _model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=groq_api_key("process"),
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


async def process_agent(
    intent: str,
    customer: str | None,
    product: str | None,
    quantity: int | None,
    requested_deadline: str | None,
    customer_exists: bool,
    customer_active: bool,
    product_valid: bool,
) -> ProcessResult:
    context = (
        f"intent: {intent}\n"
        f"customer: {customer}\n"
        f"product: {product}\n"
        f"quantity: {quantity}\n"
        f"requested_deadline: {requested_deadline}\n"
        f"customer_exists: {customer_exists}\n"
        f"customer_active: {customer_active}\n"
        f"product_valid: {product_valid}"
    )
    model = _model()
    messages = [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=context)]
    result: ProcessResult = await _invoke(model, messages)
    return result
