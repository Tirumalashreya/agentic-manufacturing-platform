import { Resend } from "resend";

type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
};

const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const FROM_ADDRESS = process.env.EMAIL_FROM || "Structa Cloud <onboarding@resend.dev>";

/**
 * Always logs to the server console — this is how local dev/tests read
 * verification, reset, and invite links without a real inbox. When
 * RESEND_API_KEY is set, it *additionally* sends a real email via Resend.
 * Without a key, this stays a pure stub (matches original dev behavior).
 */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  console.log(
    `\n--- [dev email] ---\nTo: ${to}\nSubject: ${subject}\n${html}\n--------------------\n`
  );

  if (!resend) return;

  const { error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html });
  if (error) {
    // Deliberately not thrown: the underlying action (registration, invite,
    // password reset) has already succeeded and its token already exists —
    // failing the whole request because delivery failed would be worse than
    // falling back to the console-logged link.
    console.error(`Failed to send email via Resend to ${to}:`, error);
  }
}

export function verificationEmail(link: string) {
  return {
    subject: "Verify your Structa Cloud email",
    html: `<p>Confirm your email to finish setting up your account.</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours.</p>`,
  };
}

export function passwordResetEmail(link: string) {
  return {
    subject: "Reset your Structa Cloud password",
    html: `<p>Click the link below to reset your password.</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
  };
}

export function organizationInviteEmail(orgName: string, link: string) {
  return {
    subject: `You've been invited to ${orgName} on Structa Cloud`,
    html: `<p>You've been invited to join <strong>${orgName}</strong> on Structa Cloud.</p><p><a href="${link}">${link}</a></p><p>This invitation expires in 7 days.</p>`,
  };
}
