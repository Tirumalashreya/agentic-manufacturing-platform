import type { Metadata } from "next";
import Link from "next/link";
import { verifyEmailAction } from "@/app/(auth)/actions";
import { auth } from "@/lib/auth";
import { ResendVerificationForm } from "@/components/auth/ResendVerificationForm";
import { Button } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (token) {
    const result = await verifyEmailAction(token);

    if (!result.ok) {
      return (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <h1 className="text-lg font-semibold text-foreground">Verification failed</h1>
          <p className="mt-2 text-sm text-muted">{result.error}</p>
          <div className="mt-6">
            <ResendVerificationForm />
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-2xl border border-brand-200 bg-brand-50 p-8 text-center dark:border-brand-800 dark:bg-brand-900/30">
        <h1 className="text-lg font-semibold text-brand-800 dark:text-brand-200">
          Email verified
        </h1>
        <p className="mt-2 text-sm text-brand-700 dark:text-brand-300">
          Your email is confirmed. You&apos;re all set.
        </p>
        <Button href="/" variant="onBrand" className="mt-6">
          Continue
        </Button>
      </div>
    );
  }

  const session = await auth();
  const email = session?.user?.email;

  return (
    <div className="rounded-2xl border border-border bg-surface p-8 text-center">
      <h1 className="text-lg font-semibold text-foreground">Check your email</h1>
      <p className="mt-2 text-sm text-muted">
        We sent a verification link to {email ?? "your email address"}. Click it to activate
        your account.
      </p>
      <div className="mt-6 text-left">
        <ResendVerificationForm defaultEmail={email ?? undefined} />
      </div>
      {!email && (
        <p className="mt-6 text-sm text-muted">
          Already verified?{" "}
          <Link href="/login" className="font-medium text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      )}
    </div>
  );
}
