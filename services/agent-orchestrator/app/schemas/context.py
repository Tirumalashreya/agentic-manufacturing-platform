from pydantic import BaseModel, Field


class ProductMatch(BaseModel):
    matched_product_name: str | None  # must be one of the real catalog names, or None if nothing matches


class StockByPlant(BaseModel):
    plant: str
    stock_qty: int
    



class ContextResult(BaseModel):
    customer_id: str | None = None
    customer_name: str | None = None
    customer_exists: bool = False
    customer_active: bool = False

    product_id: str | None = None
    product_name: str | None = None
    product_valid: bool = False

    price: float | None = None
    stock: list[StockByPlant] = Field(default_factory=list)

    can_produce: bool = False
    product_configurable: bool = False
    lead_time_days: int | None = None
