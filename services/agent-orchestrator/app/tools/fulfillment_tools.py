# app/tools/fulfillment_tools.py

def determine_fulfillment_strategy(
    product_configurable: bool,
    quantity: int | None,
    stock_total: int,
    can_produce: bool,
) -> str:
    qty = quantity or 0
    if product_configurable:
        return "CTO"
    if stock_total >= qty and qty > 0:
        return "MTS"
    if stock_total > 0 and can_produce and stock_total < qty:
        return "HYBRID"
    if can_produce:
        return "MTO"
    return "THIRD_PARTY"


# The agent explains the strategy; this computes the actual numbers. Never
# the model's job — pure arithmetic on already-known quantities.
def compute_fulfillment_split(strategy: str, quantity: int, stock_total: int) -> dict:
    if strategy == "MTS":
        from_stock = quantity
        to_produce = 0
    elif strategy == "MTO":
        from_stock = 0
        to_produce = quantity
    elif strategy == "HYBRID":
        from_stock = min(stock_total, quantity)
        to_produce = quantity - from_stock
    else:
        # CTO / THIRD_PARTY / INTERCOMPANY don't decompose into a
        # stock/production split the same way — the whole quantity goes
        # through that one path (configuration, external sourcing, or
        # another company), not partly from our own stock.
        from_stock = 0
        to_produce = quantity

    return {
        "from_stock": from_stock,
        "to_produce": to_produce,
    }


# Phase 12 cleanup (brief §17A) — this arithmetic used to live inline in
# graph.py's VENDOR-alternative branch (promise_reasoning_node), the one
# place Phase 10/11 computed a quantity split outside this file. Moved
# here so the agent orchestration code never owns business arithmetic,
# matching compute_fulfillment_split's own stated principle above —
# genuinely the same min/subtract shape as the HYBRID branch, just
# labeling the non-stock remainder as vendor-sourced instead of produced.
def compute_vendor_split(quantity: int, stock_total: int) -> dict:
    from_stock = min(stock_total, quantity)
    from_vendor = quantity - from_stock
    return {
        "from_stock": from_stock,
        "from_vendor": from_vendor,
    }
