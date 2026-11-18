# enterprise-aps-platform/backend/app/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.core.config import settings
from app.core.database import init_db
from app.api import sales, manufacturing, scheduling, mrp


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize authoritative database schema on startup
    await init_db()
    yield


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="Tier-1 Enterprise Autonomous Planning & Scheduling (APS) and Order-to-Cash (O2C) Platform",
    lifespan=lifespan,
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API Routers
app.include_router(sales.router, prefix=settings.API_V1_STR)
app.include_router(manufacturing.router, prefix=settings.API_V1_STR)
app.include_router(scheduling.router, prefix=settings.API_V1_STR)
app.include_router(mrp.router, prefix=settings.API_V1_STR)


@app.get("/")
async def root():
    return {
        "platform": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "status": "OPERATIONAL",
        "standard": "SAP S/4HANA & Oracle Cloud SCM Grade",
        "docs_url": "/docs",
    }


@app.get("/health")
async def health():
    return {"status": "HEALTHY", "tier": "TIER_1_ENTERPRISE"}
