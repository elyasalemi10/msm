"use server";

import { requireCompanyRole } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";
import {
  isValidUsername,
  isWithinCooldown,
  managerEmailAddress,
  USERNAME_CHANGE_COOLDOWN_DAYS,
} from "@/lib/manager-username";
import {
  findAvailableUsername,
  isUsernameAvailable,
} from "@/lib/manager-username-server";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// Returns the signed-in manager's outbound email address (e.g.
// "max.smith@stratawise.com.au"). Lazy-creates the username if missing so the
// returned value is always sendable.
export async function getManagerSendAddress(): Promise<{ address: string } | { address: null }> {
  const created = await ensureManagerUsername();
  if (!created.ok) return { address: null };
  const addr = managerEmailAddress(created.data.username);
  return { address: addr ?? null };
}

// Returns the SMS sender id the platform sends from (the value we feed to
// Mobile Message). Used by the communications-tab SMS detail dialog so the
// "From" row matches the value that landed on the recipient's handset.
export async function getSmsSenderId(): Promise<{ sender: string | null }> {
  await requireCompanyRole();
  const sender = process.env.MOBILE_MESSAGE_SENDER_ID ?? null;
  return { sender };
}

/**
 * Returns every email inbox the signed-in manager could plausibly send
 * "from". Two sources:
 *   1. Their StrataWise default <username>@stratawise.com.au.
 *   2. Any Gmail mailbox subscriptions configured for their firm.
 *
 * The first entry in the returned array is the default selection (a
 * connected custom inbox if any, otherwise the StrataWise fallback).
 * Used by the lot communications "Send email" composer dropdown.
 */
export async function listManagerInboxes(): Promise<Array<{ email: string; kind: "stratawise" | "gmail" }>> {
  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const [stratawise, { data: gmailSubs }] = await Promise.all([
    getManagerSendAddress(),
    supabase
      .from("gmail_mailbox_subscriptions")
      .select("mailbox_email")
      .eq("management_company_id", profile.management_company_id),
  ]);

  const out: Array<{ email: string; kind: "stratawise" | "gmail" }> = [];
  // Connected mailboxes first (the "custom" inboxes the user wants to default to).
  for (const row of (gmailSubs ?? []) as Array<{ mailbox_email: string }>) {
    if (row.mailbox_email) out.push({ email: row.mailbox_email, kind: "gmail" });
  }
  if (stratawise.address) out.push({ email: stratawise.address, kind: "stratawise" });

  // Dedupe.
  const seen = new Set<string>();
  return out.filter((o) => {
    const k = o.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Ensures the signed-in manager has an email_username. Idempotent , no-op when one
// already exists. Run lazily from places that need the address (e.g. before sending
// an outbound email from this manager).
export async function ensureManagerUsername(): Promise<Result<{ username: string }>> {
  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const { data: row, error: fetchErr } = await supabase
    .from("profiles")
    .select("id, email_username, first_name, last_name")
    .eq("id", profile.id)
    .single();
  if (fetchErr || !row) return { ok: false, error: "Profile not found" };
  if (row.email_username) return { ok: true, data: { username: row.email_username } };

  const candidate = await findAvailableUsername(row.first_name, row.last_name);
  if (!candidate) {
    return {
      ok: false,
      error: "Could not derive a username from your name , please set one in settings.",
    };
  }

  const { error: updErr } = await supabase
    .from("profiles")
    .update({
      email_username: candidate,
      email_username_changed_at: new Date().toISOString(),
    })
    .eq("id", profile.id);
  if (updErr) return { ok: false, error: "Failed to set username" };

  await logAudit({
    profileId: profile.id,
    action: "create",
    entityType: "profile_username",
    entityId: profile.id,
    after: { email_username: candidate, derived: true },
    metadata: { source: "auto-onboarding" },
  });

  return { ok: true, data: { username: candidate } };
}

export async function checkUsernameAvailable(
  candidate: string,
): Promise<Result<{ available: boolean }>> {
  await requireCompanyRole();
  if (!isValidUsername(candidate)) {
    return { ok: false, error: "Use 3-40 lowercase letters, numbers, dots, dashes, or underscores." };
  }
  return { ok: true, data: { available: await isUsernameAvailable(candidate) } };
}

export async function renameManagerUsername(
  newUsername: string,
): Promise<Result<{ username: string }>> {
  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  if (!isValidUsername(newUsername)) {
    return {
      ok: false,
      error: "Use 3-40 lowercase letters, numbers, dots, dashes, or underscores.",
    };
  }

  const { data: row, error: fetchErr } = await supabase
    .from("profiles")
    .select("id, email_username, email_username_changed_at")
    .eq("id", profile.id)
    .single();
  if (fetchErr || !row) return { ok: false, error: "Profile not found" };

  if (row.email_username && row.email_username.toLowerCase() === newUsername.toLowerCase()) {
    return { ok: true, data: { username: row.email_username } };
  }

  if (isWithinCooldown(row.email_username_changed_at)) {
    return {
      ok: false,
      error: `You can only change your username once every ${USERNAME_CHANGE_COOLDOWN_DAYS} days.`,
    };
  }

  if (!(await isUsernameAvailable(newUsername))) {
    return { ok: false, error: "That username is taken." };
  }

  const previous = row.email_username;
  const { error: updErr } = await supabase
    .from("profiles")
    .update({
      email_username: newUsername,
      email_username_changed_at: new Date().toISOString(),
    })
    .eq("id", profile.id);
  if (updErr) return { ok: false, error: "Failed to update username" };

  // Forward old username so legacy inbound mail still reaches this manager.
  if (previous) {
    const { error: aliasErr } = await supabase.from("profile_username_aliases").insert({
      username: previous,
      profile_id: profile.id,
    });
    if (aliasErr) {
      console.error("[manager-username] failed to persist alias:", aliasErr.message);
    }
  }

  await logAudit({
    profileId: profile.id,
    action: "update",
    entityType: "profile_username",
    entityId: profile.id,
    before: { email_username: previous },
    after: { email_username: newUsername },
  });

  return { ok: true, data: { username: newUsername } };
}
