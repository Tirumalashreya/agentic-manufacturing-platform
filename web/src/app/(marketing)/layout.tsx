import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { Button } from "@/components/ui/Button";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
];

// See dashboard/page.tsx's getCurrentTime for why this is wrapped in an
// async function rather than called directly in the render body.
async function getCurrentYear(): Promise<number> {
  return new Date().getFullYear();
}

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const year = await getCurrentYear();
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <Container className="flex h-16 items-center justify-between">
          <Link href="/" className="text-lg font-bold tracking-tight text-foreground">
            APS Platform
          </Link>
          <nav className="hidden items-center gap-8 text-sm font-medium text-muted sm:flex">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="hover:text-foreground">
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <Button href="/login" variant="ghost" size="sm">
              Log in
            </Button>
            <Button href="/register" size="sm">
              Start free trial →
            </Button>
          </div>
        </Container>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border py-10">
        <Container className="flex flex-col items-center justify-between gap-4 text-sm text-muted sm:flex-row">
          <span className="font-semibold text-foreground">APS Platform</span>
          <span>© {year} APS Platform. All rights reserved.</span>
        </Container>
      </footer>
    </div>
  );
}
