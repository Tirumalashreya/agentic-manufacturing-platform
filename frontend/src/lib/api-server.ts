import { auth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import type { PipelineRunSummary } from "@/types/workflow";

export async function serverRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const session = await auth();
  if (!session?.user) throw new ApiError("Authentication required", 401);
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) throw new ApiError("Service misconfigured — internal auth token not set", 500);
  const orchestratorUrl = process.env.AGENT_ORCHESTRATOR_URL ?? "http://localhost:8000";
  const url = `${orchestratorUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-internal-token": token,
    "x-forwarded-user": session.user.id,
    "x-forwarded-role": session.user.role,
  };

  const res = await fetch(url, {
    headers,
    ...init,
  });

  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.message || text;
    } catch {
      // keep raw text
    }
    throw new ApiError(detail, res.status);
  }

  return (await res.json()) as T;
}

export async function listPipelineRuns(limit = 10): Promise<PipelineRunSummary[]> {
  return serverRequest<PipelineRunSummary[]>(`/runs?limit=${limit}`);
}
