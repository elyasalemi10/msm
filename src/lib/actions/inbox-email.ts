"use server";

import { z } from "zod";
import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { sendManagerMessageEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { ensureManagerUsername } from "@/lib/actions/manager-username";

// Inbox email helpers used by /inbox/inbox-content.tsx.
//
//   getInboxEmail(communicationLogId)
//     Returns the inbound communication_log row + the outbound row it was
//     a reply to (if any), with sender/recipient/subject/body for the
//     email-style detail view.
//
//   replyToInboxEmail({ communicationLogId, body })
//     Sends a reply via sendManagerMessageEmail, writes a new outbound
//     row to communication_log, audits the send. Recipient = the
//     inbound row's sender; subject = "Re: <subject>" (skipping
//     duplicate "Re:" prefixes).
//
//   associateInboxEmailToLot({ communicationLogId, oc_id, lot_id })
//     Manual fallback when In-Reply-To match failed. Updates the
//     inbound row's oc_id + lot_id + recipient_id so it shows up on
//     the lot's Communications tab.

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface InboxEmailDetail {
  id: string;
  sent_at: string | null;
  created_at: string;
  subject: string;
  body: string;
  sender_email: string;
  recipient_email: string;
  // Carried metadata if the inbound is associated to a lot.
  oc_id: string | null;
  lot_id: string | null;
  oc_name: string | null;
  oc_short_code: string | null;
  lot_label: string | null;
  // For the inbox link line , "OC Name · Lot N · Unit X" or
  // "OC Name · PS123456" when no unit; the short_code goes in the URL.
  lot_link_label: string | null;
  // Which transport delivered this inbound , "gmail" when the row came in
  // via the Pub/Sub gmail-push webhook (regardless of sender domain),
  inbox_provider: "gmail" | null;
  // Gmail-internal ids stashed on the notification when ingested via
  // gmail-push, used to deep-link the "Open in Gmail" action straight to
  // the message instead of a search query.
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  // The outbound row this is a reply to (when auto-match found one).
  outbound: {
    id: string;
    subject: string | null;
    sent_at: string | null;
    body: string | null;
  } | null;
  // Inbound attachments persisted by the gmail-push webhook into R2.
  // Empty array when none.
  attachments: Array<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    url: string;
  }>;
}

