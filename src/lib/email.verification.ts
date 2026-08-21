/**
 * Email + notification helpers verification (PP6-C-1).
 *
 * Covers:
 *   - isNotificationOptedOut (opt-in default, opt-out row, mandatory bypass)
 *   - emitPaymentReceivedEmail (dry-run, idempotency, opt-out, no-bank-tx, no-owner)
 *   - emitClaimMatchedEmail (dry-run, opt-out)
 *   - emitClaimRejectedEmail (dry-run, opt-out, rejection_reason in body_preview)
 *
 * emails fire. Assertions read communication_log, audit_log, and the
 * payment_received_email_sent_at sentinel column directly.
 *
 * Usage:
 *   npx tsx src/lib/email.verification.ts
 *   npx tsx src/lib/email.verification.ts --no-cleanup
 *   npx tsx src/lib/email.verification.ts --cleanup
 */

import { config } from "dotenv";
config({ path: ".env.local" });

// Force dry-run for the whole suite. Set BEFORE importing email.ts so the
// module-level isDryRun() reads the override.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { generateOCCode } from "@/lib/oc-code";
import {
  emitPaymentReceivedEmail,
  emitClaimMatchedEmail,
  emitClaimRejectedEmail,
  isNotificationOptedOut,
  MANDATORY_NOTIFICATION_TYPES,
} from "./notifications";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const VERIFY_MARKER = "__VERIFY_EMAIL__";
const supabase = createClient(supabaseUrl, serviceRoleKey);

type Result = { scenario: string; passed: boolean; detail: string };
const results: Result[] = [];

