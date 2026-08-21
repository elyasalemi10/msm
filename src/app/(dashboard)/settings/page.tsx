import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";
import { getCompanyData } from "./actions";
import { getTeamMembers } from "@/lib/actions/team";
import { createServerClient } from "@/lib/supabase";
import { brandDomain } from "@/lib/manager-username";
import { SettingsTabs } from "./settings-tabs";

export interface NotificationPrefRow {
  notification_type: string;
  channel: "email" | "in_app" | "sms" | "voice" | "letter";
  enabled: boolean;
}

export interface AutoOptOutEntry {
  type: string;
  channel: "email" | "in_app";
  occurredAt: string;
}

export default async function SettingsPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/sign-in");

  const isManager = profile.role === "strata_manager" || profile.role === "super_admin";
  const supabase = createServerClient();

  // PP6-D-B: server-fetch notification preferences + auto-opt-out
  // detection. Notifications tab receives both as props (settings-tabs
  // pattern: server component supplies, client tabs render).
  const [
    company,
    teamMembers,
    prefsResult,
    optOutAuditsResult,
    mailProviderResult,
    mailboxSubResult,
    managerUsernameResult,
  ] = await Promise.all([
    isManager ? getCompanyData() : Promise.resolve(null),
    isManager ? getTeamMembers() : Promise.resolve([]),
    supabase
      .from("notification_preferences")
      .select("notification_type, channel, enabled")
      .eq("profile_id", profile.id),
    supabase
      .from("audit_log")
      .select("metadata, created_at")
      .eq("profile_id", profile.id)
      .eq("action", "communication.opt_out_auto")
      .order("created_at", { ascending: false }),
    isManager && profile.management_company_id
      ? supabase
          .from("management_companies")
          .select(
            "mail_provider, mail_provider_config, mail_provider_configured_at",
          )
          .eq("id", profile.management_company_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    isManager
      ? supabase
          .from("gmail_mailbox_subscriptions")
          .select("mailbox_email, last_error")
          .eq("manager_profile_id", profile.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    isManager
      ? supabase
          .from("profiles")
          .select("email_username")
          .eq("id", profile.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const mailRow = (mailProviderResult.data ?? null) as {
    mail_provider: "stratawise" | "gmail";
    mail_provider_config: { domain?: string } | null;
    mail_provider_configured_at: string | null;
  } | null;
  const mailProvider = {
    provider: mailRow?.mail_provider ?? ("stratawise" as const),
    domain: mailRow?.mail_provider_config?.domain ?? null,
    configured_at: mailRow?.mail_provider_configured_at ?? null,
  };

  // Derive the manager's current mailbox prefix (the part before "@") from
  // their gmail_mailbox_subscriptions row, if any. Lets the Email tab
  // pre-fill the prefix input on revisit.
  const subRow = (mailboxSubResult.data as { mailbox_email: string | null; last_error: string | null } | null) ?? null;
  const subMailbox = subRow?.mailbox_email ?? null;
  const initialMailboxPrefix = subMailbox?.split("@")[0] ?? "";

  // Auth-shaped errors persisted by the gmail-push webhook (or watch-refresh
  // cron) indicate the Workspace admin revoked our DWD entry , surface a
  // banner so the manager knows to re-add it instead of silently going dark.
  const dwdRevoked = !!subRow?.last_error && /unauthorized|invalid_grant|forbidden|401|403/i.test(subRow.last_error);
  const mailboxIntegrationError = subRow?.last_error ?? null;

  // The always-on StrataWise alias every onboarded manager has ,
  // <email_username>@stratawise.com.au , used as the fallback when they
  // disconnect their own mailbox.
  const managerUsername =
    (managerUsernameResult.data as { email_username: string | null } | null)
      ?.email_username ?? null;
  const stratawiseFallbackEmail = managerUsername
    ? `${managerUsername}@${brandDomain()}`
    : `noreply@${brandDomain()}`;

  // Surface the GCP service-account Client ID (the 21-digit number
  // customers paste into their Google Workspace admin) so the Email tab
  // can render it inline + with a copy button. Null when Gmail integration
  // isn't configured yet , the tab swaps to a "coming soon" callout.
  const gmailOauthClientId = process.env.GMAIL_OAUTH_CLIENT_ID ?? null;

  const currentPreferences = (prefsResult.data ?? []) as NotificationPrefRow[];

  // Most-recent-per-(type, channel) dedup. Lifetime auto-opt-outs per
  // profile are bounded by 13 types × 2 channels = 26 rows, linear scan
  // is fine.
  const autoOptOutMap = new Map<string, AutoOptOutEntry>();
  for (const r of optOutAuditsResult.data ?? []) {
    const meta = (r as { metadata: { notification_type?: string; channel?: string } }).metadata;
    const t = meta.notification_type;
    const c = meta.channel;
    if (!t || !c || (c !== "email" && c !== "in_app")) continue;
    const key = `${t}:${c}`;
    if (!autoOptOutMap.has(key)) {
      autoOptOutMap.set(key, {
        type: t,
        channel: c,
        occurredAt: (r as { created_at: string }).created_at,
      });
    }
  }
  const autoOptOuts = Array.from(autoOptOutMap.values());

  return (
    <SettingsTabs
      profile={profile}
      company={company}
      teamMembers={teamMembers}
      currentPreferences={currentPreferences}
      autoOptOuts={autoOptOuts}
      mailProvider={mailProvider}
      gmailOauthClientId={gmailOauthClientId}
      initialMailboxPrefix={initialMailboxPrefix}
      stratawiseFallbackEmail={stratawiseFallbackEmail}
      dwdRevoked={dwdRevoked}
      mailboxIntegrationError={mailboxIntegrationError}
    />
  );
}