export async function getInboxEmail(
  communicationLogId: string,
): Promise<Result<InboxEmailDetail>> {
  if (!communicationLogId) return { ok: false, error: "Missing email id" };
  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const { data: row, error } = await supabase
    .from("communication_log")
    .select(
      "id, sent_at, created_at, subject, body_full, body_preview, recipient_email, recipient_id, oc_id, lot_id, related_entity_type, related_entity_id, direction, channel, recipient_phone",
    )
    .eq("id", communicationLogId)
    .single();

  if (error || !row) return { ok: false, error: "Email not found" };
  if (row.recipient_id !== profile.id) {
    return { ok: false, error: "You don't have access to this email" };
  }

  // Sender lives on recipient_email for inbound rows (we stored the manager's
  // address there because that's where the reply landed). For an inbound,
  // the OWNER's address is on subject's metadata... actually we DO need a
  // sender field. Looking at the insert code: subject is the inbound
  // subject, recipient_email is the manager's address. The owner's sender
  // address goes on the audit row but we didn't store it on the comm_log.
  // For now we pull it from notifications.metadata.sender_email , joined below.
  const { data: notif } = await supabase
    .from("notifications")
    .select("metadata")
    .eq("profile_id", profile.id)
    .filter("metadata->>communication_log_id", "eq", communicationLogId)
    .maybeSingle();
  const notifMeta =
    ((notif as { metadata: Record<string, unknown> | null } | null)?.metadata) ?? {};
  const senderEmail = (notifMeta.sender_email as string | undefined) ?? "";
  const metaProvider = notifMeta.provider as "gmail" | undefined;
  const gmailMessageId = (notifMeta.gmail_message_id as string | undefined) ?? null;
  const gmailThreadId = (notifMeta.gmail_thread_id as string | undefined) ?? null;

  // Fallback provider resolution for rows ingested before we started
  // tagging notification metadata with provider/gmail_message_id ,
  // checks the inbound row's recipient against gmail_mailbox_subscriptions.
  let inboxProvider: "gmail" | null = metaProvider ?? null;
  if (!inboxProvider && row.recipient_email) {
    const { data: sub } = await supabase
      .from("gmail_mailbox_subscriptions")
      .select("id")
      .eq("mailbox_email", (row.recipient_email as string).toLowerCase())
      .maybeSingle();
    if (sub) inboxProvider = "gmail";
  }

  let outbound: InboxEmailDetail["outbound"] = null;
  if (row.related_entity_type === "communication_log" && row.related_entity_id) {
    const { data: out } = await supabase
      .from("communication_log")
      .select("id, subject, sent_at, body_full")
      .eq("id", row.related_entity_id as string)
      .maybeSingle();
    if (out) {
      outbound = {
        id: out.id as string,
        subject: (out.subject as string | null) ?? null,
        sent_at: (out.sent_at as string | null) ?? null,
        body: (out.body_full as string | null) ?? null,
      };
    }
  }

  let ocName: string | null = null;
  let ocShortCode: string | null = null;
  let ocPlanNumber: string | null = null;
  let lotLabel: string | null = null;
  if (row.oc_id) {
    const { data: oc } = await supabase
      .from("owners_corporations")
      .select("name, short_code, plan_number")
      .eq("id", row.oc_id as string)
      .maybeSingle();
    ocName =
      (oc as { name: string | null } | null)?.name ?? null;
    ocShortCode =
      (oc as { short_code: string | null } | null)?.short_code ?? null;
    ocPlanNumber =
      (oc as { plan_number: string | null } | null)?.plan_number ?? null;
  }
  if (row.lot_id) {
    const { data: lot } = await supabase
      .from("lots")
      .select("lot_number, unit_number")
      .eq("id", row.lot_id as string)
      .maybeSingle();
    if (lot) {
      const unit = (lot as { unit_number: string | null }).unit_number;
      lotLabel = `Lot ${(lot as { lot_number: number }).lot_number}${unit ? ` · Unit ${unit}` : ""}`;
    }
  }

  // Compact label for the blue link line. Falls back to the OC plan
  // number when the row has no specific lot (manager hasn't picked one
  // yet); never includes the address (too long for an inline link).
  const lotLinkLabel = (() => {
    if (!ocName && !lotLabel) return null;
    if (ocName && lotLabel) return `${ocName} · ${lotLabel}`;
    if (ocName && ocPlanNumber) return `${ocName} · ${ocPlanNumber}`;
    return ocName ?? lotLabel ?? null;
  })();

  // Inbound attachments (R2-backed) for this comm-log row.
  const { data: attRows } = await supabase
    .from("inbound_email_attachments")
    .select("id, filename, mime_type, size_bytes, r2_url")
    .eq("communication_log_id", communicationLogId)
    .order("created_at", { ascending: true });
  const attachments = ((attRows ?? []) as Array<{
    id: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    r2_url: string;
  }>).map((a) => ({
    id: a.id,
    filename: a.filename,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    url: a.r2_url,
  }));

  return {
    ok: true,
    data: {
      id: row.id as string,
      sent_at: (row.sent_at as string | null) ?? null,
      created_at: row.created_at as string,
      subject: (row.subject as string) ?? "",
      body: ((row.body_full as string | null) ?? (row.body_preview as string | null) ?? ""),
      sender_email: senderEmail,
      recipient_email: (row.recipient_email as string) ?? "",
      oc_id: (row.oc_id as string | null) ?? null,
      lot_id: (row.lot_id as string | null) ?? null,
      oc_name: ocName,
      oc_short_code: ocShortCode,
      lot_label: lotLabel,
      lot_link_label: lotLinkLabel,
      inbox_provider: inboxProvider,
      gmail_message_id: gmailMessageId,
      gmail_thread_id: gmailThreadId,
      outbound,
      attachments,
    },
  };
}

// ─── Reply to an inbox email ───────────────────────────────────────────

const replySchema = z.object({
  communicationLogId: z.string().uuid(),
  body: z.string().trim().min(1).max(20000),
});

