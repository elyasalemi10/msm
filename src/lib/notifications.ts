// ============================================================================
// Notification helpers , framework-agnostic
// ----------------------------------------------------------------------------
// Same rules as src/lib/basiq/jobs.ts and src/lib/accrual/jobs.ts:
//   - NO "use server" directive
//   - NO imports from next/cache or @/lib/auth
//   - Takes an explicit SupabaseClient , caller passes either a service-role
//     client (server actions, cron) or a request-context client.
//
// Exports:
//   - MANDATORY_NOTIFICATION_TYPES  , Set of notification_type values that
//     bypass the per-user opt-out (statutory carve-outs).
//   - isNotificationOptedOut        , opt-out lookup with default opt-in.
//   - emitPaymentReceivedEmail      , shared payment-received helper called
//     from 3 reconciliation call sites + the orchestrator auto-match path.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sendPaymentReceivedEmail,
  sendClaimMatchedEmail,
  sendClaimRejectedEmail,
  sendNewClaimSubmittedEmail,
  type SendPaymentReceivedEmailParams,
  type SendClaimMatchedEmailParams,
  type SendClaimRejectedEmailParams,
  type SendNewClaimSubmittedEmailParams,
} from "@/lib/email";

// Notification-type constants live in their own dep-free file so
// /settings/notifications-tab.tsx (client) can import them WITHOUT
// pulling this module's email-sender imports into the client bundle.
// Re-exported here so existing server-side callers keep working.
import {
  NOTIFICATION_TYPES,
  MANDATORY_NOTIFICATION_TYPES,
  MANAGERIAL_NOTIFICATION_TYPES,
  type NotificationType,
} from "@/lib/notification-types";

export {
  NOTIFICATION_TYPES,
  MANDATORY_NOTIFICATION_TYPES,
  MANAGERIAL_NOTIFICATION_TYPES,
  type NotificationType,
};

// ─── resolveCompanyLogo (PP6-D-D-fix-logo) ──────────────────────────────
//
// Returns the management_companies.logo_url for a oc or company.
// Single round-trip per call. Two overloads via discriminated input:
//   - { ocId } → oc.management_company_id → logo_url
//   - { managementCompanyId } → direct lookup
//
// Returns null when:
//   - input has neither id
//   - oc/company not found
//   - logo_url is NULL (current default until manager-side upload UI ships
//     in Prompt 6.5)
//
// Callers pass the resolved URL to senders that accept companyLogoUrl;
// senders render <img> when present and text-only header when null
// (logoImg helper in src/lib/email.ts).

export async function resolveCompanyLogo(
  supabase: SupabaseClient,
  input: { ocId: string } | { managementCompanyId: string },
): Promise<string | null> {
  if ("managementCompanyId" in input) {
    const { data } = await supabase
      .from("management_companies")
      .select("logo_url")
      .eq("id", input.managementCompanyId)
      .maybeSingle();
    return (data as { logo_url: string | null } | null)?.logo_url ?? null;
  }
  // ocId path , single JOIN-shaped fetch.
  const { data } = await supabase
    .from("owners_corporations")
    .select("management_companies(logo_url)")
    .eq("id", input.ocId)
    .maybeSingle();
  if (!data) return null;
  // PostgREST returns the embedded relation as either an object or an
  // array depending on whether the join is many-to-one or one-to-many.
  // management_companies is the parent side here, so it should be a
  // single object , but defensively narrow either shape.
  const rel = (data as { management_companies: { logo_url: string | null } | { logo_url: string | null }[] | null }).management_companies;
  if (!rel) return null;
  if (Array.isArray(rel)) return rel[0]?.logo_url ?? null;
  return rel.logo_url ?? null;
}

