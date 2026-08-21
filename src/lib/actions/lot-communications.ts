"use server";

import { z } from "zod";
import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";
import { sendSms, normaliseAuMobile } from "@/lib/sms";
import { sendManagerMessageEmail } from "@/lib/email";
import { ensureManagerUsername } from "@/lib/actions/manager-username";
import { recordCommunicationCharge } from "@/lib/communication-credits";

// Communications tab server actions (Item 15). Each path:
//   1. Validates with Zod
//   2. Performs the side-effect (SMS / email / call-log entry)
//   3. Writes a row to communication_log
//   4. Writes an audit_log row via logAudit

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// ─── Log a phone call ───────────────────────────────────────────────────────

const logPhoneCallSchema = z.object({
  oc_id: z.string().uuid(),
  lot_id: z.string().uuid(),
  recipient_phone: z.string().trim().min(1).max(40),
  direction: z.enum(["outbound", "inbound"]),
  // ISO yyyy-MM-dd , when the call actually happened (mapped to sent_at).
  // Optional; if missing we default to the row's created_at via the DB.
  call_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
    .optional(),
  duration_seconds: z.number().int().min(0).max(60 * 60 * 12).nullable().optional(),
  notes: z.string().trim().min(1).max(2000),
  // Same confidentiality model as email / SMS , hide from future owners
  // when true. Useful for sensitive owner conversations the manager
  // doesn't want surfacing on the next owner's history.
  confidential: z.boolean().optional().default(false),
});

export async function logPhoneCall(
  input: z.input<typeof logPhoneCallSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = logPhoneCallSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const profile = await requireCompanyRole();
  await requireOCAccess(parsed.data.oc_id);
  const supabase = createServerClient();

  // sent_at = when the call actually happened (driven by call_date input).
  // created_at = when the manager logged it (DB default = now). Splitting the
  // two means a manager can backfill yesterday's call without losing the
  // logged-at audit timestamp.
  const callHappenedAt = parsed.data.call_date
    ? new Date(`${parsed.data.call_date}T00:00:00`).toISOString()
    : new Date().toISOString();

  // Snapshot current owner so future owners can't see confidential call
  // notes. Matches the email + SMS path.
  const { data: currentOwnerRow } = await supabase
    .from("lot_owners")
    .select("id")
    .eq("lot_id", parsed.data.lot_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const currentLotOwnerId =
    (currentOwnerRow as { id: string } | null)?.id ?? null;

  const { data: row, error } = await supabase
    .from("communication_log")
    .insert({
      oc_id: parsed.data.oc_id,
      lot_id: parsed.data.lot_id,
      sender_profile_id: profile.id,
      channel: "voice",
      type: "phone_call",
      direction: parsed.data.direction,
      duration_seconds: parsed.data.duration_seconds ?? null,
      recipient_phone: parsed.data.recipient_phone,
      body_preview: parsed.data.notes.slice(0, 200),
      body_full: parsed.data.notes,
      status: "logged",
      sent_at: callHappenedAt,
      confidential: parsed.data.confidential,
      lot_owner_id_at_creation: currentLotOwnerId,
    })
    .select("id")
    .single();

  if (error || !row) return { ok: false, error: "Could not save the call log." };

  await logAudit({
    profileId: profile.id,
    ocId: parsed.data.oc_id,
    action: "create",
    entityType: "phone_call",
    entityId: row.id as string,
    after: {
      lot_id: parsed.data.lot_id,
      recipient_phone: parsed.data.recipient_phone,
      direction: parsed.data.direction,
      duration_seconds: parsed.data.duration_seconds ?? null,
    },
    metadata: { lot_id: parsed.data.lot_id },
  });

  return { ok: true, data: { id: row.id as string } };
}

// ─── Send SMS ──────────────────────────────────────────────────────────────
// Manager confirmation is enforced by the popover UI (this action ASSUMES the
// confirmation step happened). SMS cost is the reason , every send is billable
// so we never auto-fire from a background job.

const sendSmsSchema = z.object({
  oc_id: z.string().uuid(),
  lot_id: z.string().uuid(),
  recipient_phone: z.string().trim().min(1).max(40),
  body: z.string().trim().min(1).max(1000),
  confirmed: z.literal(true),
  // Same confidentiality model as email , hide from future owners when true.
  confidential: z.boolean().optional().default(false),
});

export async function sendLotSms(
  input: z.input<typeof sendSmsSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = sendSmsSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "Please confirm the SMS send before submitting.",
    };

  const profile = await requireCompanyRole();
  await requireOCAccess(parsed.data.oc_id);
  const supabase = createServerClient();

  const normalised = normaliseAuMobile(parsed.data.recipient_phone);
  if (!normalised) return { ok: false, error: "Recipient mobile number is not valid." };

  const smsResult = await sendSms({
    to: normalised,
    body: parsed.data.body,
  });

  // Snapshot current owner so future owners can't read confidential SMS.
  const { data: currentOwnerRow } = await supabase
    .from("lot_owners")
    .select("id")
    .eq("lot_id", parsed.data.lot_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const currentLotOwnerId =
    (currentOwnerRow as { id: string } | null)?.id ?? null;

  const { data: row, error } = await supabase
    .from("communication_log")
    .insert({
      oc_id: parsed.data.oc_id,
      lot_id: parsed.data.lot_id,
      sender_profile_id: profile.id,
      channel: "sms",
      type: "manager_message",
      direction: "outbound",
      recipient_phone: normalised,
      body_preview: parsed.data.body.slice(0, 200),
      body_full: parsed.data.body,
      status: smsResult.ok ? (smsResult.dryRun ? "queued" : "sent") : "failed",
      external_id: smsResult.id ?? null,
      error_message: smsResult.ok ? null : smsResult.error ?? null,
      sent_at: new Date().toISOString(),
      confidential: parsed.data.confidential,
      lot_owner_id_at_creation: currentLotOwnerId,
    })
    .select("id")
    .single();

  if (error || !row) {
    return { ok: false, error: smsResult.ok ? "SMS sent but the log row didn't save." : smsResult.error ?? "Could not send SMS." };
  }

  await logAudit({
    profileId: profile.id,
    ocId: parsed.data.oc_id,
    action: "send",
    entityType: "sms",
    entityId: row.id as string,
    after: {
      lot_id: parsed.data.lot_id,
      recipient_phone: normalised,
      length: parsed.data.body.length,
      status: smsResult.ok ? "sent" : "failed",
    },
    metadata: { lot_id: parsed.data.lot_id },
  });

  // Record a billable charge against the manager's company. Each ~160-char
  // segment counts as one SMS , Mobile Message bills per segment.
  if (smsResult.ok && !smsResult.dryRun && profile.management_company_id) {
    const segments = Math.max(1, Math.ceil(parsed.data.body.length / 160));
    await recordCommunicationCharge(supabase, {
      managementCompanyId: profile.management_company_id,
      ocId: parsed.data.oc_id,
      communicationLogId: row.id as string,
      channel: "sms",
      units: segments,
      metadata: { recipient_phone: normalised, length: parsed.data.body.length },
    });
  }

  if (!smsResult.ok) return { ok: false, error: smsResult.error ?? "Could not send SMS." };
  return { ok: true, data: { id: row.id as string } };
}

// ─── Send Email ────────────────────────────────────────────────────────────
// FROM resolves to `<email_username>@<brand-domain>`; we lazy-derive the
// manager's username on first use via ensureManagerUsername.

const attachmentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  base64: z.string().min(1),
});

