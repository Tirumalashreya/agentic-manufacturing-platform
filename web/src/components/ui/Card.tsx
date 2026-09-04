import { cn } from "@/lib/cn";

export function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-surface p-6 transition-shadow duration-200 hover:shadow-lg hover:shadow-brand-900/[0.06]",
        className
      )}
    >
      {children}
    </div>
  );
}
