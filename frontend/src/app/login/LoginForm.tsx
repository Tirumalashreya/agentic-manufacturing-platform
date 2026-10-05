"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";
import { loginAction } from "./actions";

// Auth/Authz hardening, Phase 1 (Finding 1.6) — Ledger's first login form,
// styled with the existing shared component set (no new visual design
// introduced — Button + this page's own plain form fields, matching the
// established .field/.panel classes every other Ledger page already uses).
export function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    startTransition(async () => {
      const result = await loginAction(email, password, callbackUrl);
      if (!result.ok) setFormError(result.formError);
    });
  }

  return (
    <div className="panel" style={{ maxWidth: 380, margin: "80px auto" }}>
      <div className="panel-title">Sign in</div>
      <p className="panel-sub">Real Ledger access — no login existed here before this.</p>

      <form onSubmit={handleSubmit} className="field" style={{ marginTop: 16 }}>
        <label>EMAIL</label>
        <input name="email" type="email" autoComplete="email" required />

        <label style={{ marginTop: 12 }}>PASSWORD</label>
        <input name="password" type="password" autoComplete="current-password" required />

        {formError && (
          <p style={{ color: "var(--alert)", fontSize: 12.5, marginTop: 10 }}>{formError}</p>
        )}

        <div className="btn-row" style={{ marginTop: 16 }}>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>
    </div>
  );
}