export async function replyToInboxEmail(
  input: z.input<typeof replySchema>,
): Promise<Result<{ id: string }>> {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const detail = await getInboxEmail(parsed.data.communicationLogId);
  if (!detail.ok) return detail;

  const { data } = detail;
  if (!data.sender_email) {
    return { ok: false, error: "Couldn't determine the original sender." };
  }

  await ensureManagerUsername();

  const replySubject = data.subject.toLowerCase().startsWith("re:")
    ? data.subject
    : `Re: ${data.subject}`;

  const result = await sendManagerMessageEmail({
    managerProfileId: profile.id,
    to: data.sender_email,
    subject: replySubject,
    bodyText: parsed.data.body,
  });

  if ("error" in result) return { ok: false, error: result.error };

  const externalId = "id" in result ? result.id : null;

  // Inherit confidentiality (+ owner pin) from the inbound row we're
  // replying to so the thread stays consistent. The original send →
  // inbound reply → our reply trio all carry the same flag.
  const { data: inboundRow } = await supabase
    .from("communication_log")
    .select("confidential, lot_owner_id_at_creation")
    .eq("id", data.id)
    .maybeSingle();
  const inheritedConfidential = !!(inboundRow as { confidential?: boolean } | null)?.confidential;
  const inheritedLotOwnerId =
    (inboundRow as { lot_owner_id_at_creation?: string | null } | null)
      ?.lot_owner_id_at_creation ?? null;

  const { data: outbound, error: insertErr } = await supabase
    .from("communication_log")
    .insert({
      oc_id: data.oc_id,
      lot_id: data.lot_id,
      sender_profile_id: profile.id,
      channel: "email",
      type: "manager_message",
      direction: "outbound",
      recipient_email: data.sender_email,
      subject: replySubject,
      body_preview: parsed.data.body.slice(0, 200),
      body_full: parsed.data.body,
      status: "dryRun" in result ? "queued" : "sent",
      external_id: externalId,
      sent_at: new Date().toISOString(),
      related_entity_type: "communication_log",
      related_entity_id: data.id,
      confidential: inheritedConfidential,
      lot_owner_id_at_creation: inheritedLotOwnerId,
    })
    .select("id")
    .single();

  if (insertErr || !outbound) {
    return { ok: false, error: "Reply sent but the log row didn't save." };
  }

  await logAudit({
    profileId: profile.id,
    ocId: data.oc_id ?? undefined,
    action: "send",
    entityType: "email",
    entityId: outbound.id as string,
    after: {
      reply_to: data.id,
      recipient_email: data.sender_email,
      subject: replySubject,
    },
    metadata: data.lot_id ? { lot_id: data.lot_id } : undefined,
  });

  return { ok: true, data: { id: outbound.id as string } };
}

// ─── Manual associate (fallback when auto-match failed) ────────────────

const associateSchema = z.object({
  communicationLogId: z.string().uuid(),
  oc_id: z.string().uuid(),
  lot_id: z.string().uuid().nullable(),
});

export async function associateInboxEmailToLot(
  input: z.input<typeof associateSchema>,
): Promise<Result<{ id: string }>> {
  const parsed = associateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const { data: existing } = await supabase
    .from("communication_log")
    .select("id, recipient_id")
    .eq("id", parsed.data.communicationLogId)
    .single();
  if (!existing || existing.recipient_id !== profile.id) {
    return { ok: false, error: "You don't have access to this email" };
  }

  // The target OC must belong to the caller's company, and a chosen lot must
  // be within that OC, so an email can't be stamped onto another firm's ids.
  await requireOCAccess(parsed.data.oc_id);
  if (parsed.data.lot_id) {
    const { data: lot } = await supabase
      .from("lots")
      .select("oc_id")
      .eq("id", parsed.data.lot_id)
      .maybeSingle();
    if (!lot || lot.oc_id !== parsed.data.oc_id) {
      return { ok: false, error: "That lot isn't part of the selected owners corporation." };
    }
  }

  const { error } = await supabase
    .from("communication_log")
    .update({
      oc_id: parsed.data.oc_id,
      lot_id: parsed.data.lot_id,
    })
    .eq("id", parsed.data.communicationLogId);
  if (error) return { ok: false, error: error.message };

  // Mirror onto the notification so future opens of the inbox carry the
  // updated oc_id (a notification's oc_id powers the breadcrumb context).
  await supabase
    .from("notifications")
    .update({ oc_id: parsed.data.oc_id })
    .eq("profile_id", profile.id)
    .filter("metadata->>communication_log_id", "eq", parsed.data.communicationLogId);

  await logAudit({
    profileId: profile.id,
    ocId: parsed.data.oc_id,
    action: "associate",
    entityType: "email",
    entityId: parsed.data.communicationLogId,
    after: {
      oc_id: parsed.data.oc_id,
      lot_id: parsed.data.lot_id,
    },
    metadata: parsed.data.lot_id ? { lot_id: parsed.data.lot_id } : undefined,
  });

  return { ok: true, data: { id: parsed.data.communicationLogId } };
}

