import { redirect } from "next/navigation";
import { getOC } from "@/lib/actions/oc";
import { getLevyBatchDetail } from "@/lib/actions/levy";
import { createServerClient } from "@/lib/supabase";
import { BatchDetailContent } from "./batch-detail-content";

import { resolveOCFromCode } from "@/lib/oc-resolver";

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ ocCode: string; batchId: string }>;
}) {
  const { ocCode, batchId } = await params;
  const resolved = await resolveOCFromCode(ocCode);
  if (!resolved) redirect("/dashboard");
  const ocId = resolved.id;
  const [oc, batch] = await Promise.all([
    getOC(ocId),
    getLevyBatchDetail(ocId, batchId),
  ]);

  if (!oc || !batch) redirect(`/ocs/${ocCode}/levies`);

  // PP6-D-A: per-levy reminder_sent flag for the LevyStatusBadge.
  const supabase = createServerClient();
  const levyIds = batch.levies.map((l) => l.id);
  const { data: escalations } = levyIds.length > 0
    ? await supabase
        .from("escalation_instances")
        .select("levy_notice_id, current_step")
        .in("levy_notice_id", levyIds)
    : { data: [] };
  const reminderSentLevyIds = (escalations ?? [])
    .filter((e) => (e as { current_step: number }).current_step >= 1)
    .map((e) => (e as { levy_notice_id: string }).levy_notice_id);

  // Resolve the actual mailbox options the manager can send from. We
  // expose real email addresses (never the provider name "Resend"
  // etc.) so the manager sees exactly the address the recipient will
  // see. Two sources:
  //   1. The firm's connected mailbox (Gmail send-as) , the
  //      primary manager's email under the firm's domain.
  //   2. The manager's permanent StrataWise alias
  //      (<email_username>@stratawise.com.au) , always available as a
  //      fallback when the firm's mailbox isn't configured or the
  //      manager wants the StrataWise address for compliance reasons.
  // Duplicates are de-duped. When only one option exists the dialog
  // renders it as static text; with 2+, as a dropdown.
  const [{ data: mcRow }, { data: primaryManagerRow }] = await Promise.all([
    supabase
      .from("management_companies")
      .select("mail_provider, mail_provider_config")
      .eq("id", oc.management_company_id)
      .maybeSingle(),
    supabase
      .from("oc_members")
      .select("profile_id, profiles!inner(email, email_username, first_name, last_name)")
      .eq("oc_id", ocId)
      .eq("role", "strata_manager")
      .is("left_at", null)
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const mailRow = (mcRow as { mail_provider: string | null; mail_provider_config: { domain?: string } | null } | null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const primary = (primaryManagerRow as any)?.profiles as
    | { email: string | null; email_username: string | null; first_name: string | null; last_name: string | null }
    | null;
  const managerEmail = primary?.email ?? null;
  const stratawiseAlias = primary?.email_username
    ? `${primary.email_username}@stratawise.com.au`
    : null;

  const mailboxOptions: Array<{ value: string; label: string }> = [];
  // Gmail connected mailbox , surface the manager's real email
  // when the firm has a provider configured.
  if (mailRow?.mail_provider === "gmail") {
    if (managerEmail) {
      mailboxOptions.push({ value: managerEmail, label: managerEmail });
    }
  }
  // StrataWise alias always available as a secondary.
  if (stratawiseAlias) {
    if (!mailboxOptions.some((o) => o.value.toLowerCase() === stratawiseAlias.toLowerCase())) {
      mailboxOptions.push({ value: stratawiseAlias, label: stratawiseAlias });
    }
  }
  // Last-resort fallback so the dialog never shows an empty selector.
  if (mailboxOptions.length === 0) {
    mailboxOptions.push({ value: "noreply@stratawise.com.au", label: "noreply@stratawise.com.au" });
  }

  return (
    <BatchDetailContent
      ocId={ocId}
      batch={batch}
      reminderSentLevyIds={reminderSentLevyIds}
      mailboxOptions={mailboxOptions}
    />
  );
}
