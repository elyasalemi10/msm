"use server";

import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { revalidatePath } from "next/cache";
import { sendInvitationEmail } from "@/lib/email";
import { resolveCompanyLogo } from "@/lib/notifications";
import { generateInviteCode } from "@/lib/invite-code";

type LotOwnerInput = {
  name: string;
  email?: string | null;
  phone?: string | null;
};

async function ensureNotAccepted(
  supabase: ReturnType<typeof createServerClient>,
  lotId: string,
) {
  const { data } = await supabase
    .from("invitations")
    .select("id")
    .eq("lot_id", lotId)
    .eq("status", "accepted")
    .maybeSingle();
  return !data;
}

async function findOpenInvitation(
  supabase: ReturnType<typeof createServerClient>,
  lotId: string,
) {
  // "Open" = pre-acceptance: either noted (saved, no email sent) or pending
  // (invite email sent, awaiting accept). Either is reusable on edit/resend.
  const { data } = await supabase
    .from("invitations")
    .select("id, token, email, status")
    .eq("lot_id", lotId)
    .in("status", ["pending", "noted"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/**
 * Save owner contact details for a lot without sending any email. Reuses
 * the existing pending invitation row if one exists; otherwise creates a
 * new pending row with no token consumption (the token still gets minted
 * for forward compatibility but the row stays "noted" until inviteLotOwner
 * is called).
 */
export async function updateLotOwnerDetails(
  ocId: string,
  lotId: string,
  data: LotOwnerInput,
) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);

  const supabase = createServerClient();

  if (!(await ensureNotAccepted(supabase, lotId))) {
    return { error: "This lot already has an accepted owner" };
  }

  const name = data.name.trim();
  if (!name) return { error: "Name is required" };
  const email = data.email?.trim() || null;
  const phone = data.phone?.trim() || null;

  const existing = await findOpenInvitation(supabase, lotId);

  if (existing) {
    // Don't downgrade status: a row that's already 'pending' (email sent)
    // stays 'pending' on edit. Only contact details are refreshed.
    const { error } = await supabase
      .from("invitations")
      .update({ name, email, phone, invited_by: profile.id })
      .eq("id", existing.id);
    if (error) return { error: error.message };

    await supabase.from("audit_log").insert({
      profile_id: profile.id,
      oc_id: ocId,
      action: "update",
      entity_type: "invitation",
      entity_id: existing.id,
      after_state: { name, email, lot_id: lotId, status: existing.status },
    });
  } else {
    // No open row yet: create a 'noted' row. No email goes out and the
    // status badge will reflect "Owner noted" until inviteLotOwner runs.
    const { data: created, error } = await supabase
      .from("invitations")
      .insert({
        oc_id: ocId,
        lot_id: lotId,
        email,
        name,
        phone,
        role: "lot_owner",
        status: "noted",
        invited_by: profile.id,
      })
      .select("id")
      .single();
    if (error || !created) return { error: error?.message ?? "Failed to save owner" };

    await supabase.from("audit_log").insert({
      profile_id: profile.id,
      oc_id: ocId,
      action: "create",
      entity_type: "invitation",
      entity_id: created.id,
      after_state: { name, email, lot_id: lotId, status: "noted" },
    });
  }

  revalidatePath("/ocs/[ocCode]/manage", "page");
  return { success: true };
}

export async function inviteLotOwner(
  ocId: string,
  lotId: string,
  data: { email: string; name: string; phone?: string },
) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);

  if (!data.email?.trim()) {
    return { error: "Email is required to send an invitation" };
  }

  const supabase = createServerClient();

  if (!(await ensureNotAccepted(supabase, lotId))) {
    return { error: "This lot already has an accepted invitation" };
  }

  // Reuse any open invitation row for this lot (noted from setup or a
  // prior save, or pending from a previous send). Flip to 'pending' here
  // since we're now sending the email. Refresh contact fields + expiry.
  const existingOpen = await findOpenInvitation(supabase, lotId);

  let invitation: { id: string; code: string };
  let isResend = false;

  if (existingOpen) {
    const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("invitations")
      .update({
        email: data.email,
        name: data.name,
        phone: data.phone || null,
        status: "pending",
        invited_by: profile.id,
        expires_at: newExpiry,
      })
      .eq("id", existingOpen.id)
      .select("id, code")
      .single();

    if (updateError || !updated) return { error: updateError?.message ?? "Failed to update invitation" };
    invitation = updated;
    isResend = true;
  } else {
    const { data: created, error } = await supabase
      .from("invitations")
      .insert({
        oc_id: ocId,
        lot_id: lotId,
        email: data.email,
        name: data.name,
        phone: data.phone || null,
        role: "lot_owner",
        invited_by: profile.id,
        code: generateInviteCode(),
      })
      .select("id, code")
      .single();

    if (error || !created) return { error: error?.message ?? "Failed to create invitation" };
    invitation = created;
  }

  // Audit log
  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: isResend ? "update" : "create",
    entity_type: "invitation",
    entity_id: invitation.id,
    after_state: { email: data.email, name: data.name, lot_id: lotId, resend: isResend, sent: true },
  });

  // Send invitation email
  const { data: sub } = await supabase
    .from("owners_corporations")
    .select("name, address")
    .eq("id", ocId)
    .single();

  const { data: lot } = await supabase
    .from("lots")
    .select("lot_number")
    .eq("id", lotId)
    .single();

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || "http://localhost:3002";
  const inviteUrl = `${baseUrl}/invite/${invitation.code}`;
  const companyLogoUrl = await resolveCompanyLogo(supabase, {
    ocId,
  });
  await sendInvitationEmail({
    to: data.email,
    inviteeName: data.name,
    role: "lot_owner",
    ocName: sub?.name ?? "Your oc",
    ocAddress: sub?.address ?? "",
    lotNumber: lot?.lot_number ?? null,
    inviteUrl,
    companyLogoUrl,
    ocId,
    inviterProfileId: profile.id,
  });

  revalidatePath("/ocs/[ocCode]/manage", "page");

  return { success: true, code: invitation.code };
}

