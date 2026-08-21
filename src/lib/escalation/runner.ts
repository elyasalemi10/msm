// Framework-agnostic escalation sweep. Safe to call from the Trigger.dev cron.
// Creates a follow-up instance per overdue levy notice, then advances due
// instances one step at a time: sends the manager-authored reminder emails,
// generates the s.32 final notice on the final email step, and raises a VCAT
// task on the vcat step.

import { createServerClient } from "@/lib/supabase";
import { sendEscalationEmail } from "@/lib/email";
import { isNotificationOptedOut } from "@/lib/notifications";
import { generateAndUploadFinalNotice } from "@/lib/final-notice-pdf";
import { resolveWorkflowForOC, renderTemplate, computeInterest, addDaysIso } from "@/lib/escalation/helpers";
import type { FollowupStep } from "@/lib/validations/escalation";

// In-app notify the OC's managers about a follow-up event (escalation email
// sent, VCAT ready). Type 'escalation_step' is opt-outable in Settings ,
// Notifications, so we honour each manager's preference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function notifyOcManagers(supabase: any, ocId: string, title: string, body: string, link?: string) {
  const { data: managers } = await supabase
    .from("oc_members").select("profile_id").eq("oc_id", ocId).eq("role", "strata_manager").is("left_at", null);
  if (!managers || managers.length === 0) return;
  const rows = [];
  for (const m of managers as Array<{ profile_id: string }>) {
    if (await isNotificationOptedOut(supabase, m.profile_id, "escalation_step", "in_app")) continue;
    rows.push({ profile_id: m.profile_id, oc_id: ocId, type: "escalation_step", title, body, link: link ?? null });
  }
  if (rows.length > 0) await supabase.from("notifications").insert(rows);
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

interface SweepResult { instancesCreated: number; stepsFired: number; errors: number }

