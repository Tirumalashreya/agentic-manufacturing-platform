from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers.pipeline import router as pipeline_router

app = FastAPI(title="agent-orchestrator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pipeline_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