export async function isNotificationOptedOut(
  supabase: SupabaseClient,
  profileId: string,
  notificationType: string,
  channel: "email" | "sms" | "voice" | "letter" | "in_app" = "email",
): Promise<boolean> {
  // Mandatory types bypass the opt-out check entirely.
  if (MANDATORY_NOTIFICATION_TYPES.has(notificationType)) return false;

  const { data } = await supabase
    .from("notification_preferences")
    .select("enabled")
    .eq("profile_id", profileId)
    .eq("notification_type", notificationType)
    .eq("channel", channel)
    .maybeSingle();

  // Default opt-in: row absence == enabled. Explicit opt-outs flip enabled
  // to false; this helper returns true (= opted out) only when the row
  // exists AND enabled === false.
  if (!data) return false;
  return !(data as { enabled: boolean }).enabled;
}

// ─── emitPaymentReceivedEmail ───────────────────────────────────────────
//
// Per PP6-C-0 spec gap 1 ratification: shared helper called from all
// payment-received emission sites (reconcileTransaction manual,
// orchestrator auto-match, depositUndepositedFunds; recordCashReceipt
// deferred per code-review surfacing , see DRAFTING NOTE below).
//
// Idempotency: bank_transactions.payment_received_email_sent_at sentinel.
// First call to this helper for a given bank tx stamps the column.
// Subsequent calls (e.g. additional allocations on a multi-allocation
// match, or unmatch-then-rematch flows) short-circuit.
//
// Multi-allocation undercount: when a single bank tx has allocations to
// multiple lots with different owners, only the first owner gets the
// email. The per-bank-tx sentinel doesn't track per-owner. Acceptable
// trade-off for PP6-C-1 , multi-lot bank txs are rare in practice;
// PRE_LAUNCH_CLEANUP can add per-(bank_tx, profile) tracking if needed.
//
// recordCashReceipt: NOT a call site. No bank_transaction_id exists at
// receipt time (the credit is untargeted; bank tx linkage happens at
// depositUndepositedFunds). Owner gets the email at deposit time, which
// is also semantically when "payment received" actually means "funds
// in bank account". See PP6-C-1 code review pause for surfacing.

export type EmitPaymentReceivedResult =
  | { sent: true; communicationLogId: string }
  | { skipped: true; reason: "already_sent" | "no_bank_tx" | "no_owner" | "opted_out" | "dry_run" }
  | { failed: true; error: string };

export interface EmitPaymentReceivedInput {
  ledgerCreditId: string;
  performedBy: string | null; // profile id of the actor (null for cron)
}

