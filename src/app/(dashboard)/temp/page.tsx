import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { EnvDump, type EnvEntry } from "./env-dump";

// ============================================================================
// TEMPORARY , environment recovery page.
// ----------------------------------------------------------------------------
// Vercel marks most of this project's variables as "Sensitive", which makes
// them write-only: `vercel env pull`, the REST API and the dashboard all
// return "[SENSITIVE]" rather than the value. The running deployment is the
// only place those values can still be read, which is what this page is for.
//
// DELETE THIS ROUTE once the values are back in .env.local, and rotate every
// credential it displayed. It is gated on super_admin, but a page that prints
// the service-role key and the TFN encryption key should not outlive the
// recovery it was built for.
// ============================================================================

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Environment",
  robots: { index: false, follow: false, nocache: true },
};

// The variables the application actually reads. Anything not on this list is
// not consulted anywhere in the codebase.
const KEYS = [
  // Supabase
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  // App
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SENDER_DOMAIN",
  // Cloudflare R2
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_PUBLIC",
  "R2_BUCKET_CONFIDENTIAL",
  "R2_PUBLIC_URL",
  // Resend
  "RESEND_API_KEY",
  "RESEND_SUFFIX",
  "RESEND_INBOUND_WEBHOOK_SECRET",
  "RESEND_WEBHOOK_SECRET",
  "SEND_TO",
  // Gmail
  "GMAIL_SERVICE_ACCOUNT_JSON",
  "GMAIL_OAUTH_CLIENT_ID",
  "GMAIL_PUBSUB_TOPIC",
  "GMAIL_PUBSUB_VERIFY_TOKEN",
  // SMS
  "MOBILE_MESSAGE_USERNAME",
  "MOBILE_MESSAGE_API_KEY",
  "MOBILE_MESSAGE_SENDER_ID",
  // Google AI
  "GEMINI_API_KEY",
  "GOOGLE_DOCUMENT_AI_PROCESSOR_ID",
  "GOOGLE_DOCUMENT_AI_LOCATION",
  "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
  // Other integrations
  "TFN_ENCRYPTION_KEY",
  "ABR_GUID",
  "ELEVEN_LABS_API_KEY",
  "ELEVEN_LABS_VOICE_ID",
  // Background jobs
  "CRON_SECRET",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_PROJECT_ID",
] as const;

export default async function TempEnvPage() {
  await requireRole(["super_admin"]);

  const entries: EnvEntry[] = KEYS.map((key) => {
    const raw = process.env[key];
    return { key, value: raw === undefined || raw === "" ? null : raw };
  });

  return (
    <div className="space-y-6 px-4 py-4 md:px-6 md:py-6">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <h1 className="text-base font-semibold text-destructive">
          Temporary recovery page
        </h1>
        <p className="mt-1 text-sm text-foreground">
          This prints live production credentials in plain text. Copy what you
          need, then delete this route and rotate every key shown here.
        </p>
      </div>

      <EnvDump entries={entries} />
    </div>
  );
}
