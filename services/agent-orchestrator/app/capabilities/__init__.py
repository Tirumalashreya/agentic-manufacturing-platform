# app/capabilities/__init__.py
# Importing this package registers every capability whose implementation
# doesn't need a graph.py-local helper (see manufacturing_capabilities.py's
# own docstring for the one exception, simulate_schedule, registered from
# graph.py itself to avoid a circular import).
from app.capabilities import manufacturing_capabilities  # noqa: F401
from app.capabilities.registry import CAPABILITY_SPECS, dispatch, investigable_capabilities, register
from app.capabilities.schemas import CapabilityCall, CapabilityResult, CapabilitySpec, PromiseScenario

__all__ = [
    "CAPABILITY_SPECS",
    "dispatch",
    "investigable_capabilities",
    "register",
    "CapabilityCall",
    "CapabilityResult",
    "CapabilitySpec",
    "PromiseScenario",
]