// ─── Prefetch the top N email_reply details so opening them is instant ─
//
// Server-side helper called from /inbox/page.tsx. We pre-load detail for
// the most recent unread (or, if none, read) email_reply notifications so
// the client doesn't show "Loading email…" the first time the manager
// clicks one. The client treats the returned map as a cache, falling back
// to getInboxEmail() for any id not present.
//
// Capped at `limit` (default 5) , enough to make the "click → instant
// open" experience real for the unread set without blowing the
// server-component data budget on rare cases.

export async function prefetchInboxEmails(
  notifications: Array<{
    id: string;
    type: string;
    read_at: string | null;
    metadata: Record<string, unknown> | null;
  }>,
  limit = 5,
): Promise<Record<string, InboxEmailDetail>> {
  // Pick unread email_reply first, then fill from read ones to reach `limit`.
  const emailReplies = notifications.filter((n) => n.type === "email_reply");
  const unread = emailReplies.filter((n) => !n.read_at);
  const read = emailReplies.filter((n) => !!n.read_at);
  const picked = [...unread, ...read].slice(0, limit);

  const out: Record<string, InboxEmailDetail> = {};
  for (const n of picked) {
    const commLogId = (n.metadata ?? {})["communication_log_id"] as string | undefined;
    if (!commLogId) continue;
    try {
      const res = await getInboxEmail(commLogId);
      if (res.ok) out[n.id] = res.data;
    } catch (err) {
      console.warn("prefetchInboxEmails: skipped", n.id, err);
    }
  }
  return out;
}

// ─── Per-row provider hint for the inbox list ─────────────────────────
//
// Returns a Record<notificationId, "gmail"> for the email_reply
// notifications whose `metadata.provider` is set (newer rows) OR whose
// underlying communication_log.recipient_email matches a row in
// gmail_mailbox_subscriptions for the firm (backfill for older rows
// ingested before we tagged metadata). Anything we can't confidently
// attribute is omitted , the client falls back to a generic Mail glyph.

export async function resolveInboxRowProviders(
  notifications: Array<{
    id: string;
    type: string;
    metadata: Record<string, unknown> | null;
  }>,
): Promise<Record<string, "gmail">> {
  const out: Record<string, "gmail"> = {};
  const need: Array<{ id: string; commLogId: string }> = [];

  for (const n of notifications) {
    if (n.type !== "email_reply") continue;
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    const tagged = meta.provider as "gmail" | undefined;
    if (tagged === "gmail") {
      out[n.id] = tagged;
      continue;
    }
    const commLogId = meta.communication_log_id as string | undefined;
    if (commLogId) need.push({ id: n.id, commLogId });
  }

  if (need.length === 0) return out;

  const supabase = createServerClient();
  const { data: rows } = await supabase
    .from("communication_log")
    .select("id, recipient_email")
    .in(
      "id",
      need.map((n) => n.commLogId),
    );
  const recipientByCommLog = new Map<string, string>();
  for (const r of (rows ?? []) as Array<{ id: string; recipient_email: string | null }>) {
    if (r.recipient_email) {
      recipientByCommLog.set(r.id, r.recipient_email.toLowerCase());
    }
  }

  const uniqueMailboxes = Array.from(new Set(recipientByCommLog.values()));
  if (uniqueMailboxes.length === 0) return out;

  const { data: subs } = await supabase
    .from("gmail_mailbox_subscriptions")
    .select("mailbox_email")
    .in("mailbox_email", uniqueMailboxes);
  const gmailMailboxes = new Set(
    ((subs ?? []) as Array<{ mailbox_email: string }>).map((s) =>
      s.mailbox_email.toLowerCase(),
    ),
  );

  for (const n of need) {
    const recipient = recipientByCommLog.get(n.commLogId);
    if (recipient && gmailMailboxes.has(recipient)) {
      out[n.id] = "gmail";
    }
  }
  return out;
}

// ─── Remove from inbox (dismisses notification, keeps comm_log audit) ──

