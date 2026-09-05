import Link from "next/link";

export default function Dashboard() {
  return (
    <>
      <div className="doc-header">
        <div className="doc-kicker">SALES OPERATIONS</div>
        <div className="doc-title">Command centre</div>
        <div className="doc-desc">
          One view across every channel the business sells through. This is the first working
          slice — a real request runs through the actual intent → context → process → fulfillment
          pipeline. The channel views and live metrics below come next.
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Start a new request</div>
        <div className="panel-sub">
          Describe what the customer needs in plain language — the system figures out the rest.
        </div>
        <Link href="/request" className="btn">
          New Request →
        </Link>
      </div>

      <div className="panel">
        <div className="panel-title">Business flows</div>
        <div className="panel-sub">
          Domestic, Export, Services, Returns, Consignment, Project and Trading all have real
          workflows in the backend today. Dedicated channel views for each are next — for now,
          run any of them through New Request.
        </div>
        <div className="dash-grid">
          {[
            ["DOM·01", "Domestic Sales"],
            ["EXP·02", "Export Sales"],
            ["SVC·03", "Services Sales"],
            ["RET·04", "Returns"],
            ["CON·05", "Consignment Sales"],
            ["PRJ·06", "Project Sales"],
            ["TRD·07", "Trading"],
          ].map(([code, title]) => (
            <div className="dash-card" key={code}>
              <div className="dash-code">{code}</div>
              <div className="dash-title">{title}</div>
              <span className="chip neutral">Channel view coming soon</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
