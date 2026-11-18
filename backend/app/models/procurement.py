# enterprise-aps-platform/backend/app/models/procurement.py
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


def generate_uuid():
    return str(uuid.uuid4())


class Supplier(Base):
    __tablename__ = "suppliers"

    id = Column(String, primary_key=True, default=generate_uuid)
    code = Column(String, nullable=False, unique=True)  # e.g., "VEND-SKF", "VEND-ALLEGHENY"
    name = Column(String, nullable=False)
    rating = Column(String, default="TIER_1")  # TIER_1, TIER_2, STRATEGIC
    lead_time_days = Column(Integer, default=7)
    on_time_delivery_pct = Column(Float, default=98.5)
    country = Column(String, default="USA")
    contact_email = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    purchase_orders = relationship("PurchaseOrder", back_populates="supplier")


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id = Column(String, primary_key=True, default=generate_uuid)
    po_number = Column(String, nullable=False, unique=True)  # e.g., "PO-VEND-202611-0001"
    supplier_id = Column(String, ForeignKey("suppliers.id"), nullable=False)
    material_id = Column(String, ForeignKey("materials.id"), nullable=False)
    pegged_sales_order_id = Column(String, ForeignKey("sales_orders.id"), nullable=True)
    quantity = Column(Float, nullable=False)
    unit_cost = Column(Float, nullable=False)
    total_amount = Column(Float, nullable=False)
    status = Column(String, default="DRAFT_PR")  # DRAFT_PR (Requisition), RELEASED, IN_TRANSIT, RECEIVED
    dock_due_date = Column(DateTime, nullable=False)
    received_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    supplier = relationship("Supplier", back_populates="purchase_orders")
    material = relationship("Material")
    sales_order = relationship("SalesOrder")
