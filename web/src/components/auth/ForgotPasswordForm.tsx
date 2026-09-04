"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { forgotPasswordSchema } from "@/lib/validations/auth";
import { forgotPasswordAction } from "@/app/(auth)/actions";

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const values = { email: String(formData.get("email") ?? "") };

    const parsed = forgotPasswordSchema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.flatten().fieldErrors.email?.[0]);
      return;
    }
    setError(undefined);

    startTransition(async () => {
      await forgotPasswordAction(parsed.data);
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50 p-8 text-center dark:border-brand-800 dark:bg-brand-900/30">
        <h1 className="text-lg font-semibold text-brand-800 dark:text-brand-200">
          Check your email
        </h1>
        <p className="mt-2 text-sm text-brand-700 dark:text-brand-300">
          If an account exists for that email, we&apos;ve sent a link to reset your password.
        </p>
        <Link href="/login" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-8">
      <h1 className="text-xl font-semibold text-foreground">Forgot your password?</h1>
      <p className="mt-1 text-sm text-muted">
        Enter your email and we&apos;ll send you a reset link.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-6 flex flex-col gap-4">
        <Input name="email" type="email" label="Email" placeholder="jane@company.com" error={error} />
        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? "Sending..." : "Send reset link"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
