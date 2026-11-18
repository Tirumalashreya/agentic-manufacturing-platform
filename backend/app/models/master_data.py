# enterprise-aps-platform/backend/app/models/master_data.py
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.database import Base


def generate_uuid():
    return str(uuid.uuid4())


class Enterprise(Base):
    __tablename__ = "enterprises"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String, nullable=False, unique=True)
    code = Column(String, nullable=False, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    plants = relationship("Plant", back_populates="enterprise", cascade="all, delete-orphan")


class Plant(Base):
    __tablename__ = "plants"

    id = Column(String, primary_key=True, default=generate_uuid)
    enterprise_id = Column(String, ForeignKey("enterprises.id"), nullable=False)
    name = Column(String, nullable=False)
    code = Column(String, nullable=False)  # e.g., "PLANT-01"
    location = Column(String, nullable=True)

    enterprise = relationship("Enterprise", back_populates="plants")
    work_centers = relationship("WorkCenter", back_populates="plant", cascade="all, delete-orphan")


class WorkCenter(Base):
    __tablename__ = "work_centers"

    id = Column(String, primary_key=True, default=generate_uuid)
    plant_id = Column(String, ForeignKey("plants.id"), nullable=False)
    code = Column(String, nullable=False)  # e.g., "WC-ASSY", "WC-CNC", "WC-TEST"
    name = Column(String, nullable=False)
    capacity_hours_per_day = Column(Float, default=16.0)  # standard two-shift capacity
    hourly_rate = Column(Float, default=75.0)  # USD / hour for standard costing

    plant = relationship("Plant", back_populates="work_centers")
    machines = relationship("Machine", back_populates="work_center", cascade="all, delete-orphan")
    routing_operations = relationship("RoutingOperation", back_populates="work_center")


class Machine(Base):
    __tablename__ = "machines"

    id = Column(String, primary_key=True, default=generate_uuid)
    work_center_id = Column(String, ForeignKey("work_centers.id"), nullable=False)
    code = Column(String, nullable=False)  # e.g., "CNC-01", "M-01"
    name = Column(String, nullable=False)
    status = Column(String, default="ACTIVE")  # ACTIVE, MAINTENANCE, DOWN
    efficiency_factor = Column(Float, default=1.0)  # OEE factor (0.8 - 1.2)
    last_maintenance_at = Column(DateTime, nullable=True)

    work_center = relationship("WorkCenter", back_populates="machines")


class Material(Base):
    __tablename__ = "materials"

    id = Column(String, primary_key=True, default=generate_uuid)
    sku = Column(String, nullable=False, unique=True)  # e.g., "CMK-100", "RAW-STEEL-01"
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    unit_of_measure = Column(String, default="EA")  # EA, KG, MTR
    material_type = Column(String, default="FINISHED")  # FINISHED, SEMI_FINISHED, RAW
    standard_cost = Column(Float, default=0.0)
    current_stock = Column(Float, default=0.0)
    safety_stock = Column(Float, default=10.0)
    lead_time_days = Column(Integer, default=5)

    bom_header = relationship("BillOfMaterial", back_populates="finished_material", uselist=False)
    routing = relationship("Routing", back_populates="material", uselist=False)


class BillOfMaterial(Base):
    __tablename__ = "boms"

    id = Column(String, primary_key=True, default=generate_uuid)
    finished_material_id = Column(String, ForeignKey("materials.id"), nullable=False, unique=True)
    version = Column(String, default="1.0")
    active = Column(Boolean, default=True)

    finished_material = relationship("Material", back_populates="bom_header")
    items = relationship("BOMItem", back_populates="bom", cascade="all, delete-orphan")


class BOMItem(Base):
    __tablename__ = "bom_items"

    id = Column(String, primary_key=True, default=generate_uuid)
    bom_id = Column(String, ForeignKey("boms.id"), nullable=False)
    component_material_id = Column(String, ForeignKey("materials.id"), nullable=False)
    quantity_per = Column(Float, nullable=False)  # qty required per unit of finished good
    scrap_factor_pct = Column(Float, default=0.0)

    bom = relationship("BillOfMaterial", back_populates="items")
    component_material = relationship("Material")


class Routing(Base):
    __tablename__ = "routings"

    id = Column(String, primary_key=True, default=generate_uuid)
    material_id = Column(String, ForeignKey("materials.id"), nullable=False, unique=True)
    name = Column(String, nullable=False)
    version = Column(String, default="1.0")

    material = relationship("Material", back_populates="routing")
    operations = relationship("RoutingOperation", back_populates="routing", order_by="RoutingOperation.sequence", cascade="all, delete-orphan")


class RoutingOperation(Base):
    __tablename__ = "routing_operations"

    id = Column(String, primary_key=True, default=generate_uuid)
    routing_id = Column(String, ForeignKey("routings.id"), nullable=False)
    work_center_id = Column(String, ForeignKey("work_centers.id"), nullable=False)
    sequence = Column(Integer, nullable=False)  # 10, 20, 30
    operation_name = Column(String, nullable=False)  # e.g., "Cut/Prep", "Precision Assembly", "QC Inspection"
    setup_minutes = Column(Float, default=15.0)
    run_minutes_per_unit = Column(Float, default=5.0)

    routing = relationship("Routing", back_populates="operations")
    work_center = relationship("WorkCenter", back_populates="routing_operations")