const sendEmailSchema = z.object({
  oc_id: z.string().uuid(),
  lot_id: z.string().uuid(),
  recipient_email: z.string().email(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20000),
  attachments: z.array(attachmentSchema).max(5).optional(),
  // Confidentiality is off by default. When true, only the current owner
  // (matching lot_owner_id_at_creation, set below) plus managers can see
  // the row on owner-facing surfaces. The flag is also inherited by any
  // inbound reply (in gmail-push) so the back-and-forth stays consistent.
  confidential: z.boolean().optional().default(false),
});

export async function sendLotEmail(
  input: z.input<typeof sendEmailSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = sendEmailSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const profile = await requireCompanyRole();
  await requireOCAccess(parsed.data.oc_id);
  const supabase = createServerClient();

  // Best-effort username creation. If it fails we still send from the legacy
  // noreply address , the user can see the resulting log row and fix later.
  await ensureManagerUsername();

  const attachments = (parsed.data.attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: Buffer.from(a.base64, "base64"),
  }));

  const result = await sendManagerMessageEmail({
    managerProfileId: profile.id,
    to: parsed.data.recipient_email,
    subject: parsed.data.subject,
    bodyText: parsed.data.body,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  let status: "sent" | "failed" | "queued" = "sent";
  let externalId: string | null = null;
  let errorMessage: string | null = null;

  if ("dryRun" in result) {
    status = "queued";
  } else if ("error" in result) {
    status = "failed";
    errorMessage = result.error;
  } else {
    externalId = result.id;
  }

  // Snapshot the current owner of the lot so future owners can't read
  // any confidential thread that pre-dates their ownership.
  const { data: currentOwnerRow } = await supabase
    .from("lot_owners")
    .select("id")
    .eq("lot_id", parsed.data.lot_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const currentLotOwnerId =
    (currentOwnerRow as { id: string } | null)?.id ?? null;

  const { data: row, error } = await supabase
    .from("communication_log")
    .insert({
      oc_id: parsed.data.oc_id,
      lot_id: parsed.data.lot_id,
      sender_profile_id: profile.id,
      channel: "email",
      type: "manager_message",
      direction: "outbound",
      recipient_email: parsed.data.recipient_email,
      subject: parsed.data.subject,
      body_preview: parsed.data.body.slice(0, 200),
      body_full: parsed.data.body,
      status,
      external_id: externalId,
      error_message: errorMessage,
      sent_at: new Date().toISOString(),
      confidential: parsed.data.confidential,
      lot_owner_id_at_creation: currentLotOwnerId,
    })
    .select("id")
    .single();

  if (error || !row) {
    return {
      ok: false,
      error: status === "failed" ? errorMessage ?? "Could not send email." : "Email sent but the log row didn't save.",
    };
  }

  await logAudit({
    profileId: profile.id,
    ocId: parsed.data.oc_id,
    action: "send",
    entityType: "email",
    entityId: row.id as string,
    after: {
      lot_id: parsed.data.lot_id,
      recipient_email: parsed.data.recipient_email,
      subject: parsed.data.subject,
      status,
    },
    metadata: { lot_id: parsed.data.lot_id },
  });

  if (status === "failed") return { ok: false, error: errorMessage ?? "Could not send email." };
  return { ok: true, data: { id: row.id as string } };
}

// ─── List communications for a lot ─────────────────────────────────────────

export interface LotCommunicationAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  url: string;
}

export interface LotCommunicationRow {
  id: string;
  created_at: string;
  // sent_at = when the event happened (call date, email/SMS send time).
  // created_at = when the row was written (audit log). For phone calls
  // these differ when a manager back-logs an older call.
  sent_at: string | null;
  channel: string;
  type: string;
  direction: string | null;
  subject: string | null;
  body_preview: string | null;
  recipient_email: string | null;
  recipient_phone: string | null;
  duration_seconds: number | null;
  status: string;
  actor_name: string | null;
  confidential: boolean;
  // The owner this communication is logged AGAINST , whoever owned the lot
  // when the row was written (lot_owner_id_at_creation snapshot). Null when
  // there was no owner at the time. Avatar is best-effort (only present if
  // that owner has an accepted portal profile with a picture).
  owner_name: string | null;
  owner_avatar_url: string | null;
  // Inbound email attachments stored on R2 via the gmail/resend
  // push handlers. Empty for sent rows and non-email channels.
  attachments: LotCommunicationAttachment[];
}

export async function listLotCommunications(lotId: string): Promise<LotCommunicationRow[]> {
  await requireCompanyRole();
  const supabase = createServerClient();

  // Authorize against the lot's OC before reading another firm's comms.
  const { data: lot } = await supabase
    .from("lots")
    .select("oc_id")
    .eq("id", lotId)
    .maybeSingle();
  if (!lot) return [];
  await requireOCAccess(lot.oc_id as string);

  const { data } = await supabase
    .from("communication_log")
    .select(
      "id, created_at, sent_at, channel, type, direction, subject, body_preview, recipient_email, recipient_phone, duration_seconds, status, sender_profile_id, confidential, lot_owner_id_at_creation",
    )
    .eq("lot_id", lotId)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = data ?? [];

  // Resolve the owner each row is logged against (lot_owner_id_at_creation).
  // Name comes from lot_owners; the avatar is best-effort via the matching
  // portal profile (by email) since lot_owners has no picture of its own.
  const ownerIds = Array.from(
    new Set(rows.map((r) => r.lot_owner_id_at_creation).filter((v): v is string => !!v)),
  );
  const ownerMap: Record<string, { name: string | null; email: string | null }> = {};
  if (ownerIds.length > 0) {
    const { data: owners } = await supabase
      .from("lot_owners")
      .select("id, name, email")
      .in("id", ownerIds);
    (owners ?? []).forEach((o) => {
      ownerMap[o.id as string] = { name: (o.name as string) ?? null, email: (o.email as string) ?? null };
    });
  }
  const ownerEmails = Array.from(
    new Set(Object.values(ownerMap).map((o) => o.email?.toLowerCase()).filter((v): v is string => !!v)),
  );
  const avatarByEmail: Record<string, string> = {};
  if (ownerEmails.length > 0) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("email, avatar_url")
      .in("email", ownerEmails);
    (profs ?? []).forEach((p) => {
      if (p.email && p.avatar_url) avatarByEmail[(p.email as string).toLowerCase()] = p.avatar_url as string;
    });
  }
  const actorIds = Array.from(
    new Set(rows.map((r) => r.sender_profile_id).filter((v): v is string => !!v)),
  );
  const actorMap: Record<string, string> = {};
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", actorIds);
    (actors ?? []).forEach((a) => {
      actorMap[a.id as string] =
        [a.first_name, a.last_name].filter(Boolean).join(" ") || (a.email as string) || "System";
    });
  }

  // Pull inbound attachments for the email rows in one batched query and
  // group by communication_log_id. Phone calls / SMS / outbound mail have
  // no attachments today so they get an empty list.
  const emailRowIds = rows
    .filter((r) => r.channel === "email")
    .map((r) => r.id as string);
  const attachmentMap: Record<string, LotCommunicationAttachment[]> = {};
  if (emailRowIds.length > 0) {
    const { data: attRows } = await supabase
      .from("inbound_email_attachments")
      .select("id, communication_log_id, filename, mime_type, size_bytes, r2_url")
      .in("communication_log_id", emailRowIds)
      .order("created_at", { ascending: true });
    for (const a of (attRows ?? []) as Array<{
      id: string;
      communication_log_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      r2_url: string;
    }>) {
      const key = a.communication_log_id;
      if (!attachmentMap[key]) attachmentMap[key] = [];
      attachmentMap[key].push({
        id: a.id,
        filename: a.filename,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
        url: a.r2_url,
      });
    }
  }

  return rows.map((r) => ({
    id: r.id as string,
    created_at: r.created_at as string,
    sent_at: (r.sent_at as string | null) ?? null,
    channel: r.channel as string,
    type: r.type as string,
    direction: (r.direction as string) ?? null,
    subject: (r.subject as string) ?? null,
    body_preview: (r.body_preview as string) ?? null,
    recipient_email: (r.recipient_email as string) ?? null,
    recipient_phone: (r.recipient_phone as string) ?? null,
    duration_seconds: (r.duration_seconds as number) ?? null,
    status: r.status as string,
    actor_name: r.sender_profile_id ? actorMap[r.sender_profile_id as string] ?? null : null,
    confidential: !!(r as { confidential?: boolean }).confidential,
    owner_name: r.lot_owner_id_at_creation ? ownerMap[r.lot_owner_id_at_creation as string]?.name ?? null : null,
    owner_avatar_url: (() => {
      const e = r.lot_owner_id_at_creation ? ownerMap[r.lot_owner_id_at_creation as string]?.email?.toLowerCase() : null;
      return e ? avatarByEmail[e] ?? null : null;
    })(),
    attachments: attachmentMap[r.id as string] ?? [],
  }));
}