function record(scenario: string, passed: boolean, detail: string) {
  results.push({ scenario, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${scenario}${detail ? " , " + detail : ""}`);
}

// ─── Fixture builders ──────────────────────────────────────────────────

interface FixtureContext {
  companyId: string;
  managerProfileId: string;
  ownerProfileId: string;
  ocId: string;
  lotId: string;
  bankAccountId: string;
}

async function createFixture(): Promise<FixtureContext> {
  const runId = `${Date.now()}_${randomUUID().slice(0, 6)}`;

  const { data: company } = await supabase
    .from("management_companies")
    .insert({ name: `${VERIFY_MARKER}${runId}` })
    .select("id")
    .single();
  const companyId = (company as { id: string }).id;

  const { data: manager } = await supabase
    .from("profiles")
    .insert({
      auth_user_id: `${VERIFY_MARKER}_MGR_${runId}`,
      email: `${VERIFY_MARKER.toLowerCase()}${runId}_mgr@email.test`,
      first_name: "Email",
      last_name: "TestMgr",
      role: "strata_manager",
      company_role: "admin",
      management_company_id: companyId,
    })
    .select("id")
    .single();
  const managerProfileId = (manager as { id: string }).id;

  const { data: owner } = await supabase
    .from("profiles")
    .insert({
      auth_user_id: `${VERIFY_MARKER}_OWNER_${runId}`,
      email: `${VERIFY_MARKER.toLowerCase()}${runId}_owner@email.test`,
      first_name: "Email",
      last_name: "TestOwner",
      role: "lot_owner",
    })
    .select("id")
    .single();
  const ownerProfileId = (owner as { id: string }).id;

  const { data: oc } = await supabase
    .from("owners_corporations")
    .insert({
      management_company_id: companyId,
      name: `${VERIFY_MARKER}${runId}`,
      plan_number: `PLAN-${runId}`,
      short_code: generateOCCode(),
      address: `${runId} Email Test St, Melbourne VIC 3000`,
      total_lots: 1,
      created_by: managerProfileId,
    })
    .select("id")
    .single();
  const ocId = (oc as { id: string }).id;

  const { data: lot } = await supabase
    .from("lots")
    .insert({
      oc_id: ocId,
      lot_number: 1,
      lot_entitlement: 100,
      lot_liability: 100,
    })
    .select("id")
    .single();
  const lotId = (lot as { id: string }).id;

  await supabase.from("oc_members").insert({
    oc_id: ocId,
    profile_id: ownerProfileId,
    lot_id: lotId,
    role: "lot_owner",
    is_primary_contact: true,
    is_financial: true,
  });

  const { data: bankAccount } = await supabase
    .from("bank_accounts")
    .insert({
      oc_id: ocId,
      account_name: `Email Admin ${runId}`,
      bsb: "012-345",
      account_number: `${runId.slice(-8)}`,
      fund_type: "operating",
    })
    .select("id")
    .single();
  const bankAccountId = (bankAccount as { id: string }).id;

  return {
    companyId,
    managerProfileId,
    ownerProfileId,
    ocId,
    lotId,
    bankAccountId,
  };
}

interface BankTxFixture {
  bankTxId: string;
  ledgerCreditId: string;
  matchId: string;
}

async function createMatchedBankTxFixture(
  ctx: FixtureContext,
  amount = 250,
): Promise<BankTxFixture> {
  // Create bank tx
  const { data: bt } = await supabase
    .from("bank_transactions")
    .insert({
      bank_account_id: ctx.bankAccountId,
      source: "manual",
      transaction_date: "2026-04-15",
      amount,
      description: "PP6-C-1 verify bank tx",
      match_status: "manually_matched",
      matched_total: amount,
    })
    .select("id")
    .single();
  const bankTxId = (bt as { id: string }).id;

  // Create ledger credit
  const { data: credit } = await supabase
    .from("lot_ledger_entries")
    .insert({
      oc_id: ctx.ocId,
      lot_id: ctx.lotId,
      fund_type: "operating",
      entry_type: "credit",
      category: "payment",
      amount,
      entry_date: "2026-04-15",
      reference: "VERIFY-CREDIT",
      status: "active",
      created_by: ctx.managerProfileId,
    })
    .select("id")
    .single();
  const ledgerCreditId = (credit as { id: string }).id;

  // Link via reconciliation_matches
  const { data: match } = await supabase
    .from("reconciliation_matches")
    .insert({
      bank_transaction_id: bankTxId,
      ledger_entry_id: ledgerCreditId,
      amount_matched: amount,
      match_method: "manual",
      match_confidence: "manual",
    })
    .select("id")
    .single();
  const matchId = (match as { id: string }).id;

  return { bankTxId, ledgerCreditId, matchId };
}

async function createPendingClaimFixture(
  ctx: FixtureContext,
  amount = 250,
): Promise<string> {
  const { data: claim } = await supabase
    .from("owner_payment_claims")
    .insert({
      oc_id: ctx.ocId,
      lot_id: ctx.lotId,
      claimed_by_profile_id: ctx.ownerProfileId,
      amount,
      claim_date: "2026-04-15",
      payment_method: "eft",
      claim_status: "pending",
    })
    .select("id")
    .single();
  return (claim as { id: string }).id;
}

// ─── Scenarios ─────────────────────────────────────────────────────────

async function e1_optedOutDefaultOptIn(ctx: FixtureContext) {
  const out = await isNotificationOptedOut(
    supabase,
    ctx.ownerProfileId,
    "payment_received",
    "email",
  );
  record("E-1: isNotificationOptedOut default opt-in (no row → false)", out === false, `out=${out}`);
}

async function e2_optedOutExplicitOff(ctx: FixtureContext) {
  await supabase.from("notification_preferences").insert({
    profile_id: ctx.ownerProfileId,
    notification_type: "payment_received",
    channel: "email",
    enabled: false,
  });
  const out = await isNotificationOptedOut(
    supabase,
    ctx.ownerProfileId,
    "payment_received",
    "email",
  );
  await supabase
    .from("notification_preferences")
    .delete()
    .eq("profile_id", ctx.ownerProfileId)
    .eq("notification_type", "payment_received");
  record("E-2: isNotificationOptedOut returns true on explicit opt-out row", out === true, `out=${out}`);
}

async function e3_mandatoryBypass(ctx: FixtureContext) {
  // Pick a known mandatory type from the constant.
  const mandatoryType = Array.from(MANDATORY_NOTIFICATION_TYPES)[0] ?? "levy_final_notice";
  await supabase.from("notification_preferences").insert({
    profile_id: ctx.ownerProfileId,
    notification_type: mandatoryType,
    channel: "email",
    enabled: false,
  });
  const out = await isNotificationOptedOut(
    supabase,
    ctx.ownerProfileId,
    mandatoryType,
    "email",
  );
  await supabase
    .from("notification_preferences")
    .delete()
    .eq("profile_id", ctx.ownerProfileId)
    .eq("notification_type", mandatoryType);
  record("E-3: MANDATORY_NOTIFICATION_TYPES bypasses opt-out row", out === false, `mandatoryType=${mandatoryType} out=${out}`);
}

async function e4_emitPaymentDryRun(ctx: FixtureContext) {
  const fx = await createMatchedBankTxFixture(ctx, 100);
  const result = await emitPaymentReceivedEmail(supabase, {
    ledgerCreditId: fx.ledgerCreditId,
    performedBy: ctx.managerProfileId,
  });

  // Sentinel must remain NULL (dry-run doesn't stamp).
  const { data: tx } = await supabase
    .from("bank_transactions")
    .select("payment_received_email_sent_at")
    .eq("id", fx.bankTxId)
    .single();
  const stamped = (tx as { payment_received_email_sent_at: string | null }).payment_received_email_sent_at;

  // communication_log row exists, status='queued'.
  const { data: log } = await supabase
    .from("communication_log")
    .select("status, type, recipient_id")
    .eq("related_entity_type", "bank_transaction")
    .eq("related_entity_id", fx.bankTxId)
    .single();
  const l = log as { status: string; type: string; recipient_id: string } | null;

  // Audit log dry-run row.
  const { data: audit } = await supabase
    .from("audit_log")
    .select("action")
    .eq("entity_type", "bank_transaction")
    .eq("entity_id", fx.bankTxId)
    .eq("action", "communication.payment_received.dry_run")
    .maybeSingle();

  const ok =
    "skipped" in result &&
    result.reason === "dry_run" &&
    stamped === null &&
    !!l &&
    l.status === "queued" &&
    l.type === "payment_received" &&
    l.recipient_id === ctx.ownerProfileId &&
    !!audit;
  record(
    "E-4: emitPaymentReceivedEmail dry-run → log queued, sentinel NULL, audit dry_run row",
    ok,
    `result=${JSON.stringify(result)} stamped=${stamped} log_status=${l?.status} audit=${audit ? "yes" : "no"}`,
  );
}

async function e5_emitPaymentIdempotency(ctx: FixtureContext) {
  const fx = await createMatchedBankTxFixture(ctx, 110);

  // Pre-stamp the sentinel manually to simulate already-sent state.
  await supabase
    .from("bank_transactions")
    .update({ payment_received_email_sent_at: new Date().toISOString() })
    .eq("id", fx.bankTxId);

  const result = await emitPaymentReceivedEmail(supabase, {
    ledgerCreditId: fx.ledgerCreditId,
    performedBy: ctx.managerProfileId,
  });

  const { count: logCount } = await supabase
    .from("communication_log")
    .select("id", { count: "exact", head: true })
    .eq("related_entity_id", fx.bankTxId);

  const ok = "skipped" in result && result.reason === "already_sent" && logCount === 0;
  record(
    "E-5: emitPaymentReceivedEmail short-circuits when sentinel non-null",
    ok,
    `reason=${"reason" in result ? result.reason : "?"} log_count=${logCount}`,
  );
}

async function e6_emitPaymentOptedOut(ctx: FixtureContext) {
  const fx = await createMatchedBankTxFixture(ctx, 120);
  await supabase.from("notification_preferences").insert({
    profile_id: ctx.ownerProfileId,
    notification_type: "payment_received",
    channel: "email",
    enabled: false,
  });

  const result = await emitPaymentReceivedEmail(supabase, {
    ledgerCreditId: fx.ledgerCreditId,
    performedBy: ctx.managerProfileId,
  });

  await supabase
    .from("notification_preferences")
    .delete()
    .eq("profile_id", ctx.ownerProfileId)
    .eq("notification_type", "payment_received");

  const { count: logCount } = await supabase
    .from("communication_log")
    .select("id", { count: "exact", head: true })
    .eq("related_entity_id", fx.bankTxId);

  const ok = "skipped" in result && result.reason === "opted_out" && logCount === 0;
  record(
    "E-6: emitPaymentReceivedEmail respects opt-out preference",
    ok,
    `reason=${"reason" in result ? result.reason : "?"} log_count=${logCount}`,
  );
}

async function e7_emitPaymentNoBankTx(ctx: FixtureContext) {
  // Create a bare ledger credit with no reconciliation_matches link.
  const { data: credit } = await supabase
    .from("lot_ledger_entries")
    .insert({
      oc_id: ctx.ocId,
      lot_id: ctx.lotId,
      fund_type: "operating",
      entry_type: "credit",
      category: "payment",
      amount: 50,
      entry_date: "2026-04-15",
      status: "active",
      created_by: ctx.managerProfileId,
    })
    .select("id")
    .single();
  const orphanCreditId = (credit as { id: string }).id;

  const result = await emitPaymentReceivedEmail(supabase, {
    ledgerCreditId: orphanCreditId,
    performedBy: ctx.managerProfileId,
  });

  const ok = "skipped" in result && result.reason === "no_bank_tx";
  record(
    "E-7: emitPaymentReceivedEmail skips when no reconciliation_matches link",
    ok,
    `reason=${"reason" in result ? result.reason : "?"}`,
  );
}

async function e8_emitPaymentNoOwner(ctx: FixtureContext) {
  // Create a fixture with a lot that has no owner assigned.
  const { data: orphanLot } = await supabase
    .from("lots")
    .insert({
      oc_id: ctx.ocId,
      lot_number: 99,
      lot_entitlement: 100,
      lot_liability: 100,
    })
    .select("id")
    .single();
  const orphanLotId = (orphanLot as { id: string }).id;

  const { data: bt } = await supabase
    .from("bank_transactions")
    .insert({
      bank_account_id: ctx.bankAccountId,
      source: "manual",
      transaction_date: "2026-04-15",
      amount: 60,
      description: "no-owner test",
      match_status: "manually_matched",
      matched_total: 60,
    })
    .select("id")
    .single();
  const bankTxId = (bt as { id: string }).id;

  const { data: credit } = await supabase
    .from("lot_ledger_entries")
    .insert({
      oc_id: ctx.ocId,
      lot_id: orphanLotId,
      fund_type: "operating",
      entry_type: "credit",
      category: "payment",
      amount: 60,
      entry_date: "2026-04-15",
      status: "active",
      created_by: ctx.managerProfileId,
    })
    .select("id")
    .single();
  const creditId = (credit as { id: string }).id;

  await supabase.from("reconciliation_matches").insert({
    bank_transaction_id: bankTxId,
    ledger_entry_id: creditId,
    amount_matched: 60,
    match_method: "manual",
    match_confidence: "manual",
  });

  const result = await emitPaymentReceivedEmail(supabase, {
    ledgerCreditId: creditId,
    performedBy: ctx.managerProfileId,
  });

  const ok = "skipped" in result && result.reason === "no_owner";
  record(
    "E-8: emitPaymentReceivedEmail skips when lot has no owner member",
    ok,
    `reason=${"reason" in result ? result.reason : "?"}`,
  );
}

async function e9_emitClaimMatchedDryRun(ctx: FixtureContext) {
  const claimId = await createPendingClaimFixture(ctx, 130);

  await emitClaimMatchedEmail(supabase, {
    claimId,
    performedBy: ctx.managerProfileId,
  });

  const { data: log } = await supabase
    .from("communication_log")
    .select("type, status, recipient_id")
    .eq("related_entity_type", "owner_payment_claim")
    .eq("related_entity_id", claimId)
    .single();
  const l = log as { type: string; status: string; recipient_id: string } | null;

  const { data: audit } = await supabase
    .from("audit_log")
    .select("action")
    .eq("entity_type", "owner_payment_claim")
    .eq("entity_id", claimId)
    .eq("action", "communication.claim_matched.dry_run")
    .maybeSingle();

  const ok = !!l && l.type === "claim_matched" && l.status === "queued" && l.recipient_id === ctx.ownerProfileId && !!audit;
  record(
    "E-9: emitClaimMatchedEmail dry-run → log queued, audit dry_run, recipient=owner",
    ok,
    `log_type=${l?.type} log_status=${l?.status} audit=${audit ? "yes" : "no"}`,
  );
}

async function e10_emitClaimMatchedOptedOut(ctx: FixtureContext) {
  const claimId = await createPendingClaimFixture(ctx, 140);
  await supabase.from("notification_preferences").insert({
    profile_id: ctx.ownerProfileId,
    notification_type: "claim_matched",
    channel: "email",
    enabled: false,
  });

  await emitClaimMatchedEmail(supabase, {
    claimId,
    performedBy: ctx.managerProfileId,
  });

  await supabase
    .from("notification_preferences")
    .delete()
    .eq("profile_id", ctx.ownerProfileId)
    .eq("notification_type", "claim_matched");

  const { count } = await supabase
    .from("communication_log")
    .select("id", { count: "exact", head: true })
    .eq("related_entity_id", claimId);

  record(
    "E-10: emitClaimMatchedEmail respects opt-out (no log row written)",
    count === 0,
    `log_count=${count}`,
  );
}

async function e11_emitClaimRejectedDryRun(ctx: FixtureContext) {
  const claimId = await createPendingClaimFixture(ctx, 150);
  const reason = "Amount doesn't match any pending levy on the lot.";

  await emitClaimRejectedEmail(supabase, {
    claimId,
    rejectionReason: reason,
    performedBy: ctx.managerProfileId,
  });

  const { data: log } = await supabase
    .from("communication_log")
    .select("type, status")
    .eq("related_entity_type", "owner_payment_claim")
    .eq("related_entity_id", claimId)
    .single();

  const { data: audit } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("entity_type", "owner_payment_claim")
    .eq("entity_id", claimId)
    .eq("action", "communication.claim_rejected.dry_run")
    .maybeSingle();
  const a = audit as { metadata: { rejection_reason: string } } | null;

  const ok =
    !!log &&
    (log as { type: string; status: string }).type === "claim_rejected" &&
    !!a &&
    a.metadata.rejection_reason === reason;
  record(
    "E-11: emitClaimRejectedEmail dry-run → log row, audit metadata carries rejection_reason",
    ok,
    `log_present=${!!log} audit_reason_match=${a?.metadata?.rejection_reason === reason}`,
  );
}

async function e12_emitClaimRejectedOptedOut(ctx: FixtureContext) {
  const claimId = await createPendingClaimFixture(ctx, 160);
  await supabase.from("notification_preferences").insert({
    profile_id: ctx.ownerProfileId,
    notification_type: "claim_rejected",
    channel: "email",
    enabled: false,
  });

  await emitClaimRejectedEmail(supabase, {
    claimId,
    rejectionReason: "Already paid via different method.",
    performedBy: ctx.managerProfileId,
  });

  await supabase
    .from("notification_preferences")
    .delete()
    .eq("profile_id", ctx.ownerProfileId)
    .eq("notification_type", "claim_rejected");

  const { count } = await supabase
    .from("communication_log")
    .select("id", { count: "exact", head: true })
    .eq("related_entity_id", claimId);

  record(
    "E-12: emitClaimRejectedEmail respects opt-out (no log row written)",
    count === 0,
    `log_count=${count}`,
  );
}

// ─── Cleanup ───────────────────────────────────────────────────────────

async function cleanupMarker() {
  const { data: companies } = await supabase
    .from("management_companies")
    .select("id")
    .like("name", `${VERIFY_MARKER}%`);
  const companyIds = (companies ?? []).map((c) => (c as { id: string }).id);
  for (const cid of companyIds) await cleanupCompany(cid);
}

async function cleanupCompany(companyId: string) {
  const { data: subs } = await supabase
    .from("owners_corporations")
    .select("id")
    .eq("management_company_id", companyId);
  const subIds = (subs ?? []).map((s) => (s as { id: string }).id);

  if (subIds.length > 0) {
    const { data: lots } = await supabase
      .from("lots")
      .select("id")
      .in("oc_id", subIds);
    const lotIds = (lots ?? []).map((l) => (l as { id: string }).id);

    if (lotIds.length > 0) {
      const { data: entries } = await supabase
        .from("lot_ledger_entries")
        .select("id")
        .in("lot_id", lotIds);
      const entryIds = (entries ?? []).map((e) => (e as { id: string }).id);
      if (entryIds.length > 0) {
        await supabase.from("reconciliation_matches").delete().in("ledger_entry_id", entryIds);
      }
      await supabase.from("lot_ledger_entries").delete().in("lot_id", lotIds);
      await supabase.from("lot_ledger_state").delete().in("lot_id", lotIds);
    }

    const { data: accts } = await supabase
      .from("bank_accounts")
      .select("id")
      .in("oc_id", subIds);
    const acctIds = (accts ?? []).map((a) => (a as { id: string }).id);
    if (acctIds.length > 0) {
      await supabase.from("bank_transactions").delete().in("bank_account_id", acctIds);
      await supabase.from("bank_accounts").delete().in("id", acctIds);
    }

    await supabase.from("communication_log").delete().in("oc_id", subIds);
    await supabase.from("owner_payment_claims").delete().in("oc_id", subIds);
    await supabase.from("audit_log").delete().in("oc_id", subIds);
    await supabase.from("oc_members").delete().in("oc_id", subIds);
    await supabase.from("lots").delete().in("oc_id", subIds);
    await supabase.from("owners_corporations").delete().in("id", subIds);
  }

  // Notification prefs cleanup keyed on profiles within this company.
  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id")
    .eq("management_company_id", companyId);
  const profileIds = (profileRows ?? []).map((p) => (p as { id: string }).id);

  // Owner profile (lot_owner role) is not management_company-scoped , find by auth_user_id pattern.
  const { data: orphanOwners } = await supabase
    .from("profiles")
    .select("id")
    .like("auth_user_id", `${VERIFY_MARKER}_OWNER_%`);
  const orphanOwnerIds = (orphanOwners ?? []).map((p) => (p as { id: string }).id);
  const allProfileIds = [...profileIds, ...orphanOwnerIds];

  if (allProfileIds.length > 0) {
    await supabase.from("notification_preferences").delete().in("profile_id", allProfileIds);
    await supabase
      .from("audit_log")
      .delete()
      .in("profile_id", allProfileIds)
      .is("oc_id", null);
    await supabase.from("profiles").delete().in("id", allProfileIds);
  }

  await supabase.from("management_companies").delete().eq("id", companyId);
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const cleanupOnly = process.argv.includes("--cleanup");
  const noCleanup = process.argv.includes("--no-cleanup");

  if (cleanupOnly) {
    await cleanupMarker();
    process.exit(0);
  }

  console.log("Email + notification helpers verification , PP6-C-1 scenarios E-1..E-12\n");
  console.log("[1/3] Cleaning up stale verification data");
  await cleanupMarker();

  console.log("[2/3] Creating fixture");
  const ctx = await createFixture();

  console.log("[3/3] Running scenarios\n");
  await e1_optedOutDefaultOptIn(ctx);
  await e2_optedOutExplicitOff(ctx);
  await e3_mandatoryBypass(ctx);
  await e4_emitPaymentDryRun(ctx);
  await e5_emitPaymentIdempotency(ctx);
  await e6_emitPaymentOptedOut(ctx);
  await e7_emitPaymentNoBankTx(ctx);
  await e8_emitPaymentNoOwner(ctx);
  await e9_emitClaimMatchedDryRun(ctx);
  await e10_emitClaimMatchedOptedOut(ctx);
  await e11_emitClaimRejectedDryRun(ctx);
  await e12_emitClaimRejectedOptedOut(ctx);

  if (!noCleanup) {
    console.log("\nCleaning up");
    await cleanupCompany(ctx.companyId);
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
