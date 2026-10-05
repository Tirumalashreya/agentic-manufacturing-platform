import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";

// SAP Fiori / enterprise-blue theme: one clean sans-serif throughout
// (display headings just use a heavier Inter weight) instead of the
// earlier serif display font, which read as editorial/publication
// rather than enterprise software.
const inter = Inter({
  variable: "--font-body-override",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono-override",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Ledger — Sales Operations Console",
  description: "Live demo UI for the agent-orchestrator sales workflow.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body>
        <TopBar />
        <div id="shell">
          <Sidebar />
          <main id="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