// ─── Quick toggle: flip confidentiality on an existing row ────────────────
// Logs to audit so the change is traceable. Manager-only.

const setConfidentialSchema = z.object({
  communication_log_id: z.string().uuid(),
  confidential: z.boolean(),
});

export async function setCommunicationConfidential(
  input: z.input<typeof setConfidentialSchema>,
): Promise<Result<{ id: string; confidential: boolean }>> {
  const parsed = setConfidentialSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const { data: existing } = await supabase
    .from("communication_log")
    .select("id, oc_id, lot_id, confidential")
    .eq("id", parsed.data.communication_log_id)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Communication not found." };

  // Authorize against the row's OC before flipping its confidential flag.
  if (!existing.oc_id) return { ok: false, error: "Communication not found." };
  await requireOCAccess(existing.oc_id as string);

  const { error } = await supabase
    .from("communication_log")
    .update({ confidential: parsed.data.confidential })
    .eq("id", parsed.data.communication_log_id);
  if (error) return { ok: false, error: error.message };

  await logAudit({
    profileId: profile.id,
    ocId: (existing.oc_id as string) ?? undefined,
    action: "update",
    entityType: "communication_log",
    entityId: parsed.data.communication_log_id,
    before: { confidential: !!(existing as { confidential?: boolean }).confidential },
    after: { confidential: parsed.data.confidential },
    metadata: existing.lot_id ? { lot_id: existing.lot_id } : undefined,
  });

  return {
    ok: true,
    data: { id: parsed.data.communication_log_id, confidential: parsed.data.confidential },
  };
}
