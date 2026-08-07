"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { resendVerificationAction } from "@/app/(auth)/actions";

export function ResendVerificationForm({ defaultEmail }: { defaultEmail?: string }) {
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    if (!email) return;

    startTransition(async () => {
      await resendVerificationAction(email);
      setSent(true);
    });
  }

  if (sent) {
    return <p className="text-sm text-brand-700 dark:text-brand-300">Verification email sent — check your inbox.</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Input
        name="email"
        type="email"
        label="Email"
        defaultValue={defaultEmail}
        readOnly={!!defaultEmail}
        placeholder="jane@company.com"
      />
      <Button type="submit" disabled={isPending} variant="secondary">
        {isPending ? "Sending..." : "Resend verification email"}
      </Button>
    </form>
  );
}
