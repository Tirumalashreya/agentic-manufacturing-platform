import Link from "next/link";

// New — no page currently has a "you are here" trail (confirmed absent in
// this session's own discoverability audit of Ledger). Deliberately plain
// text, no icons, matching the calm/spacious direction.
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-faint)", marginBottom: 10 }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span aria-hidden>/</span>}
          {item.href ? (
            <Link href={item.href} style={{ color: "var(--text-soft)" }}>
              {item.label}
            </Link>
          ) : (
            <span style={{ color: "var(--text-faint)" }}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
