"use client";

import type { ReactNode } from "react";

export type Column<T> = {
  header: string;
  render: (row: T) => ReactNode;
};

// The same panel/table shell already used on Approvals/Audit/Active
// Workflows, generalized so each business-flow channel page can define
// its own columns (the domains' fields are genuinely different — a
// Sales Order and a Consignment don't share a shape) without
// re-implementing the loading/empty/error states seven times.
export function RecordsTable<T>({
  title,
  subtitle,
  items,
  error,
  columns,
  rowKey,
  emptyMessage = "Nothing here yet.",
}: {
  title: string;
  subtitle?: string;
  items: T[] | null;
  error?: string | null;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
}) {
  return (
    <div className="panel">
      <div className="panel-title">{title}</div>
      <div className="panel-sub">
        {error
          ? undefined
          : subtitle ?? (items === null ? "Loading..." : `${items.length} record(s).`)}
      </div>

      {error && (
        <p className="panel-sub" style={{ color: "var(--alert)" }}>
          {error}
        </p>
      )}

      {items && items.length === 0 && (
        <p style={{ fontSize: 13, color: "var(--text-faint)" }}>{emptyMessage}</p>
      )}

      {items && items.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.header}>{col.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((col) => (
                    <td key={col.header}>{col.render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