export async function removeInboxEmail(
  notificationId: string,
): Promise<Result<{ id: string }>> {
  if (!notificationId) return { ok: false, error: "Missing notification id" };
  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  const { data: notif } = await supabase
    .from("notifications")
    .select("id, profile_id")
    .eq("id", notificationId)
    .maybeSingle();
  if (!notif || (notif as { profile_id: string }).profile_id !== profile.id) {
    return { ok: false, error: "You don't have access to this notification" };
  }

  const { error } = await supabase
    .from("notifications")
    .delete()
    .eq("id", notificationId)
    .eq("profile_id", profile.id);
  if (error) return { ok: false, error: error.message };

  return { ok: true, data: { id: notificationId } };
}

// ─── People search for the link-to-lot combobox ────────────────────────
//
// Returns a flat list of OWNERSHIPS the manager can choose from, sorted by
// owner name. Multi-lot owners surface as multiple rows so the manager can
// pick which lot the email relates to. The underlying email link still
// stores (oc_id, lot_id) , owners aren't a first-class entity for
// documents/comms , but the picker UX is "search people."
//
// q is a substring against owner name / OC name / lot label, case-
// insensitive. Capped at 50 results so the dropdown stays usable.

export interface PersonOwnershipOption {
  // Stable composite id used as the value in the combobox; encodes both
  // sides so the parent can derive (oc_id, lot_id) without a second
  // round-trip.
  key: string;
  oc_id: string;
  lot_id: string;
  oc_name: string;
  oc_short_code: string;
  lot_label: string;
  owner_name: string;
  owner_email: string | null;
}