export async function emitPaymentReceivedEmail(
  supabase: SupabaseClient,
  input: EmitPaymentReceivedInput,
): Promise<EmitPaymentReceivedResult> {
  const { ledgerCreditId, performedBy } = input;

  // Step 1: resolve ledger credit + linked bank tx via reconciliation_matches.
  const { data: matchRow } = await supabase
    .from("reconciliation_matches")
    .select("bank_transaction_id, ledger_entry_id")
    .eq("ledger_entry_id", ledgerCreditId)
    .limit(1)
    .maybeSingle();
  const bankTxId = (matchRow as { bank_transaction_id: string } | null)
    ?.bank_transaction_id;
  if (!bankTxId) {
    return { skipped: true, reason: "no_bank_tx" };
  }

  // Step 2: load bank tx (sentinel) + ledger credit (lot/fund/amount/levy).
  const [{ data: bankTx }, { data: credit }] = await Promise.all([
    supabase
      .from("bank_transactions")
      .select(
        "id, payment_received_email_sent_at, transaction_date, description, amount, bank_account_id",
      )
      .eq("id", bankTxId)
      .single(),
    supabase
      .from("lot_ledger_entries")
      .select("id, lot_id, oc_id, fund_type, amount, levy_notice_id, reference")
      .eq("id", ledgerCreditId)
      .single(),
  ]);

  if (!bankTx || !credit) {
    return { skipped: true, reason: "no_bank_tx" };
  }
  const tx = bankTx as {
    id: string;
    payment_received_email_sent_at: string | null;
    transaction_date: string;
    description: string | null;
    amount: number | string;
    bank_account_id: string;
  };
  const cr = credit as {
    id: string;
    lot_id: string;
    oc_id: string;
    fund_type: string;
    amount: number | string;
    levy_notice_id: string | null;
    reference: string | null;
  };

  // Idempotency short-circuit.
  if (tx.payment_received_email_sent_at !== null) {
    return { skipped: true, reason: "already_sent" };
  }

  // Step 3: resolve owner via oc_members (active, lot-scoped).
  const { data: memberRow } = await supabase
    .from("oc_members")
    .select("profile_id")
    .eq("oc_id", cr.oc_id)
    .eq("lot_id", cr.lot_id)
    .eq("role", "lot_owner")
    .eq("is_primary_contact", true)
    .maybeSingle();
  const ownerProfileId = (memberRow as { profile_id: string } | null)
    ?.profile_id;
  if (!ownerProfileId) {
    return { skipped: true, reason: "no_owner" };
  }

  // Step 4: opt-out check.
  const optedOut = await isNotificationOptedOut(
    supabase,
    ownerProfileId,
    "payment_received",
    "email",
  );
  if (optedOut) {
    return { skipped: true, reason: "opted_out" };
  }

  // Step 5: load owner email + name + oc context for body shape.
  const [{ data: owner }, { data: sub }, { data: lot }] = await Promise.all([
    supabase
      .from("profiles")
      .select("email, first_name, last_name")
      .eq("id", ownerProfileId)
      .single(),
    supabase
      .from("owners_corporations")
      .select("name, address, short_code")
      .eq("id", cr.oc_id)
      .single(),
    supabase
      .from("lots")
      .select("lot_number, unit_number")
      .eq("id", cr.lot_id)
      .single(),
  ]);

  const ownerEmail = (owner as { email: string } | null)?.email;
  if (!ownerEmail) {
    return { skipped: true, reason: "no_owner" };
  }
  const ownerName = formatOwnerName(
    owner as { first_name: string | null; last_name: string | null } | null,
  );
  const ocName =
    (sub as { name: string } | null)?.name ?? "Your oc";
  const ocAddress =
    (sub as { address: string } | null)?.address ?? "";
  const lotLabel = formatLotLabel(
    lot as { lot_number: number; unit_number: string | null } | null,
  );
  const ocShortCode =
    (sub as { short_code: string } | null)?.short_code ?? "";
  const companyLogoUrl = await resolveCompanyLogo(supabase, {
    ocId: cr.oc_id,
  });

  const params: SendPaymentReceivedEmailParams = {
    to: ownerEmail,
    ownerName,
    ocName,
    ocAddress,
    amount: Number(cr.amount),
    paymentDate: tx.transaction_date,
    description: tx.description ?? "",
    lotLabel,
    reference: cr.reference,
    ocShortCode,
    companyLogoUrl,
    ocId: cr.oc_id,
  };

  // Step 6: communication_log insert (queued state).
  const { data: logRow, error: logErr } = await supabase
    .from("communication_log")
    .insert({
      oc_id: cr.oc_id,
      recipient_id: ownerProfileId,
      recipient_email: ownerEmail,
      channel: "email",
      type: "payment_received",
      subject: `Payment received , ${ocName}`,
      body_preview: buildBodyPreview(params),
      status: "queued",
      related_entity_type: "bank_transaction",
      related_entity_id: tx.id,
    })
    .select("id")
    .single();
  if (logErr || !logRow) {
    console.error(
      "emitPaymentReceivedEmail: communication_log insert failed",
      logErr,
    );
    return {
      failed: true,
      error: logErr?.message ?? "communication_log insert failed",
    };
  }
  const communicationLogId = (logRow as { id: string }).id;

  // Step 7: send via Resend.
  const sendResult = await sendPaymentReceivedEmail(params);

  if ("error" in sendResult) {
    await supabase
      .from("communication_log")
      .update({
        status: "failed",
        error_message: sendResult.error.slice(0, 500),
      })
      .eq("id", communicationLogId);
    return { failed: true, error: sendResult.error };
  }

  // Step 8: success , stamp sentinel FIRST, then transition log to 'sent'.
  // Serialized (not Promise.all) so an error on the sentinel stamp is caught
  // and surfaced before the log row claims 'sent'. Failure modes:
  //   - Sentinel UPDATE fails: log stays 'queued', loud warn for forensics.
  //     Next attempt will re-resolve, see no sentinel, and may re-send ,
  //     narrow window worth tracking but not blocking.
  //   - Sentinel UPDATE succeeds, log UPDATE fails: email is out + sentinel
  //     stamped, so the next call short-circuits correctly. The 'queued'
  //     log row is the only forensics breadcrumb of the partial state.
  const sentAt = new Date().toISOString();
  const { error: stampErr } = await supabase
    .from("bank_transactions")
    .update({ payment_received_email_sent_at: sentAt })
    .eq("id", tx.id);
  if (stampErr) {
    console.warn(
      "emitPaymentReceivedEmail: sentinel stamp failed after Resend success , communication_log will stay 'queued' for forensics; risk of double-send on next attempt",
      stampErr,
    );
  }

  await supabase
    .from("communication_log")
    .update({
      status: "sent",
      sent_at: sentAt,
      external_id: sendResult.id,
    })
    .eq("id", communicationLogId);

  await supabase.from("audit_log").insert({
    profile_id: performedBy,
    oc_id: cr.oc_id,
    action: "communication.payment_received.sent",
    entity_type: "bank_transaction",
    entity_id: tx.id,
    metadata: {
      ledger_credit_id: ledgerCreditId,
      communication_log_id: communicationLogId,
      recipient_profile_id: ownerProfileId,
    },
  });

  return { sent: true, communicationLogId };
}

