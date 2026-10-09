import type { ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { getQueriesForElement, fireEvent, waitFor } from "@testing-library/dom";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import PromiseInboxPage from "./page";
import { listPromiseInbox, type PromiseInboxResponse } from "@/lib/api";

// Phase 14 (Promise Risk & Decision Inbox) — this page is a pure read view
// over an already-classified, already-prioritized response (see
// packages/domain/src/promise-risk.ts and services/order-service/src/
// promise-inbox.ts for where riskStatus/workflowStatus are actually
// decided). These tests mock the one network call (listPromiseInbox) and
// verify only what this component itself is responsible for: rendering
// summary/table/loading/empty/error states correctly, filtering/searching
// client-side without ever mutating the summary counts, and linking each
// row to the correct EXISTING route — never a new approval mechanism.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, listPromiseInbox: vi.fn() };
});

// next/link pulls in Next's own app-router context, which isn't present
// in this plain jsdom+Vitest render — a minimal passthrough is the
// standard way to unit-test a component that merely renders a Link,
// without needing the full Next runtime just to read its href attribute.
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Real, pre-existing gap in this monorepo's test setup (confirmed not
// specific to this file): the root workspace hoists a different react/
// react-dom version than frontend/ pins locally, and @testing-library/
// react — installed only at the workspace root — resolves react-dom
// relative to ITS OWN location, landing on the mismatched root copy and
// producing an "Invalid hook call" on the very first hook-using
// component this app has ever rendered in a test (every existing test
// here renders only hook-free presentational components, so this was
// never triggered before). Driving react-dom/client + @testing-library/
// dom directly (both resolve correctly, proven in isolation) sidesteps
// @testing-library/react's broken internal resolution entirely, without
// touching the shared monorepo dependency tree.
function renderPage(el: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { container, root, ...getQueriesForElement(container) };
}

let activeContainer: HTMLElement | null = null;
let activeRoot: ReturnType<typeof createRoot> | null = null;

function renderAndTrack(el: ReactElement) {
  const { container, root, ...queries } = renderPage(el);
  activeContainer = container;
  activeRoot = root;
  return queries;
}

afterEach(() => {
  if (activeRoot && activeContainer) {
    act(() => activeRoot!.unmount());
    activeContainer.remove();
  }
  activeContainer = null;
  activeRoot = null;
});

