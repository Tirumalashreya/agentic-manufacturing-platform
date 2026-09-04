"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { resetPasswordSchema } from "@/lib/validations/auth";
import { resetPasswordAction } from "@/app/(auth)/actions";

export function ResetPasswordForm({ token }: { token: string }) {
  const [errors, setErrors] = useState<{ password?: string; confirmPassword?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const formData = new FormData(event.currentTarget);
    const values = {
      token,
      password: String(formData.get("password") ?? ""),
      confirmPassword: String(formData.get("confirmPassword") ?? ""),
    };

    const parsed = resetPasswordSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setErrors({
        password: fieldErrors.password?.[0],
        confirmPassword: fieldErrors.confirmPassword?.[0],
      });
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await resetPasswordAction(parsed.data);
      if (!result.ok) {
        setFormError(result.formError ?? "Something went wrong. Please try again.");
        return;
      }
      setSuccess(true);
    });
  }

  if (success) {
    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50 p-8 text-center dark:border-brand-800 dark:bg-brand-900/30">
        <h1 className="text-lg font-semibold text-brand-800 dark:text-brand-200">
          Password updated
        </h1>
        <p className="mt-2 text-sm text-brand-700 dark:text-brand-300">
          Your password has been reset. You can now sign in.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-8">
      <h1 className="text-xl font-semibold text-foreground">Set a new password</h1>

      <form onSubmit={handleSubmit} noValidate className="mt-6 flex flex-col gap-4">
        <Input name="password" type="password" label="New password" error={errors.password} />
        <Input
          name="confirmPassword"
          type="password"
          label="Confirm new password"
          error={errors.confirmPassword}
        />

        {formError && <p className="text-sm text-red-500">{formError}</p>}

        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? "Saving..." : "Reset password"}
        </Button>
      </form>
    </div>
  );
}
