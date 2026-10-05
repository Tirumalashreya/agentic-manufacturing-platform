# app/schemas/configuration.py
from pydantic import BaseModel, Field


class ConfigurationOption(BaseModel):
    attribute: str  # e.g. "RAM", "Storage", "Processor"
    value: str  # e.g. "32GB", "1TB SSD", "i7"


class ConfigurationResult(BaseModel):
    options: list[ConfigurationOption] = Field(default_factory=list)
    notes: str
