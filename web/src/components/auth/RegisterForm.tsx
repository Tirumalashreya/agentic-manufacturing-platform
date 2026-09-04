"use client";

import { useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { registerSchema, type RegisterInput } from "@/lib/validations/auth";
import { registerAction, loginAction } from "@/app/(auth)/actions";

type FieldErrors = Partial<Record<keyof RegisterInput, string>>;

export function RegisterForm() {
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite") ?? undefined;
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const formData = new FormData(event.currentTarget);
    const values = {
      name: String(formData.get("name") ?? ""),
      companyName: String(formData.get("companyName") ?? ""),
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      confirmPassword: String(formData.get("confirmPassword") ?? ""),
      inviteToken,
    };

    const parsed = registerSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors = parsed.error.flatten().fieldErrors;
      setErrors({
        name: fieldErrors.name?.[0],
        companyName: fieldErrors.companyName?.[0],
        email: fieldErrors.email?.[0],
        password: fieldErrors.password?.[0],
        confirmPassword: fieldErrors.confirmPassword?.[0],
      });
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await registerAction(parsed.data);
      if (!result.ok) {
        if (result.fieldErrors) {
          setErrors({
            name: result.fieldErrors.name?.[0],
            companyName: result.fieldErrors.companyName?.[0],
            email: result.fieldErrors.email?.[0],
            password: result.fieldErrors.password?.[0],
            confirmPassword: result.fieldErrors.confirmPassword?.[0],
          });
        }
        setFormError("Please fix the errors above and try again.");
        return;
      }

      // Registration succeeded — sign the user in immediately. They'll land
      // on /verify-email until they confirm their address (permissions.ts
      // enforces this on every protected route).
      const loginResult = await loginAction({
        email: parsed.data.email,
        password: parsed.data.password,
        callbackUrl: "/verify-email",
      });
      if (!loginResult.ok) {
        setFormError("Account created — please sign in.");
      }
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-8">
      <h1 className="text-xl font-semibold text-foreground">Create your account</h1>
      <p className="mt-1 text-sm text-muted">Start your 14-day free trial.</p>

      <form onSubmit={handleSubmit} noValidate className="mt-6 flex flex-col gap-4">
        <Input name="name" label="Full name" placeholder="Jane Doe" error={errors.name} />
        <Input name="companyName" label="Company name" placeholder="Acme Manufacturing" error={errors.companyName} />
        <Input name="email" type="email" label="Work email" placeholder="jane@company.com" error={errors.email} />
        <Input name="password" type="password" label="Password" error={errors.password} />
        <Input
          name="confirmPassword"
          type="password"
          label="Confirm password"
          error={errors.confirmPassword}
        />

        {formError && <p className="text-sm text-red-500">{formError}</p>}

        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? "Creating account..." : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
