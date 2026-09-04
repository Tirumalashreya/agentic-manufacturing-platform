# app/tools/fulfillment_tools.py
# The agent decides the strategy; this computes the actual numbers. Never
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