export async function runEscalationSweep(today: string): Promise<SweepResult> {
  const supabase = createServerClient();
  const result: SweepResult = { instancesCreated: 0, stepsFired: 0, errors: 0 };

  // ── 1. Create instances for overdue notices that don't have an active one ──
  const { data: overdue } = await supabase
    .from("levy_notices")
    .select("id, oc_id, lot_id, reference_number, amount, amount_paid, due_date, status, owners_corporations(management_company_id)")
    .in("status", ["issued", "partially_paid", "overdue"])
    .lt("due_date", today)
    .limit(500);

  for (const n of (overdue ?? []) as Array<Record<string, unknown>>) {
    const noticeId = n.id as string;
    const { data: existing } = await supabase
      .from("escalation_instances")
      .select("id")
      .eq("levy_notice_id", noticeId)
      .eq("status", "active")
      .maybeSingle();
    if (existing) continue;

    const ocId = n.oc_id as string;
    const companyId = (n as { owners_corporations: { management_company_id?: string } | null }).owners_corporations?.management_company_id ?? null;
    const wf = await resolveWorkflowForOC(supabase, ocId, companyId);
    if (!wf) continue;
    const firstStep = wf.steps.filter((s) => s.enabled).sort((a, b) => a.step_number - b.step_number)[0];
    if (!firstStep) continue;

    const { data: refRow } = await supabase.rpc("next_reference_number", { p_prefix: "ESC" });
    await supabase.from("escalation_instances").insert({
      levy_notice_id: noticeId,
      workflow_id: wf.id,
      oc_id: ocId,
      lot_id: n.lot_id as string,
      reference_number: typeof refRow === "string" ? refRow : null,
      current_step: firstStep.step_number,
      status: "active",
      next_action_at: addDaysIso(n.due_date as string, firstStep.days_after_overdue),
    });
    result.instancesCreated++;
  }

  // ── 2. Advance due instances (one step per run) ──
  const { data: due } = await supabase
    .from("escalation_instances")
    .select("id, levy_notice_id, workflow_id, oc_id, lot_id, current_step")
    .eq("status", "active")
    .lte("next_action_at", today)
    .limit(500);

  for (const inst of (due ?? []) as Array<Record<string, unknown>>) {
    try {
      await advanceInstance(supabase, inst, today, result);
    } catch (err) {
      console.error("escalation: advance failed for instance", inst.id, err);
      result.errors++;
    }
  }

  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function advanceInstance(supabase: any, inst: Record<string, unknown>, today: string, result: SweepResult) {
  const instanceId = inst.id as string;
  const noticeId = inst.levy_notice_id as string;

  const { data: notice } = await supabase
    .from("levy_notices")
    .select("id, oc_id, lot_id, reference_number, amount, amount_paid, due_date, status, pdf_url")
    .eq("id", noticeId)
    .maybeSingle();
  if (!notice) return;

  // Paid off , resolve the follow-up.
  if (notice.status === "paid") {
    await supabase.from("escalation_instances").update({ status: "resolved", resolved_at: new Date().toISOString(), resolved_reason: "paid" }).eq("id", instanceId);
    return;
  }

  const { data: steps } = await supabase
    .from("escalation_workflow_steps")
    .select("id, step_number, step_type, label, days_after_overdue, subject, body, enabled")
    .eq("workflow_id", inst.workflow_id as string)
    .order("step_number", { ascending: true });
  const allSteps = (steps ?? []) as FollowupStep[];
  const enabledSteps = allSteps.filter((s) => s.enabled);
  const step = enabledSteps.find((s) => s.step_number === (inst.current_step as number))
    ?? enabledSteps.find((s) => s.step_number >= (inst.current_step as number));
  if (!step) {
    await supabase.from("escalation_instances").update({ status: "completed" }).eq("id", instanceId);
    return;
  }
  const finalEmailStepNumber = Math.max(...enabledSteps.filter((s) => s.step_type === "email").map((s) => s.step_number), -1);

  // Context for merge fields + PDFs.
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, plan_number, abn, address, suburb, state, postcode, interest_rate_monthly, interest_grace_period_days, interest_enabled, management_companies(name, logo_url, brand_color, phone, email, abn)")
    .eq("id", notice.oc_id)
    .maybeSingle();
  const mc = (oc as { management_companies: Record<string, unknown> | null } | null)?.management_companies ?? null;
  const ocAddress = [oc?.address, oc?.suburb, oc?.state, oc?.postcode].filter(Boolean).join(", ");

  const { data: owner } = await supabase
    .from("lot_owners")
    .select("name, email, postal_address")
    .eq("lot_id", notice.lot_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: lot } = await supabase.from("lots").select("lot_number, unit_number").eq("id", notice.lot_id).maybeSingle();

  const principal = Number(notice.amount) - Number(notice.amount_paid ?? 0);
  const ratePct = oc?.interest_enabled ? Number(oc?.interest_rate_monthly ?? 0) : 0;
  const interest = computeInterest({
    principal,
    dueDate: notice.due_date as string,
    asOf: today,
    monthlyRatePct: ratePct,
    graceDays: Number(oc?.interest_grace_period_days ?? 0),
  });
  const daysOverdue = Math.max(0, Math.floor((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${(notice.due_date as string).slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000));

  const vars: Record<string, string> = {
    owner_name: owner?.name ?? "owner",
    oc_name: oc?.name ?? "your Owners Corporation",
    reference: notice.reference_number ?? "",
    amount_due: fmtMoney(principal),
    due_date: fmtDate(notice.due_date as string),
    days_overdue: String(daysOverdue),
    interest_accrued: fmtMoney(interest.accrued),
    daily_interest: fmtMoney(interest.dailyRate),
  };

  const lotLabel = lot ? `Lot ${lot.lot_number}` : "a lot";

  if (step.step_type === "vcat") {
    // Raise the VCAT task; the manager generates the pack from the lot page.
    await supabase.from("escalation_instances").update({ vcat_ready_at: new Date().toISOString() }).eq("id", instanceId);
    await notifyOcManagers(
      supabase,
      notice.oc_id,
      `VCAT application ready for ${lotLabel}`,
      `${vars.oc_name}: levy ${vars.reference} is unpaid past the final notice. Prepare the VCAT fee-recovery pack.`,
    );
    result.stepsFired++;
  } else {
    // Email step.
    if (owner?.email) {
      let pdfBuffer: Buffer | null = null;
      let pdfFilename: string | null = null;
      const isFinal = step.step_number === finalEmailStepNumber;
      if (isFinal) {
        const brand = (mc?.brand_color as string) || "#0E314C";
        const key = await generateAndUploadFinalNotice(
          {
            managementCompany: { name: (mc?.name as string) ?? "StrataWise", logo_url: (mc?.logo_url as string) ?? null, phone: (mc?.phone as string) ?? null, email: (mc?.email as string) ?? null, abn: (mc?.abn as string) ?? null },
            oc: { name: oc?.name ?? "Owners Corporation", address: ocAddress, abn: oc?.abn ?? null, plan_number: oc?.plan_number ?? "" },
            documentTitle: "Final Fee Notice",
            referenceNumber: notice.reference_number ?? "",
            date: new Date(),
            lotOwner: { name: owner?.name ?? "", lot_number: String(lot?.lot_number ?? ""), address: owner?.postal_address ?? ocAddress },
            levyReference: notice.reference_number ?? "",
            levyDueDate: notice.due_date as string,
            amountOutstanding: principal,
            interestAccrued: interest.accrued,
            dailyInterest: interest.dailyRate,
            interestRateMonthly: ratePct,
            brandColors: { primary: brand, secondary: brand },
          },
          notice.oc_id,
          notice.reference_number ?? instanceId,
        );
        const { fetchObject } = await import("@/lib/storage/r2");
        pdfBuffer = await fetchObject(key);
        pdfFilename = `Final-notice-${notice.reference_number ?? ""}.pdf`;
        await supabase.from("escalation_instances").update({ final_notice_pdf_url: key, final_notice_served_at: new Date().toISOString() }).eq("id", instanceId);
      }

      const subject = renderTemplate(step.subject ?? "Levy payment overdue", vars);
      const body = renderTemplate(step.body ?? "", vars);
      // Manager-uploaded per-step attachment (if any).
      const extraAttachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
      if (step.attachment_url) {
        try {
          const { fetchObject } = await import("@/lib/storage/r2");
          const buf = await fetchObject(step.attachment_url);
          const ext = step.attachment_url.split(".").pop()?.toLowerCase();
          const ctype = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf";
          extraAttachments.push({ filename: step.attachment_name || `attachment.${ext ?? "pdf"}`, content: buf, contentType: ctype });
        } catch (err) {
          console.error("escalation: could not fetch step attachment", err);
        }
      }
      const res = await sendEscalationEmail({
        to: owner.email,
        subject,
        bodyText: body,
        companyLogoUrl: (mc?.logo_url as string) ?? null,
        ocId: notice.oc_id,
        pdfBuffer,
        pdfFilename,
        extraAttachments,
      });
      const sent = "success" in res;
      await supabase.from("communication_log").insert({
        oc_id: notice.oc_id,
        lot_id: notice.lot_id,
        recipient_email: owner.email,
        channel: "email",
        type: isFinal ? "levy_final_notice" : (step.label ?? "levy_followup"),
        subject,
        status: "success" in res ? "sent" : "failed",
        external_id: "success" in res ? res.id : null,
        sent_at: "success" in res ? new Date().toISOString() : null,
        related_entity_type: "escalation_instance",
        related_entity_id: instanceId,
        direction: "outbound",
        confidential: false,
      });
      if (sent) {
        result.stepsFired++;
        await notifyOcManagers(
          supabase,
          notice.oc_id,
          `${isFinal ? "Final notice" : "Reminder"} sent for ${lotLabel}`,
          `${vars.oc_name}: ${isFinal ? "final notice" : (step.label ?? "reminder")} for levy ${vars.reference} (${vars.amount_due}) was emailed to ${owner.name ?? "the owner"}.`,
        );
      }
    }
  }

  // Advance to the next enabled step, or complete.
  const nextStep = enabledSteps.find((s) => s.step_number > step.step_number);
  if (nextStep) {
    await supabase.from("escalation_instances").update({
      current_step: nextStep.step_number,
      next_action_at: addDaysIso(notice.due_date as string, nextStep.days_after_overdue),
    }).eq("id", instanceId);
  } else {
    await supabase.from("escalation_instances").update({ status: "completed" }).eq("id", instanceId);
  }
}