// ─── emitClaimMatchedEmail (PP6-C-1) ────────────────────────────────────
//
// Called from confirmAndMatchClaimViaExistingBankTx and
// confirmAndMatchClaimViaNewBankTx after the match commits. Looks up the
// claim, owner, oc, lot; sends sendClaimMatchedEmail. Writes
// communication_log + audit_log. No idempotency sentinel , the claim
// terminal state ('matched') is the de-facto idempotency guard (the
// confirmAndMatch* actions hard-error if claim_status !== 'pending').

export interface EmitClaimMatchedInput {
  claimId: string;
  performedBy: string;
}

export async function emitClaimMatchedEmail(
  supabase: SupabaseClient,
  input: EmitClaimMatchedInput,
): Promise<void> {
  const ctx = await loadClaimContext(supabase, input.claimId);
  if (!ctx) return;
  const { claim, ownerEmail, ownerProfileId, ownerName, ocName, ocAddress, ocShortCode, lotLabel } = ctx;

  const optedOut = await isNotificationOptedOut(
    supabase,
    ownerProfileId,
    "claim_matched",
    "email",
  );
  if (optedOut) return;

  const companyLogoUrl = await resolveCompanyLogo(supabase, {
    ocId: claim.oc_id,
  });

  const params: SendClaimMatchedEmailParams = {
    to: ownerEmail,
    ownerName,
    ocName,
    ocAddress,
    amount: Number(claim.amount),
    claimDate: claim.claim_date,
    paymentMethod: claim.payment_method ?? "",
    lotLabel,
    ocShortCode,
    companyLogoUrl,
    ocId: claim.oc_id,
  };

  const { data: logRow } = await supabase
    .from("communication_log")
    .insert({
      oc_id: claim.oc_id,
      recipient_id: ownerProfileId,
      recipient_email: ownerEmail,
      channel: "email",
      type: "claim_matched",
      subject: `Your payment has been confirmed , ${ocName}`,
      body_preview: `Your payment claim of $${Number(claim.amount).toFixed(2)} for ${lotLabel} has been confirmed.`.slice(0, 300),
      status: "queued",
      related_entity_type: "owner_payment_claim",
      related_entity_id: claim.id,
    })
    .select("id")
    .single();
  const communicationLogId = (logRow as { id: string } | null)?.id;
  if (!communicationLogId) {
    console.error("emitClaimMatchedEmail: communication_log insert failed");
    return;
  }

  const result = await sendClaimMatchedEmail(params);
  await persistSenderResult(supabase, {
    communicationLogId,
    result,
    auditAction: "communication.claim_matched",
    auditEntityType: "owner_payment_claim",
    auditEntityId: claim.id,
    ocId: claim.oc_id,
    performedBy: input.performedBy,
    metadata: { recipient_profile_id: ownerProfileId },
  });
}