function fixture(overrides: Partial<PromiseInboxResponse> = {}): PromiseInboxResponse {
  return {
    items: [
      {
        salesOrderId: "so-breached",
        orderNumber: "ORD-1",
        externalOrderId: "SO0001",
        customerId: "cust-1",
        customerName: "Acme Corp",
        productSummary: "Widget x5",
        promisedDate: "2026-12-10T00:00:00.000Z",
        projectedDeliveryDate: "2026-12-12T00:00:00.000Z",
        delayHours: 48,
        riskStatus: "BREACHED",
        workflowStatus: "NONE",
        explanation: "Projected delivery is 2 day(s) after the committed promise.",
        reasonCode: "SCHEDULE_OVERRUN",
        scheduleAsOf: "2026-12-08T00:00:00.000Z",
        recommendedAction: "Investigate the cause and initiate a recovery reschedule.",
        productionOrderId: "po-1",
        pendingApprovalRunId: null,
        lines: [],
      },
      {
        salesOrderId: "so-pending",
        orderNumber: "ORD-2",
        externalOrderId: "SO0002",
        customerId: "cust-2",
        customerName: "Beta LLC",
        productSummary: "Gadget x2",
        promisedDate: "2026-12-11T00:00:00.000Z",
        projectedDeliveryDate: "2026-12-13T00:00:00.000Z",
        delayHours: 24,
        riskStatus: "BREACHED",
        workflowStatus: "AWAITING_APPROVAL",
        explanation: "Projected delivery is 1 day(s) after the committed promise.",
        reasonCode: "SCHEDULE_OVERRUN",
        scheduleAsOf: "2026-12-09T00:00:00.000Z",
        recommendedAction: "Review and approve or reject the pending recovery recommendation.",
        productionOrderId: "po-2",
        pendingApprovalRunId: "run-2",
        lines: [],
      },
      {
        salesOrderId: "so-safe",
        orderNumber: "ORD-3",
        externalOrderId: "SO0003",
        customerId: "cust-3",
        customerName: "Gamma Inc",
        productSummary: "Doohickey x1",
        promisedDate: "2026-12-20T00:00:00.000Z",
        projectedDeliveryDate: "2026-12-15T00:00:00.000Z",
        delayHours: null,
        riskStatus: "SAFE",
        workflowStatus: "NONE",
        explanation: "Current schedule evidence supports meeting the promise.",
        reasonCode: "ON_TRACK",
        scheduleAsOf: "2026-12-07T00:00:00.000Z",
        recommendedAction: "No action needed.",
        productionOrderId: "po-3",
        pendingApprovalRunId: null,
        lines: [],
      },
    ],
    total: 3,
    limit: 200,
    offset: 0,
    summary: {
      breached: 2,
      atRisk: 0,
      unknown: 0,
      safe: 1,
      awaitingApproval: 1,
      restoredAfterRecovery: 0,
      recoveryFailed: 0,
    },
    generatedAt: "2026-12-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("PromiseInboxPage", () => {
  beforeEach(() => {
    vi.mocked(listPromiseInbox).mockReset();
  });

  it("renders summary metrics and all rows from a successful load", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText } = renderAndTrack(<PromiseInboxPage />);

    await findByText("Acme Corp");
    expect(await findByText("Beta LLC")).toBeTruthy();
    expect(await findByText("Gamma Inc")).toBeTruthy();

    // Summary cards reflect the backend's own unfiltered counts verbatim
    // (breached=2, awaitingApproval=1 — "safe" has no metric card, by design:
    // the brief names only at-risk/breached/awaiting-approval/restored).
    expect(await findByText("2")).toBeTruthy(); // breached
    expect(await findByText("1")).toBeTruthy(); // awaitingApproval
  });

  it("Phase 18 — colors a non-zero summary count by severity, never a zero count (a calm inbox shouldn't look alarming)", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getAllByText } = renderAndTrack(<PromiseInboxPage />);

    const breachedValue = await findByText("2"); // summary.breached, non-zero
    expect(breachedValue.style.color).toBe("var(--alert)");

    // summary.atRisk and summary.restoredAfterRecovery are both 0 in this
    // fixture — neither should carry a severity (danger/warning/success)
    // color; MetricCard's "neutral" tone resolves to the same plain ink
    // every other number on the page already uses.
    for (const zeroValue of getAllByText("0")) {
      expect(zeroValue.style.color).toBe("var(--text)");
    }
  });

  it("Phase 15 — shows evidence freshness (scheduleAsOf) next to the reason it backs, when real schedule evidence exists", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, findAllByText } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Acme Corp");

    const freshnessNotes = await findAllByText(/Schedule evidence as of/);
    expect(freshnessNotes.length).toBe(3); // one per fixture row, each with its own scheduleAsOf
  });

  it("shows an empty state when there are no active promises, not an error", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture({ items: [], total: 0 }));
    const { findByText } = renderAndTrack(<PromiseInboxPage />);

    expect(await findByText("No active promises to track")).toBeTruthy();
  });

  it("shows an error state when the load fails, never a silent empty table", async () => {
    vi.mocked(listPromiseInbox).mockRejectedValue(new Error("order-service unreachable"));
    const { findByText } = renderAndTrack(<PromiseInboxPage />);

    expect(await findByText("order-service unreachable")).toBeTruthy();
  });

  it("filtering by risk status narrows the table WITHOUT changing the summary counts", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getByLabelText, queryByText } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Acme Corp");

    // Uncheck SAFE — Gamma Inc (the only SAFE row) should disappear.
    act(() => {
      fireEvent.click(getByLabelText("SAFE"));
    });
    await waitFor(() => expect(queryByText("Gamma Inc")).toBeNull());
    expect(queryByText("Acme Corp")).toBeTruthy();

    // Summary cards must not have moved — still the full, unfiltered counts.
    expect(queryByText("2")).toBeTruthy();
  });

  it("the search box narrows rows by customer name, client-side", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getByPlaceholderText, queryByText } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Acme Corp");

    act(() => {
      fireEvent.change(getByPlaceholderText("Search order or customer…"), { target: { value: "beta" } });
    });
    await waitFor(() => expect(queryByText("Acme Corp")).toBeNull());
    expect(queryByText("Beta LLC")).toBeTruthy();
  });

  it("'awaiting approval only' shows just the one pending item", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getByLabelText, queryByText } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Acme Corp");

    act(() => {
      fireEvent.click(getByLabelText("Awaiting approval only"));
    });
    await waitFor(() => expect(queryByText("Acme Corp")).toBeNull());
    expect(queryByText("Beta LLC")).toBeTruthy();
    expect(queryByText("Gamma Inc")).toBeNull();
  });

  it("an AWAITING_APPROVAL row links to the existing Pending Decisions page, not a new approval UI", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getByRole } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Beta LLC");

    const link = getByRole("link", { name: /review approval/i });
    expect(link.getAttribute("href")).toBe("/pending-decisions");
  });

  it("a plain breached row links to the existing order detail page by its external (mock-ERP) id", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getAllByRole } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Acme Corp");

    // Both Acme (BREACHED/NONE) and Gamma (SAFE) get a "View order" link —
    // only Beta (AWAITING_APPROVAL) gets "Review approval" instead.
    const links = getAllByRole("link", { name: /view order/i });
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/domestic-sales/SO0001");
    expect(hrefs).toContain("/domestic-sales/SO0003");
    expect(hrefs).toHaveLength(2);
  });

  it("never calls any mutating/approval API — only the one read-only listPromiseInbox call, even after filtering and refreshing", async () => {
    vi.mocked(listPromiseInbox).mockResolvedValue(fixture());
    const { findByText, getByLabelText, getByPlaceholderText, getByRole } = renderAndTrack(<PromiseInboxPage />);
    await findByText("Acme Corp");

    act(() => {
      fireEvent.click(getByLabelText("SAFE"));
      fireEvent.change(getByPlaceholderText("Search order or customer…"), { target: { value: "acme" } });
      fireEvent.click(getByRole("button", { name: /refresh/i }));
    });
    await waitFor(() => expect(vi.mocked(listPromiseInbox)).toHaveBeenCalledTimes(2)); // mount + one manual refresh
  });
});
