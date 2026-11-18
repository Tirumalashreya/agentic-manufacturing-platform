# enterprise-aps-platform/backend/app/models/manufacturing.py
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


def generate_uuid():
    return str(uuid.uuid4())


class ProductionOrder(Base):
    __tablename__ = "production_orders"

    id = Column(String, primary_key=True, default=generate_uuid)
    order_number = Column(String, nullable=False, unique=True)  # e.g., "PO-2026-0001"
    sales_order_id = Column(String, ForeignKey("sales_orders.id"), nullable=True)
    material_id = Column(String, ForeignKey("materials.id"), nullable=False)
    target_quantity = Column(Float, nullable=False)
    completed_quantity = Column(Float, default=0.0)
    scrap_quantity = Column(Float, default=0.0)
    status = Column(String, default="PLANNED")  # PLANNED, SCHEDULED, RELEASED, IN_PROGRESS, COMPLETED, CANCELLED
    earliest_start = Column(DateTime, nullable=True)
    due_date = Column(DateTime, nullable=True)
    scheduled_start = Column(DateTime, nullable=True)
    scheduled_end = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    sales_order = relationship("SalesOrder", back_populates="production_orders")
    material = relationship("Material")
    operations = relationship("ScheduledOperation", back_populates="production_order", order_by="ScheduledOperation.sequence", cascade="all, delete-orphan")


class ScheduledOperation(Base):
    __tablename__ = "scheduled_operations"

    id = Column(String, primary_key=True, default=generate_uuid)
    production_order_id = Column(String, ForeignKey("production_orders.id"), nullable=False)
    routing_operation_id = Column(String, ForeignKey("routing_operations.id"), nullable=True)
    machine_id = Column(String, ForeignKey("machines.id"), nullable=False)
    work_center_id = Column(String, ForeignKey("work_centers.id"), nullable=False)
    sequence = Column(Integer, nullable=False)  # 10, 20, 30
    operation_name = Column(String, nullable=False)
    duration_minutes = Column(Float, nullable=False)
    setup_minutes = Column(Float, default=15.0)

    planned_start = Column(DateTime, nullable=False)
    planned_end = Column(DateTime, nullable=False)
    actual_start = Column(DateTime, nullable=True)
    actual_end = Column(DateTime, nullable=True)
    status = Column(String, default="SCHEDULED")  # SCHEDULED, RUNNING, COMPLETED, DELAYED

    production_order = relationship("ProductionOrder", back_populates="operations")
    machine = relationship("Machine")
    work_center = relationship("WorkCenter")


class ChangeoverMatrix(Base):
    __tablename__ = "changeover_matrix"

    id = Column(String, primary_key=True, default=generate_uuid)
    work_center_id = Column(String, ForeignKey("work_centers.id"), nullable=False)
    from_product_type = Column(String, nullable=False)
    to_product_type = Column(String, nullable=False)
    changeover_minutes = Column(Float, default=30.0)