// ─── emitClaimRejectedEmail (PP6-C-1) ───────────────────────────────────
//
// Called from rejectPaymentClaim after the rejection commits. Same shape
// as emitClaimMatchedEmail; rejection_reason embedded in body. No
// idempotency sentinel (terminal claim state guards re-emission).

export interface EmitClaimRejectedInput {
  claimId: string;
  rejectionReason: string;
  performedBy: string;
}

export async function emitClaimRejectedEmail(
  supabase: SupabaseClient,
  input: EmitClaimRejectedInput,
): Promise<void> {
  const ctx = await loadClaimContext(supabase, input.claimId);
  if (!ctx) return;
  const { claim, ownerEmail, ownerProfileId, ownerName, ocName, ocAddress, ocShortCode, lotLabel } = ctx;

  const optedOut = await isNotificationOptedOut(
    supabase,
    ownerProfileId,
    "claim_rejected",
    "email",
  );
  if (optedOut) return;

  const companyLogoUrl = await resolveCompanyLogo(supabase, {
    ocId: claim.oc_id,
  });

  const params: SendClaimRejectedEmailParams = {
    to: ownerEmail,
    ownerName,
    ocName,
    ocAddress,
    amount: Number(claim.amount),
    claimDate: claim.claim_date,
    rejectionReason: input.rejectionReason,
    lotLabel,
    ocShortCode,
    companyLogoUrl,
    ocId: claim.oc_id,
  };

  const { data: logRow } = await supabase
    .from("communication_log")
    .insert({
      oc_id: claim.oc_id,
      recipient_id: ownerProfileId,
      recipient_email: ownerEmail,
      channel: "email",
      type: "claim_rejected",
      subject: `Update on your payment claim , ${ocName}`,
      body_preview: `Your payment claim of $${Number(claim.amount).toFixed(2)} for ${lotLabel} was not matched.`.slice(0, 300),
      status: "queued",
      related_entity_type: "owner_payment_claim",
      related_entity_id: claim.id,
    })
    .select("id")
    .single();
  const communicationLogId = (logRow as { id: string } | null)?.id;
  if (!communicationLogId) {
    console.error("emitClaimRejectedEmail: communication_log insert failed");
    return;
  }

  const result = await sendClaimRejectedEmail(params);
  await persistSenderResult(supabase, {
    communicationLogId,
    result,
    auditAction: "communication.claim_rejected",
    auditEntityType: "owner_payment_claim",
    auditEntityId: claim.id,
    ocId: claim.oc_id,
    performedBy: input.performedBy,
    metadata: {
      recipient_profile_id: ownerProfileId,
      rejection_reason: input.rejectionReason,
    },
  });
}

// ─── emitNewClaimSubmitted (PP6-C-2) ────────────────────────────────────
//
// Fan-out to all active strata managers of the claim's oc. Per
// manager: sends sendNewClaimSubmittedEmail (opt-out-respecting) AND
// writes a notifications row (always , managerial events are not
// in-app-opt-outable per PP6-C-0 SG-2 ratification).
//
// Email path uses the existing sender → communication_log → audit chain.
// In-app path uses createNotification() from src/lib/actions/notifications.ts
// (already exported there for cross-action callers).

export interface EmitNewClaimSubmittedInput {
  claimId: string;
  performedBy: string;
}

