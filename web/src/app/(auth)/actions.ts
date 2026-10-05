"use server";

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { prisma } from "@/lib/prisma";
import { signIn } from "@/lib/auth";
import { sendEmail, verificationEmail, passwordResetEmail } from "@/lib/email";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@/lib/validations/auth";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const TRIAL_DAYS = 14;

function makeToken() {
  return randomBytes(32).toString("hex");
}

function appUrl(path: string) {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base}${path}`;
}

async function issueVerificationEmail(userId: string, email: string, inviteToken?: string) {
  const token = makeToken();
  await prisma.verificationToken.create({
    data: { token, userId, expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
  });
  const verifyPath = inviteToken
    ? `/verify-email?token=${token}&invite=${inviteToken}`
    : `/verify-email?token=${token}`;
  const { subject, html } = verificationEmail(appUrl(verifyPath));
  await sendEmail({ to: email, subject, html });
}

export async function registerAction(input: unknown) {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const { name, companyName, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return {
      ok: false as const,
      fieldErrors: { email: ["An account with this email already exists"] },
    };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Every signup (no invite token) is a brand-new tenant: Enterprise = the
  // paying org, a default Site to hang Plants off of, and the registering
  // user becomes its OWNER on a 14-day Starter trial. Joining an *existing*
  // Enterprise via invite is out of scope for this pass.
  const user = await prisma.$transaction(async (tx) => {
    const enterprise = await tx.enterprise.create({
      data: {
        name: companyName,
        timezone: "UTC",
        currency: "USD",
        tier: "STARTER",
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
      },
    });
    await tx.site.create({
      data: { enterpriseId: enterprise.id, name: `${companyName} — Main Site`, timezone: "UTC" },
    });
    return tx.user.create({
      // No real mailbox exists to click a verification link from in this
      // environment (sendEmail's Resend path needs RESEND_API_KEY, which
      // isn't configured) — auto-verifying on signup removes a step that
      // was never actually going to complete rather than leaving a real
      // account stuck behind an email that can't arrive. The verification
      // flow itself (issueVerificationEmail, verifyEmailAction,
      // resendVerificationAction) stays intact for whenever a real mail
      // provider is wired up — this only changes what a fresh signup does.
      data: { name, email, passwordHash, enterpriseId: enterprise.id, role: "OWNER", emailVerified: new Date() },
    });
  });

  return { ok: true as const };
}

export async function loginAction(input: unknown) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: parsed.data.callbackUrl || "/",
    });
    return { ok: true as const };
  } catch (error) {
    if (error instanceof AuthError) {
      return { ok: false as const, formError: "Invalid email or password" };
    }
    throw error;
  }
}

export async function forgotPasswordAction(input: unknown) {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Always respond with success, whether or not the account exists, so this
  // endpoint can't be used to enumerate registered emails.
  if (user) {
    const token = makeToken();
    await prisma.passwordResetToken.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    const { subject, html } = passwordResetEmail(appUrl(`/reset-password?token=${token}`));
    await sendEmail({ to: user.email, subject, html });
  }

  return { ok: true as const };
}

export async function resetPasswordAction(input: unknown) {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const record = await prisma.passwordResetToken.findUnique({
    where: { token: parsed.data.token },
  });

  if (!record || record.expiresAt < new Date()) {
    return { ok: false as const, formError: "This reset link is invalid or has expired." };
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.delete({ where: { token: record.token } }),
  ]);

  return { ok: true as const };
}

export async function verifyEmailAction(token: string) {
  const record = await prisma.verificationToken.findUnique({ where: { token } });

  if (!record || record.expiresAt < new Date()) {
    return { ok: false as const, error: "This verification link is invalid or has expired." };
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { emailVerified: new Date() } }),
    prisma.verificationToken.delete({ where: { token: record.token } }),
  ]);

  return { ok: true as const };
}

export async function resendVerificationAction(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerified) {
    // Same non-enumeration reasoning as forgotPasswordAction.
    return { ok: true as const };
  }
  await prisma.verificationToken.deleteMany({ where: { userId: user.id } });
  await issueVerificationEmail(user.id, user.email);
  return { ok: true as const };
}
