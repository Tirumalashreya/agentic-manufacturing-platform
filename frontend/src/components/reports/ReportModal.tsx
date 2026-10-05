"use client";

import type { ReportDoc } from "@/lib/reports";

export default function ReportModal({ report, onClose }: { report: ReportDoc; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(24, 43, 58, 0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        overflowY: "auto",
        padding: "40px 16px",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        className="report-printable"
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          maxWidth: 620,
          width: "100%",
          padding: "30px 34px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-faint)", letterSpacing: 0.5 }}>
              {report.docType}
            </div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600, color: "var(--text)" }}>
              {report.docNumber}
            </div>
          </div>
          {report.statusChip && (
            <span className={`chip ${report.statusChip.tone}`} style={{ fontSize: 11 }}>
              {report.statusChip.label}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 20 }}>
          Generated {report.generatedAt}
        </div>

        <div className="kv-grid" style={{ marginBottom: 18 }}>
          {report.meta.map((row) => (
            <div className="kv" key={row.label}>
              <div className="kv-label">{row.label.toUpperCase()}</div>
              <div className="kv-value" style={{ fontSize: 14.5, wordBreak: "break-word" }}>
                {row.value}
              </div>
            </div>
          ))}
        </div>

        {report.sections.map((section) => (
          <div key={section.heading} style={{ marginBottom: 18 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 13.5, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
              {section.heading}
            </div>
            <table className="grid">
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.label}>
                    <td style={{ color: "var(--text-soft)" }}>{row.label}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {row.value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {report.table && (
          <div style={{ marginBottom: 18 }}>
            <table className="grid">
              <thead>
                <tr>
                  {report.table.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className={j === 0 ? undefined : "mono"} style={j > 0 ? { textAlign: "right" } : undefined}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {report.totalsRow && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "10px 12px",
              background: "var(--money-soft)",
              borderRadius: 6,
              marginBottom: 18,
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--text)" }}>{report.totalsRow.label}</span>
            <span className="mono" style={{ fontWeight: 600, color: "var(--money)" }}>
              {report.totalsRow.value}
            </span>
          </div>
        )}

        <p style={{ fontSize: 11, color: "var(--text-faint)", borderTop: "1px solid var(--line)", paddingTop: 12, marginBottom: 20 }}>
          {report.footerNote}
        </p>

        <div className="btn-row no-print" style={{ marginTop: 0 }}>
          <button type="button" className="btn" onClick={() => window.print()}>
            Print / Save as PDF
          </button>
          <button type="button" className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
