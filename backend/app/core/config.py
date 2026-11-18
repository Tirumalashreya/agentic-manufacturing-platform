# enterprise-aps-platform/backend/app/core/config.py
import os
from pydantic_settings import BaseSettings
from typing import Optional

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_SQLITE_URL = f"sqlite+aiosqlite:///{os.path.join(BASE_DIR, 'enterprise_aps.db')}"


class Settings(BaseSettings):
    PROJECT_NAME: str = "Enterprise Autonomous Planning & Scheduling (APS)"
    VERSION: str = "2.0.0-tier1"
    API_V1_STR: str = "/api/v1"

    # Authoritative Enterprise System of Record
    DATABASE_URL: str = DEFAULT_SQLITE_URL

    # Security & RBAC
    JWT_SECRET: str = "enterprise_grade_super_secret_jwt_key_982347891234"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24

    # LLM / Cognitive Layer Keys
    GROQ_API_KEY: Optional[str] = None
    GEMINI_API_KEY: Optional[str] = None
    OPENAI_API_KEY: Optional[str] = None

    # CORS
    BACKEND_CORS_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://127.0.0.1:3000",
        "*"
    ]

    class Config:
        case_sensitive = True
        extra = "allow"


settings = Settings()

# Normalize Postgres driver for async SQLAlchemy
if settings.DATABASE_URL.startswith("postgresql://"):
    settings.DATABASE_URL = settings.DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