export async function searchPeopleForAssociate(
  q: string,
): Promise<PersonOwnershipOption[]> {
  const profile = await requireCompanyRole();
  if (!profile.management_company_id) return [];
  const supabase = createServerClient();

  // Step 1: candidate OCs for this firm. Bounded by the firm's portfolio
  // (typically 10s-100s) , cheaper to fetch upfront than to join 4-way.
  const { data: ocs } = await supabase
    .from("owners_corporations")
    .select("id, name, short_code")
    .eq("management_company_id", profile.management_company_id);
  const ocMap = new Map<string, { name: string; short_code: string }>();
  for (const oc of (ocs ?? []) as Array<{ id: string; name: string; short_code: string }>) {
    ocMap.set(oc.id, { name: oc.name, short_code: oc.short_code });
  }
  if (ocMap.size === 0) return [];

  // Step 2: lots in those OCs.
  const ocIds = Array.from(ocMap.keys());
  const { data: lots } = await supabase
    .from("lots")
    .select("id, oc_id, lot_number, unit_number")
    .in("oc_id", ocIds)
    .limit(2000);
  const lotMap = new Map<string, { oc_id: string; label: string }>();
  for (const l of (lots ?? []) as Array<{ id: string; oc_id: string; lot_number: number; unit_number: string | null }>) {
    const label = `Lot ${l.lot_number}${l.unit_number ? ` · Unit ${l.unit_number}` : ""}`;
    lotMap.set(l.id, { oc_id: l.oc_id, label });
  }
  if (lotMap.size === 0) return [];

  // Step 3: current owners across those lots.
  const lotIds = Array.from(lotMap.keys());
  const { data: owners } = await supabase
    .from("lot_owners")
    .select("lot_id, name, email")
    .in("lot_id", lotIds);

  const needle = q.trim().toLowerCase();
  const rows: PersonOwnershipOption[] = [];
  for (const o of (owners ?? []) as Array<{ lot_id: string; name: string | null; email: string | null }>) {
    const lot = lotMap.get(o.lot_id);
    if (!lot) continue;
    const oc = ocMap.get(lot.oc_id);
    if (!oc) continue;
    const ownerName = (o.name ?? "").trim() || "Unnamed owner";
    if (needle) {
      const haystack = `${ownerName} ${oc.name} ${lot.label} ${o.email ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    rows.push({
      key: `${lot.oc_id}:${o.lot_id}`,
      oc_id: lot.oc_id,
      lot_id: o.lot_id,
      oc_name: oc.name,
      oc_short_code: oc.short_code,
      lot_label: lot.label,
      owner_name: ownerName,
      owner_email: o.email,
    });
  }

  rows.sort((a, b) => a.owner_name.localeCompare(b.owner_name));
  return rows.slice(0, 50);
}

// Eager-load the full ownership list for the firm , used by the inbox to
// preload the link-to-lot popover so search is instant (no server round
// trip per keystroke). Cap is 2000 ownerships which comfortably covers
// any single firm's portfolio for the MVP.
export async function listAllPeopleOwnerships(): Promise<PersonOwnershipOption[]> {
  const profile = await requireCompanyRole();
  if (!profile.management_company_id) return [];
  const supabase = createServerClient();

  const { data: ocs } = await supabase
    .from("owners_corporations")
    .select("id, name, short_code")
    .eq("management_company_id", profile.management_company_id);
  const ocMap = new Map<string, { name: string; short_code: string }>();
  for (const oc of (ocs ?? []) as Array<{ id: string; name: string; short_code: string }>) {
    ocMap.set(oc.id, { name: oc.name, short_code: oc.short_code });
  }
  if (ocMap.size === 0) return [];

  const ocIds = Array.from(ocMap.keys());
  const { data: lots } = await supabase
    .from("lots")
    .select("id, oc_id, lot_number, unit_number")
    .in("oc_id", ocIds)
    .limit(5000);
  const lotMap = new Map<string, { oc_id: string; label: string }>();
  for (const l of (lots ?? []) as Array<{ id: string; oc_id: string; lot_number: number; unit_number: string | null }>) {
    lotMap.set(l.id, {
      oc_id: l.oc_id,
      label: `Lot ${l.lot_number}${l.unit_number ? ` · Unit ${l.unit_number}` : ""}`,
    });
  }
  if (lotMap.size === 0) return [];

  const { data: owners } = await supabase
    .from("lot_owners")
    .select("lot_id, name, email")
    .in("lot_id", Array.from(lotMap.keys()));

  const rows: PersonOwnershipOption[] = [];
  for (const o of (owners ?? []) as Array<{ lot_id: string; name: string | null; email: string | null }>) {
    const lot = lotMap.get(o.lot_id);
    if (!lot) continue;
    const oc = ocMap.get(lot.oc_id);
    if (!oc) continue;
    rows.push({
      key: `${lot.oc_id}:${o.lot_id}`,
      oc_id: lot.oc_id,
      lot_id: o.lot_id,
      oc_name: oc.name,
      oc_short_code: oc.short_code,
      lot_label: lot.label,
      owner_name: (o.name ?? "").trim() || "Unnamed owner",
      owner_email: o.email,
    });
  }
  rows.sort((a, b) => a.owner_name.localeCompare(b.owner_name));
  return rows.slice(0, 2000);
}

// ─── OC / Lot lookups for the associate picker ─────────────────────────

export interface OcPickerOption {
  id: string;
  name: string;
}

export interface LotPickerOption {
  id: string;
  label: string;
  owner_name: string | null;
}

export async function listOcsForAssociate(): Promise<OcPickerOption[]> {
  const profile = await requireCompanyRole();
  const supabase = createServerClient();

  if (!profile.management_company_id) return [];
  const { data } = await supabase
    .from("owners_corporations")
    .select("id, name")
    .eq("management_company_id", profile.management_company_id)
    .order("name", { ascending: true })
    .limit(500);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: (r.name as string) ?? "",
  }));
}

export async function listLotsForAssociate(
  ocId: string,
): Promise<LotPickerOption[]> {
  await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data } = await supabase
    .from("lots")
    .select("id, lot_number, unit_number")
    .eq("oc_id", ocId)
    .order("lot_number", { ascending: true });
  const lots = data ?? [];

  // Pull owner names for the label.
  const lotIds = lots.map((l) => l.id as string);
  const ownerLookup: Record<string, string | null> = {};
  if (lotIds.length > 0) {
    const { data: owners } = await supabase
      .from("lot_owners")
      .select("lot_id, name")
      .in("lot_id", lotIds);
    for (const o of owners ?? []) {
      ownerLookup[o.lot_id as string] = (o.name as string | null) ?? null;
    }
  }

  return lots.map((l) => {
    const unit = l.unit_number as string | null;
    const label = `Lot ${l.lot_number}${unit ? ` · Unit ${unit}` : ""}`;
    return {
      id: l.id as string,
      label,
      owner_name: ownerLookup[l.id as string] ?? null,
    };
  });
}
