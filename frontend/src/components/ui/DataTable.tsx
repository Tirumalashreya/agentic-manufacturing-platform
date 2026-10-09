import type { ReactNode } from "react";
import { EmptyState } from "./States";

// Wraps the existing table.grid CSS (globals.css) — every page currently
// hand-writes its own <table className="grid"> markup (design-system pass,
// agreed with the user). Generic over row shape; a column just knows how
// to render one cell from one row, same shape most table-abstraction
// libraries use, but with zero new dependency.
export type Column<T> = {
  header: string;
  render: (row: T) => ReactNode;
  key: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle = "Nothing here yet.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyTitle?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} />;
  }
  return (
    // Phase 18 (Frontend UX & Visual Polish) — real gap found: a dense
    // operational table (the Promise Inbox renders 11 columns) had no
    // scroll container at all, so a narrow viewport either crushed every
    // column unreadably or broke the page's own layout by overflowing
    // it. A horizontal-scroll container keeps every column at a readable
    // width and scopes the scrollbar to the table, not the whole page.
    <div style={{ overflowX: "auto" }}>
      <table className="grid">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td key={col.key}>{col.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
