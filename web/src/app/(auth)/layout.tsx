export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-8 px-6 py-16">
      <span className="text-lg font-semibold tracking-tight text-foreground">Enterprise Manufacturing APS</span>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
