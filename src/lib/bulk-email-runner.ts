// Framework-agnostic bulk-email runner. No "use server", no next/cache, no
// auth , safe to call from a Trigger.dev task AND from a server action (after
// its own auth check). Loads recipients server-side from small id-only
// payloads (no PII through the queue), sends via the email senders, and writes
// communication_log rows as it goes.

import { createServerClient } from "@/lib/supabase";
import { fetchObject } from "@/lib/storage/r2";
import {
  sendMeetingNoticeEmail,
  sendMaintenanceReminderEmail,
} from "@/lib/email";
import { resolveCompanyLogo } from "@/lib/notifications";
import { MEETING_TYPE_LABELS, type MeetingType } from "@/lib/validations/meetings";

export type BulkEmailPayload =
  | { kind: "meeting_notice"; meetingId: string; notifyScope: string; lotOwnerIds: string[] }
  | { kind: "recurring_job"; recurringJobId: string; occurrenceDate: string };

interface OwnerRow {
  lot_owner_id: string;
  name: string | null;
  email: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveOwners(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  ocId: string,
  scope: string,
  lotOwnerIds: string[],
): Promise<OwnerRow[]> {
  if (scope === "none") return [];
  // Email-eligible owners: have an email AND aren't post-only.
  let q = supabase
    .from("lot_owners")
    .select("id, name, email, delivery_preference, lots!inner(oc_id)")
    .eq("lots.oc_id", ocId)
    .not("email", "is", null)
    .neq("delivery_preference", "post");
  if (scope === "specific") {
    if (lotOwnerIds.length === 0) return [];
    q = q.in("id", lotOwnerIds);
  }
  const { data } = await q;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    lot_owner_id: r.id as string,
    name: (r.name as string) ?? null,
    email: r.email as string,
  }));
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
function formatDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

async function logComm(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  row: {
    ocId: string;
    email: string;
    type: string;
    subject: string;
    status: string;
    externalId: string | null;
    relatedType: string;
    relatedId: string;
  },
) {
  await supabase.from("communication_log").insert({
    oc_id: row.ocId,
    recipient_email: row.email,
    channel: "email",
    type: row.type,
    subject: row.subject,
    status: row.status,
    external_id: row.externalId,
    sent_at: row.status === "sent" ? new Date().toISOString() : null,
    related_entity_type: row.relatedType,
    related_entity_id: row.relatedId,
    direction: "outbound",
    confidential: false,
  });
}

export async function runBulkEmail(payload: BulkEmailPayload): Promise<{ sent: number; failed: number }> {
  const supabase = createServerClient();
  let sent = 0;
  let failed = 0;

  if (payload.kind === "meeting_notice") {
    const { data: meeting } = await supabase
      .from("meetings")
      .select("id, oc_id, meeting_type, title, date_time, location, virtual_meeting_link, notice_pdf_url, reference_number")
      .eq("id", payload.meetingId)
      .maybeSingle();
    if (!meeting || !meeting.notice_pdf_url) return { sent, failed };

    const { data: oc } = await supabase
      .from("owners_corporations")
      .select("name")
      .eq("id", meeting.oc_id)
      .maybeSingle();
    const ocName = (oc as { name?: string } | null)?.name ?? "Owners Corporation";

    const { data: agendaRows } = await supabase
      .from("agenda_items")
      .select("item_number, title")
      .eq("meeting_id", meeting.id)
      .order("item_number", { ascending: true });
    const agenda = (agendaRows ?? []).map((a: Record<string, unknown>) => ({
      position: a.item_number as number,
      title: a.title as string,
    }));

    const logoUrl = await resolveCompanyLogo(supabase, { ocId: meeting.oc_id });
    const owners = await resolveOwners(supabase, meeting.oc_id, payload.notifyScope, payload.lotOwnerIds);

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await fetchObject(meeting.notice_pdf_url as string);
    } catch (err) {
      console.error("runBulkEmail: could not fetch meeting notice PDF", err);
      return { sent, failed };
    }

    const typeLabel = MEETING_TYPE_LABELS[meeting.meeting_type as MeetingType] ?? "Meeting";
    const filename = `${meeting.reference_number ?? "meeting-notice"}.pdf`;

    for (const owner of owners) {
      const res = await sendMeetingNoticeEmail({
        to: owner.email,
        ownerName: owner.name,
        ocName,
        meetingTypeLabel: typeLabel,
        meetingTitle: meeting.title as string,
        whenLabel: formatWhen(meeting.date_time as string),
        location: (meeting.location as string) ?? null,
        onlineLink: (meeting.virtual_meeting_link as string) ?? null,
        agenda,
        pdfBuffer,
        pdfFilename: filename,
        companyLogoUrl: logoUrl,
        ocId: meeting.oc_id,
      });
      if ("success" in res) sent++; else failed++;
      await logComm(supabase, {
        ocId: meeting.oc_id,
        email: owner.email,
        type: "meeting_notice",
        subject: `Meeting notice , ${typeLabel} for ${ocName}`,
        status: "success" in res ? "sent" : "failed",
        externalId: "success" in res ? res.id : null,
        relatedType: "meeting",
        relatedId: meeting.id,
      });
    }

    // Stamp notice_sent_at + status once recipients have been processed.
    await supabase
      .from("meetings")
      .update({ notice_sent_at: new Date().toISOString(), status: "notice_sent" })
      .eq("id", meeting.id);

    return { sent, failed };
  }

  // recurring_job
  const { data: job } = await supabase
    .from("recurring_jobs")
    .select("id, oc_id, title, scope, notify_scope, contractor_id, contractors(business_name)")
    .eq("id", payload.recurringJobId)
    .maybeSingle();
  if (!job || job.notify_scope === "none") return { sent, failed };

  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name")
    .eq("id", job.oc_id)
    .maybeSingle();
  const ocName = (oc as { name?: string } | null)?.name ?? "Owners Corporation";

  let lotOwnerIds: string[] = [];
  if (job.notify_scope === "specific") {
    const { data: targets } = await supabase
      .from("recurring_job_notify_targets")
      .select("lot_owner_id")
      .eq("recurring_job_id", job.id);
    lotOwnerIds = (targets ?? []).map((t: Record<string, unknown>) => t.lot_owner_id as string);
  }

  const owners = await resolveOwners(supabase, job.oc_id, job.notify_scope, lotOwnerIds);
  const logoUrl = await resolveCompanyLogo(supabase, { ocId: job.oc_id });
  const contractorName = (job as { contractors: { business_name?: string } | null }).contractors?.business_name ?? null;
  const occurrenceLabel = formatDate(payload.occurrenceDate);

  for (const owner of owners) {
    const res = await sendMaintenanceReminderEmail({
      to: owner.email,
      ownerName: owner.name,
      ocName,
      jobTitle: job.title as string,
      occurrenceLabel,
      contractorName,
      scope: (job.scope as string) ?? null,
      companyLogoUrl: logoUrl,
      ocId: job.oc_id,
    });
    if ("success" in res) sent++; else failed++;
    await logComm(supabase, {
      ocId: job.oc_id,
      email: owner.email,
      type: "maintenance_update",
      subject: `Upcoming maintenance , ${job.title} at ${ocName}`,
      status: "success" in res ? "sent" : "failed",
      externalId: "success" in res ? res.id : null,
      relatedType: "recurring_job",
      relatedId: job.id,
    });
  }

  return { sent, failed };
}
