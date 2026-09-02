import os
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage
from dotenv import load_dotenv

from app.config import GROQ_MODEL

load_dotenv()
from app.tools.customer_tools import get_customer
from app.tools.product_tools import get_product, get_all_product_names
from app.tools.inventory_tools import get_stock
from app.schemas.context import ContextResult, StockByPlant, ProductMatch


def _fuzzy_model():
    return ChatGroq(
        model=GROQ_MODEL,
        api_key=os.environ["GROQ_API_KEY"],
    ).with_structured_output(ProductMatch)


async def resolve_product_name(raw_text: str) -> str | None:
    catalog = get_all_product_names()
    prompt = (
        f"Real product names in our catalog: {catalog}\n\n"
        f"The user said: '{raw_text}'\n\n"
        f"Which real product name from the catalog matches best? "
        f"If none genuinely match, return null."
    )
    result: ProductMatch = await _fuzzy_model().ainvoke([HumanMessage(content=prompt)])

    # Guard: never trust the LLM's answer blindly — it can hallucinate a
    # close-sounding name that isn't actually in the catalog. Only accept
    # it if it's a real, exact catalog entry.
    if result.matched_product_name in catalog:
        return result.matched_product_name
    return None


async def context_agent(customer_name: str, product_name: str) -> ContextResult:
    customer = get_customer(customer_name)

    # Exact match first (fast, no LLM call needed for the common case) —
    # only fall back to fuzzy resolution if the exact name isn't found.
    product = get_product(product_name)
    if product is None:
        resolved_name = await resolve_product_name(product_name)
        if resolved_name:
            product = get_product(resolved_name)

    stock: list[StockByPlant] = []
    if product:
        stock = [StockByPlant(**row) for row in get_stock(product["product_id"])]

    return ContextResult(
        customer_id=customer["customer_id"] if customer else None,
        customer_name=customer["customer_name"] if customer else None,
        customer_exists=customer is not None,
        customer_active=customer["active"] if customer else False,
        product_id=product["product_id"] if product else None,
        product_name=product["product_name"] if product else None,
        product_valid=product is not None,
        price=product["price"] if product else None,
        stock=stock,
        can_produce=product["can_produce"] if product else False,
        product_configurable=product["configurable"] if product else False,
        lead_time_days=product["lead_time_days"] if product else None,
    )