export async function emitNewClaimSubmitted(
  supabase: SupabaseClient,
  input: EmitNewClaimSubmittedInput,
): Promise<void> {
  const ctx = await loadClaimContext(supabase, input.claimId);
  if (!ctx) return;
  const { claim, ownerName, ocName, ocShortCode, lotLabel } = ctx;

  // In-app link is always a relative path (rendered inside the dashboard,
  // not in email); email CTA URL is built by the sender via
  // NEXT_PUBLIC_APP_URL + ocShortCode.
  const reviewPath = ocShortCode
    ? `/ocs/${ocShortCode}/reconciliation/claims`
    : "/reconciliation/claims";

  // Active managers for this oc.
  const { data: managerRows } = await supabase
    .from("oc_members")
    .select("profile_id")
    .eq("oc_id", claim.oc_id)
    .eq("role", "strata_manager")
    .is("left_at", null);
  const managerProfileIds = Array.from(
    new Set(
      (managerRows ?? []).map(
        (r) => (r as { profile_id: string }).profile_id,
      ),
    ),
  );
  if (managerProfileIds.length === 0) return;

  // Resolve company logo once for the fanout , same oc → same logo
  // for every manager.
  const companyLogoUrl = await resolveCompanyLogo(supabase, {
    ocId: claim.oc_id,
  });

  // Hydrate manager profiles in one round-trip.
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, email, first_name, last_name")
    .in("id", managerProfileIds);
  const managers = (profiles ?? []) as Array<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
  }>;

  for (const m of managers) {
    // ─── In-app notification (always written for managerial events) ─
    // Per PP6-C-0 SG-2 ratification: in-app is not opt-out-able for
    // operational manager signals; only the email channel respects
    // notification_preferences. Inlined INSERT (not via the
    // src/lib/actions/notifications.ts createNotification helper) because
    // this module is framework-agnostic and must not import "use server"
    // actions , same boundary rule as PP6-C-1.
    await supabase.from("notifications").insert({
      profile_id: m.id,
      oc_id: claim.oc_id,
      type: "new_claim_submitted",
      title: `New payment claim , ${lotLabel}`,
      body: `${ownerName ?? "An owner"} submitted a payment claim of $${Number(claim.amount).toFixed(2)} for ${lotLabel}.`,
      link: reviewPath,
    });

    // ─── Email path (opt-out-respecting) ────────────────────────────
    const optedOut = await isNotificationOptedOut(
      supabase,
      m.id,
      "new_claim_submitted",
      "email",
    );
    if (optedOut || !m.email) continue;

    const params: SendNewClaimSubmittedEmailParams = {
      to: m.email,
      managerName: formatOwnerName({
        first_name: m.first_name,
        last_name: m.last_name,
      }),
      ocName,
      lotLabel,
      ownerName,
      amount: Number(claim.amount),
      claimDate: claim.claim_date,
      paymentMethod: claim.payment_method ?? "",
      notes: null,
      ocShortCode,
      companyLogoUrl,
      ocId: claim.oc_id,
    };

    const { data: logRow } = await supabase
      .from("communication_log")
      .insert({
        oc_id: claim.oc_id,
        recipient_id: m.id,
        recipient_email: m.email,
        channel: "email",
        type: "new_claim_submitted",
        subject: `New owner payment claim , ${ocName} ${lotLabel}`,
        body_preview: `${ownerName ?? "An owner"} submitted a $${Number(claim.amount).toFixed(2)} claim for ${lotLabel}.`.slice(0, 300),
        status: "queued",
        related_entity_type: "owner_payment_claim",
        related_entity_id: claim.id,
      })
      .select("id")
      .single();
    const communicationLogId = (logRow as { id: string } | null)?.id;
    if (!communicationLogId) {
      console.error(
        "emitNewClaimSubmitted: communication_log insert failed",
      );
      continue;
    }

    const result = await sendNewClaimSubmittedEmail(params);
    await persistSenderResult(supabase, {
      communicationLogId,
      result,
      auditAction: "communication.new_claim_submitted",
      auditEntityType: "owner_payment_claim",
      auditEntityId: claim.id,
      ocId: claim.oc_id,
      performedBy: input.performedBy,
      metadata: { recipient_profile_id: m.id },
    });
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────

interface ClaimContext {
  claim: {
    id: string;
    oc_id: string;
    lot_id: string;
    claimed_by_profile_id: string;
    amount: number | string;
    claim_date: string;
    payment_method: string | null;
  };
  ownerEmail: string;
  ownerProfileId: string;
  ownerName: string | null;
  ocName: string;
  ocAddress: string;
  ocShortCode: string;
  lotLabel: string;
}

async function loadClaimContext(
  supabase: SupabaseClient,
  claimId: string,
): Promise<ClaimContext | null> {
  const { data: claim } = await supabase
    .from("owner_payment_claims")
    .select(
      "id, oc_id, lot_id, claimed_by_profile_id, amount, claim_date, payment_method",
    )
    .eq("id", claimId)
    .single();
  if (!claim) return null;
  const c = claim as ClaimContext["claim"];

  const [{ data: owner }, { data: sub }, { data: lot }] = await Promise.all([
    supabase
      .from("profiles")
      .select("email, first_name, last_name")
      .eq("id", c.claimed_by_profile_id)
      .single(),
    supabase
      .from("owners_corporations")
      .select("name, address, short_code")
      .eq("id", c.oc_id)
      .single(),
    supabase
      .from("lots")
      .select("lot_number, unit_number")
      .eq("id", c.lot_id)
      .single(),
  ]);
  const ownerEmail = (owner as { email: string } | null)?.email;
  if (!ownerEmail) return null;

  return {
    claim: c,
    ownerEmail,
    ownerProfileId: c.claimed_by_profile_id,
    ownerName: formatOwnerName(
      owner as { first_name: string | null; last_name: string | null } | null,
    ),
    ocName: (sub as { name: string } | null)?.name ?? "Your oc",
    ocAddress: (sub as { address: string } | null)?.address ?? "",
    ocShortCode: (sub as { short_code: string } | null)?.short_code ?? "",
    lotLabel: formatLotLabel(
      lot as { lot_number: number; unit_number: string | null } | null,
    ),
  };
}

interface PersistSenderResultArgs {
  communicationLogId: string;
  result:
    | { success: true; id: string | null }
    | { error: string };
  auditAction: string;
  auditEntityType: string;
  auditEntityId: string;
  ocId: string;
  performedBy: string | null;
  metadata: Record<string, unknown>;
}

async function persistSenderResult(
  supabase: SupabaseClient,
  args: PersistSenderResultArgs,
): Promise<void> {
  const { communicationLogId, result, auditAction, auditEntityType, auditEntityId, ocId, performedBy, metadata } = args;

  if ("error" in result) {
    await supabase
      .from("communication_log")
      .update({
        status: "failed",
        error_message: result.error.slice(0, 500),
      })
      .eq("id", communicationLogId);
    return;
  }

  await Promise.all([
    supabase
      .from("communication_log")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        external_id: result.id,
      })
      .eq("id", communicationLogId),
    supabase.from("audit_log").insert({
      profile_id: performedBy,
      oc_id: ocId,
      action: `${auditAction}.sent`,
      entity_type: auditEntityType,
      entity_id: auditEntityId,
      metadata: { ...metadata, communication_log_id: communicationLogId },
    }),
  ]);
}

function formatOwnerName(profile: {
  first_name: string | null;
  last_name: string | null;
} | null): string | null {
  if (!profile) return null;
  const f = profile.first_name?.trim() ?? "";
  const l = profile.last_name?.trim() ?? "";
  const full = `${f} ${l}`.trim();
  return full.length > 0 ? full : null;
}

function formatLotLabel(
  lot: { lot_number: number; unit_number: string | null } | null,
): string {
  if (!lot) return "";
  if (lot.unit_number) return `Lot ${lot.lot_number} (Unit ${lot.unit_number})`;
  return `Lot ${lot.lot_number}`;
}

function buildBodyPreview(params: SendPaymentReceivedEmailParams): string {
  const amount = `$${params.amount.toFixed(2)}`;
  return `Payment of ${amount} received for ${params.lotLabel} (${params.paymentDate}).`.slice(
    0,
    300,
  );
}
