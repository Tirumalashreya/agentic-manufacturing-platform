# enterprise-aps-platform/backend/app/models/sales.py
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


def generate_uuid():
    return str(uuid.uuid4())


class Customer(Base):
    __tablename__ = "customers"

    id = Column(String, primary_key=True, default=generate_uuid)
    customer_number = Column(String, nullable=False, unique=True)  # e.g., "CUST-001"
    name = Column(String, nullable=False)
    credit_limit = Column(Float, default=100000.0)
    current_exposure = Column(Float, default=0.0)
    payment_terms = Column(String, default="NET30")
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    sales_orders = relationship("SalesOrder", back_populates="customer")


class SalesOrder(Base):
    __tablename__ = "sales_orders"

    id = Column(String, primary_key=True, default=generate_uuid)
    order_number = Column(String, nullable=False, unique=True)  # e.g., "SO-2026-0001"
    customer_id = Column(String, ForeignKey("customers.id"), nullable=False)
    requested_delivery_date = Column(DateTime, nullable=True)
    promised_delivery_date = Column(DateTime, nullable=True)
    status = Column(String, default="DRAFT")  # DRAFT, CTP_EVALUATED, APPROVED, RELEASED, SHIPPED, BILLED
    total_amount = Column(Float, default=0.0)
    currency = Column(String, default="USD")
    created_at = Column(DateTime, default=datetime.utcnow)
    approved_at = Column(DateTime, nullable=True)

    customer = relationship("Customer", back_populates="sales_orders")
    lines = relationship("SalesOrderLine", back_populates="sales_order", cascade="all, delete-orphan")
    production_orders = relationship("ProductionOrder", back_populates="sales_order")
    delivery_promise = relationship("DeliveryPromise", back_populates="sales_order", uselist=False)


class SalesOrderLine(Base):
    __tablename__ = "sales_order_lines"

    id = Column(String, primary_key=True, default=generate_uuid)
    sales_order_id = Column(String, ForeignKey("sales_orders.id"), nullable=False)
    material_id = Column(String, ForeignKey("materials.id"), nullable=False)
    line_number = Column(Integer, default=10)
    quantity = Column(Float, nullable=False)
    unit_price = Column(Float, nullable=False)
    fulfillment_strategy = Column(String, default="MTO")  # MTS (Make to Stock), MTO (Make to Order)
    status = Column(String, default="OPEN")

    sales_order = relationship("SalesOrder", back_populates="lines")
    material = relationship("Material")


class DeliveryPromise(Base):
    __tablename__ = "delivery_promises"

    id = Column(String, primary_key=True, default=generate_uuid)
    sales_order_id = Column(String, ForeignKey("sales_orders.id"), nullable=False, unique=True)
    committed_date = Column(DateTime, nullable=False)
    projected_date = Column(DateTime, nullable=False)
    risk_level = Column(String, default="SAFE")  # SAFE, AT_RISK, BREACHED, UNKNOWN
    delay_hours = Column(Float, default=0.0)
    confidence_score = Column(Float, default=0.98)
    last_verified_at = Column(DateTime, default=datetime.utcnow)

    sales_order = relationship("SalesOrder", back_populates="delivery_promise")
