# enterprise-aps-platform/backend/app/models/audit.py
import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime, Text, JSON
from app.core.database import Base


def generate_uuid():
    return str(uuid.uuid4())


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(String, primary_key=True, default=generate_uuid)
    timestamp = Column(DateTime, default=datetime.utcnow, nullable=False)
    actor = Column(String, nullable=False)  # e.g., "sales.rep@enterprise.com" or "system.scheduler"
    action = Column(String, nullable=False)  # e.g., "SALES_ORDER_APPROVED", "SCHEDULE_OPTIMIZED"
    entity_type = Column(String, nullable=False)  # e.g., "SalesOrder", "ProductionOrder"
    entity_id = Column(String, nullable=False)
    trace_id = Column(String, nullable=True)
    details = Column(JSON, nullable=True)


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id = Column(String, primary_key=True, default=generate_uuid)
    token = Column(String, nullable=False, unique=True)
    action_type = Column(String, nullable=False)  # e.g., "ORDER_CREATION", "SCHEDULE_RESCHEDULE"
    status = Column(String, default="PENDING")  # PENDING, APPROVED, REJECTED, EXPIRED
    proposal_payload = Column(JSON, nullable=False)
    requested_by = Column(String, default="agent.orchestrator")
    approved_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    decided_at = Column(DateTime, nullable=True)


class OutboxEvent(Base):
    __tablename__ = "outbox_events"

    id = Column(String, primary_key=True, default=generate_uuid)
    event_type = Column(String, nullable=False)
    aggregate_id = Column(String, nullable=False)
    payload = Column(JSON, nullable=False)
    status = Column(String, default="PENDING")  # PENDING, PUBLISHED, FAILED
    created_at = Column(DateTime, default=datetime.utcnow)
