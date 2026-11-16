# Frontend architecture review

Depth: structure and a few files sampled. **Screens were not rendered or exercised**; accessibility and responsive claims are limited to commit messages.

## Facts (VERIFIED)

- Two Next.js apps in an npm workspace: **Ledger** (`frontend/`, about 8.6k lines; routes include agent-console, approvals, billing, promise-inbox, pending-decisions, production-planning, returns, trace, workflows, plus per-channel sales pages) and **APS** (`web/`, about 11.4k lines; `(app)`, `(auth)`, `(marketing)`, API routes).
- Auth via NextAuth in both (`auth.ts`); APS has `routeAuth.ts` role check for mutating routes.
- Server state is fetched with ad hoc `useLiveList` (5 s polling, visibility-aware) in Ledger; APS pushes live updates by SSE (`/api/events/stream`, `LiveConnectivityBanner`).
- The brief's AGENTS.md says this Next.js version has **breaking changes versus common knowledge**; any frontend change must first read `node_modules/next/dist/docs/` (not done here because no code changes were made).
- Recent commits mention accessibility and responsive fixes (`a139669`) and Ledger Promise UI polish.

## Assessment

| Topic | Finding |
|---|---|
| Feature boundaries | By route per channel; sales variants likely repeat structure (not diffed) |
| Data fetching | Polling hook in Ledger; no shared query cache; SSE in APS. Two mechanisms for the same need |
| Forms/validation | `web/src/lib/validations` exists in APS; Ledger not verified |
| Permission-aware nav | Not verified |
| Large tables / Gantt | Not verified; schedule visualization is a differentiation lever and must be measured |
| Tests | Ledger 8 files / 47 tests; APS **0** |
| Design system | None shared |

## Recommendation

Keep two apps (different users and domains). Extract a small shared package `packages/ui` (tokens, table, status chip, timeline, empty/error/loading states), a shared client SDK for the three boundary APIs, and one live-update mechanism (SSE from notification-service for both). The new order-lifecycle timeline and exception command center ship as shared components consumed by both apps, which gives the unified experience without merging the apps.

Verification needed: run both apps and review with the browser-automation workflow; add Playwright smoke tests for the five key flows (create order, approve recovery, reschedule, report completion, view timeline).
