import Link from "next/link";

// Every channel page used to embed its own full copy of the request ->
// pipeline -> timeline flow (ChannelRequestForm), even though it's the
// exact same backend call Agent Console makes — just with a thinner
// result view. That's one engine wearing 7 near-identical skins for no
// real benefit once Agent Console exists as the actual "show your work"
// experience. This links out to it instead, prefilling the draft so the
// channel's own example prompts still do something.
export function NewRequestBanner({ examples }: { examples: string[] }) {
  return (
    <div className="panel">
      <div className="panel-title">New request</div>
      <div className="panel-sub">
        Requests for this channel run through the same AI pipeline as every other channel — open
        Agent Console to see it work stage by stage, with human approval before anything is created.
      </div>
      <div className="btn-row" style={{ marginTop: 0, flexWrap: "wrap" }}>
        {examples.map((ex) => (
          <Link key={ex} href={`/agent-console?draft=${encodeURIComponent(ex)}`} className="btn secondary">
            {ex.length > 60 ? ex.slice(0, 57) + "…" : ex}
          </Link>
        ))}
      </div>
      <div className="btn-row">
        <Link href="/agent-console" className="btn">
          Open Agent Console →
        </Link>
      </div>
    </div>
  );
}
