// New shared patterns (design-system pass, agreed with the user) — several
// existing fetchers already distinguish a real "service unavailable" error
// from a real empty result (this session's discoverability pass fixed
// several of these), but every page rendered that distinction with its own
// one-off text. Three consistent components instead.

export function EmptyState({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {description && <p className="mt-1 text-xs text-muted/70">{description}</p>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description }: { title?: string; description?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3">
      <p className="text-sm font-semibold text-danger">⚠ {title}</p>
      {description && <p className="mt-1 text-xs text-foreground/80">{description}</p>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="px-4 py-8 text-center text-sm text-muted">{label}</div>;
}