/**
 * Bulk-invite every eligible lot owner in one go from the Lots page Tools
 * dropdown. Re-uses `inviteLotOwner` per row so the audit log + email
 * dispatch + invitation row handling stays single-sourced. Skips rows
 * without an email; treats lots with an accepted invite as already-done.
 *
 * Returns a tally so the toast can summarise: "Sent N, skipped M, K
 * failed". Errors are collected but don't abort the rest of the batch ,
 * one bad lot shouldn't poison the whole sweep.
 */
export async function bulkInviteLotOwners(
  ocId: string,
  invites: Array<{ lotId: string; email: string; name: string; phone?: string | null }>,
): Promise<{ sent: number; skipped: number; failed: number; errors: string[] }> {
  await requireCompanyRole();
  await requireOCAccess(ocId);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of invites) {
    if (!row.email?.trim() || !row.name?.trim()) {
      skipped++;
      continue;
    }
    const r = await inviteLotOwner(ocId, row.lotId, {
      email: row.email,
      name: row.name,
      phone: row.phone ?? undefined,
    });
    if ("error" in r && r.error) {
      failed++;
      errors.push(`Lot ${row.lotId}: ${r.error}`);
    } else {
      sent++;
    }
  }

  return { sent, skipped, failed, errors };
}

/** Fetch the most recent invitation row for a single lot so the invite-
 *  status popover on /lots can render a timeline (sent / expires) + the
 *  contact details captured at the time. Returns null when no row exists
 *  (= "Not invited"). Caller maps the status to UI variants. */
export async function getLotInvitation(
  ocId: string,
  lotId: string,
): Promise<{
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  status: "noted" | "pending" | "accepted" | "expired" | "revoked";
  created_at: string;
  expires_at: string | null;
} | null> {
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data } = await supabase
    .from("invitations")
    .select("id, email, name, phone, status, created_at, expires_at")
    .eq("oc_id", ocId)
    .eq("lot_id", lotId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    id: data.id,
    email: data.email,
    name: data.name,
    phone: data.phone,
    status: data.status,
    created_at: data.created_at,
    expires_at: data.expires_at,
  };
}

/** Returns the full invite history for a lot (most-recent first). Used by
 *  the invite-status popup so the manager can see every send, expiry,
 *  acceptance and revocation against this lot in one place. */
export async function getLotInvitationHistory(
  ocId: string,
  lotId: string,
): Promise<Array<{
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  status: "noted" | "pending" | "accepted" | "expired" | "revoked";
  created_at: string;
  expires_at: string | null;
}>> {
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data } = await supabase
    .from("invitations")
    .select("id, email, name, phone, status, created_at, expires_at")
    .eq("oc_id", ocId)
    .eq("lot_id", lotId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (data ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  }));
}

export async function getLotInvitationStatus(ocId: string, lotIds: string[]) {
  const supabase = createServerClient();

  const { data } = await supabase
    .from("invitations")
    .select("lot_id, status")
    .eq("oc_id", ocId)
    .in("lot_id", lotIds)
    .in("status", ["noted", "pending", "accepted"]);

  // Precedence when a lot has multiple rows: accepted > pending > noted.
  const rank: Record<string, number> = { accepted: 3, pending: 2, noted: 1 };
  const statusMap = new Map<string, "accepted" | "pending" | "noted">();
  data?.forEach((inv) => {
    if (!inv.lot_id) return;
    const next = inv.status as "accepted" | "pending" | "noted";
    const current = statusMap.get(inv.lot_id);
    if (!current || rank[next] > rank[current]) statusMap.set(inv.lot_id, next);
  });

  return statusMap;
}
