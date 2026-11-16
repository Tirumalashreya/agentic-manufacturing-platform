# Security architecture review

Static review; no penetration test was done. Ledger's and APS's auth internals were only skimmed (`auth.ts`, `routeAuth.ts`).

## Verified controls

| Control | Evidence |
|---|---|
| Fail-closed shared internal token on every service route except `/health` | `serviceAuth.ts` (`requireServiceToken`) |
| Signed identity assertion (HMAC-SHA256, audience-bound, 60 s TTL); tenant id from identity, never from body | `identity.ts`, contract F1 |
| Orchestrator requires service token **and** forwarded user/role for human actions; role rank VIEWER<PLANNER<ADMIN<OWNER | `app/security.py` |
| Approval bound to proposal hash; LLM prose excluded from executable payload; atomic claim | `approval_proposal.py`, contract D1 |
| Agents cannot write directly; tools are typed functions that call domain APIs | contract C1 |
| `.env*` git-ignored; none tracked | `.gitignore`, `git ls-files` returned no env files |
| Audit log tables | `AuditLog`, `ScheduleAuditLog` |

## Gaps

| # | Gap | Sev | Fix |
|---|---|---|---|
| S1 | One shared secret for all services. A leak anywhere compromises all; no rotation story | High | Per-service secrets or mTLS later; start with rotation runbook |
| S2 | Token comparison with `===` / `!=` (`routeAuth.ts`, `security.py`) | Low | `timingSafeEqual` / `hmac.compare_digest` |
| S3 | No rate limiting or security headers found on any service. CORS exists only on the agent-orchestrator (`CORSMiddleware`, single origin `http://localhost:3000`, hardcoded); the Node services have none. *(Corrected: an earlier version said no CORS policy existed.)* | Medium | Edge/gateway middleware; make the orchestrator origin configurable |
| S4 | Input validation: `zod` appears in 1 file | Medium | Validate every request body at the boundary (Express + Pydantic in orchestrator already) |
| S5 | RBAC is coarse (4 roles); separation of duties (requester ≠ approver) not verified | Medium | Add policy: approver ≠ proposer for money/schedule commits |
| S6 | No site-level isolation inside an enterprise | Medium (Level 3) | `siteId` scoping |
| S7 | Product master is global across tenants | Medium (Level 3) | See G4 |
| S8 | Encryption at rest/in transit: not configured anywhere in repo; compose uses plaintext and a default `aps:aps` DB password | High for prod | TLS, managed DB, secrets manager |
| S9 | Groq is the LLM provider; business data goes to an external API | Medium | Data classification, redaction, vendor terms |
| S10 | Dependency scanning and SAST absent in CI | Medium | Add npm audit/pip-audit, CodeQL |
| S11 | Prompt injection: free-text customer documents flow to LLM agents. Controls are structural (propose-only, hash-bound approval, deterministic validation) | Medium | Add adversarial cases to the eval set; strip tool-call-like text; never let document text choose tool args without validation |
| S12 | Scratch scripts (`scratch-verify*.ts`) in order-service | Low | Remove or move out of the package |

## Agent tool permissions

Principle: **an agent's permissions equal the permissions of the tools it is given, not what it can reason about.** Today tools are typed Python functions, but I found no per-agent allow-list enforcement mechanism (the capability registry in `capabilities/registry.py` chooses capabilities; enforcement was not verified). PROPOSED: per-agent tool allow-list asserted in a test, and a runtime check that write tools require an approved proposal id.
