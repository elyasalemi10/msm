/**
 * PP7-B reports verification.
 *
 * Exercises the 3 new manager-facing reports:
 *   - getOutstandingArrearsReport (RP-1 + RP-2 + RP-3)
 *   - getOwnerStatement (RP-4 + RP-5)
 *   - getTrustAccountSummary (RP-6)
 *
 * Auth via the __setUserIdResolverForVerification seam (manager identity
 *
 * Usage:
 *   npx tsx src/lib/actions/reports.verification.ts
 *   npx tsx src/lib/actions/reports.verification.ts --no-cleanup
 *   npx tsx src/lib/actions/reports.verification.ts --cleanup
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createRequire } from "node:module";
const scriptRequire = createRequire(import.meta.url);
const nextCachePath = scriptRequire.resolve("next/cache");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(scriptRequire.cache as any)[nextCachePath] = {
  id: nextCachePath,
  filename: nextCachePath,
  loaded: true,
  exports: {
    revalidatePath: () => {},
    revalidateTag: () => {},
    updateTag: () => {},
    unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  },
  paths: [],
  children: [],
};

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { generateOCCode } from "@/lib/oc-code";
import { __setUserIdResolverForVerification } from "@/lib/auth-resolver";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const VERIFY_MARKER = "__VERIFY_RP__";
const supabase = createClient(supabaseUrl, serviceRoleKey);

let activeUserId: string | null = null;
__setUserIdResolverForVerification(async () => activeUserId);

type Result = { scenario: string; passed: boolean; detail: string };
const results: Result[] = [];
function record(scenario: string, passed: boolean, detail: string) {
  results.push({ scenario, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${scenario}${detail ? " , " + detail : ""}`);
}

function daysBefore(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ─── Fixture ───────────────────────────────────────────────────────────

interface FixtureContext {
  companyId: string;
  managerProfileId: string;
  managerUserId: string;
  ocId: string;
  lotAId: string;
  lotBId: string;
  ownerAProfileId: string;
  ownerBProfileId: string;
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

  const managerUserId = `${VERIFY_MARKER}_MGR_${runId}`;
  const { data: manager } = await supabase
    .from("profiles")
    .insert({
      auth_user_id: managerUserId,
      email: `${VERIFY_MARKER.toLowerCase()}${runId}_mgr@rp.test`,
      first_name: "Rep",
      last_name: "TestMgr",
      role: "strata_manager",
      company_role: "admin",
      management_company_id: companyId,
    })
    .select("id")
    .single();
  const managerProfileId = (manager as { id: string }).id;

  const { data: oc } = await supabase
    .from("owners_corporations")
    .insert({
      management_company_id: companyId,
      name: `${VERIFY_MARKER}${runId}`,
      plan_number: `PLAN-${runId}`,
      short_code: generateOCCode(),
      address: `${runId} Reports Test St, Melbourne VIC 3000`,
      total_lots: 2,
      created_by: managerProfileId,
    })
    .select("id")
    .single();
  const ocId = (oc as { id: string }).id;

  // Add manager to oc_members so requireOCAccess passes.
  await supabase.from("oc_members").insert({
    oc_id: ocId,
    profile_id: managerProfileId,
    role: "strata_manager",
    is_primary_contact: false,
    is_financial: false,
  });

  // Two lots + two owners (lot A in arrears; lot B clean).
  const lotIds: string[] = [];
  const ownerIds: string[] = [];
  for (const num of [1, 2]) {
    const { data: owner } = await supabase
      .from("profiles")
      .insert({
        auth_user_id: `${VERIFY_MARKER}_OWN_${runId}_${num}`,
        email: `${VERIFY_MARKER.toLowerCase()}${runId}_o${num}@rp.test`,
        first_name: "Owner",
        last_name: `RP${num}`,
        role: "lot_owner",
      })
      .select("id")
      .single();
    ownerIds.push((owner as { id: string }).id);

    const { data: lot } = await supabase
      .from("lots")
      .insert({
        oc_id: ocId,
        lot_number: num,
        lot_entitlement: 100,
        lot_liability: 100,
      })
      .select("id")
      .single();
    const lotId = (lot as { id: string }).id;
    lotIds.push(lotId);

    await supabase.from("oc_members").insert({
      oc_id: ocId,
      profile_id: ownerIds[num - 1],
      lot_id: lotId,
      role: "lot_owner",
      is_primary_contact: true,
      is_financial: true,
    });
  }

  // Bank account for trust summary scenarios.
  const { data: bank } = await supabase
    .from("bank_accounts")
    .insert({
      oc_id: ocId,
      account_name: `Operating Fund Trust ${runId}`,
      bsb: "063000",
      account_number: `1234${runId.slice(-4)}`,
      fund_type: "operating",
      bank_name: "Westpac",
      opening_balance: 10000,
      opening_balance_date: daysBefore(todayIso(), 90),
      status: "active",
    })
    .select("id")
    .single();
  const bankAccountId = (bank as { id: string }).id;

  return {
    companyId,
    managerProfileId,
    managerUserId,
    ocId,
    lotAId: lotIds[0],
    lotBId: lotIds[1],
    ownerAProfileId: ownerIds[0],
    ownerBProfileId: ownerIds[1],
    bankAccountId,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function insertLevy(
  ctx: FixtureContext,
  lotId: string,
  refSuffix: string,
  opts: {
    amount?: number;
    amountPaid?: number;
    status?: "issued" | "partially_paid" | "overdue" | "paid";
    levyType?: "regular" | "penalty_interest";
    dueDate?: string;
    linkedLevyId?: string | null;
  } = {},
): Promise<string> {
  const dueDate = opts.dueDate ?? daysBefore(todayIso(), 30);
  const { data } = await supabase
    .from("levy_notices")
    .insert({
      oc_id: ctx.ocId,
      lot_id: lotId,
      reference_number: `LEV-RP-${refSuffix}`,
      fund_type: "operating",
      levy_type: opts.levyType ?? "regular",
      period_start: daysBefore(dueDate, 90),
      period_end: dueDate,
      amount: opts.amount ?? 1000,
      amount_paid: opts.amountPaid ?? 0,
      due_date: dueDate,
      status: opts.status ?? "partially_paid",
      issued_at: new Date(dueDate + "T00:00:00Z").toISOString(),
      linked_levy_id: opts.linkedLevyId ?? null,
    })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function insertLedger(
  ctx: FixtureContext,
  lotId: string,
  entryType: "debit" | "credit",
  category: string,
  amount: number,
  entryDate: string,
  reference?: string | null,
): Promise<void> {
  const { error } = await supabase.from("lot_ledger_entries").insert({
    oc_id: ctx.ocId,
    lot_id: lotId,
    fund_type: "operating",
    entry_type: entryType,
    category,
    amount,
    entry_date: entryDate,
    reference: reference ?? null,
    status: "active",
    created_by: ctx.managerProfileId,
  });
  if (error) {
    console.error(`insertLedger failed [${entryType}/${category}/${amount}/${entryDate}]:`, error);
  }
}

async function insertBankTx(
  ctx: FixtureContext,
  amount: number,
  txDate: string,
  matchStatus: "unmatched" | "manually_matched",
): Promise<void> {
  await supabase.from("bank_transactions").insert({
    bank_account_id: ctx.bankAccountId,
    source: "manual",
    transaction_date: txDate,
    amount,
    description: `${VERIFY_MARKER} test tx`,
    match_status: matchStatus,
  });
}

// ─── Scenarios ─────────────────────────────────────────────────────────

async function rp1_outstandingArrearsEmptyOC(
  ctx: FixtureContext,
  reports: typeof import("./reports"),
) {
  activeUserId = ctx.managerUserId;
  const data = await reports.getOutstandingArrearsReport(ctx.ocId);
  const ok = Array.isArray(data) && data.length === 0;
  record(
    "RP-1: oc with no unpaid levies → empty array",
    ok,
    `len=${data.length}`,
  );
}

async function rp2_outstandingArrearsPrincipalPlusInterest(
  ctx: FixtureContext,
  reports: typeof import("./reports"),
) {
  // Lot A: $1000 levy, $400 paid → $600 principal outstanding, 30 days overdue.
  // Linked penalty_interest: $25 outstanding.
  const parentLevyId = await insertLevy(ctx, ctx.lotAId, "rp2", {
    amount: 1000,
    amountPaid: 400,
    status: "partially_paid",
  });
  await insertLevy(ctx, ctx.lotAId, "rp2-pi", {
    amount: 25,
    amountPaid: 0,
    levyType: "penalty_interest",
    linkedLevyId: parentLevyId,
    dueDate: daysBefore(todayIso(), 5),
    status: "issued",
  });

  activeUserId = ctx.managerUserId;
  const data = await reports.getOutstandingArrearsReport(ctx.ocId);
  const lotARow = data.find((r) => r.lot_id === ctx.lotAId);
  const ok =
    !!lotARow &&
    Math.abs(lotARow.principal_outstanding - 600) < 0.01 &&
    Math.abs(lotARow.interest_outstanding - 25) < 0.01 &&
    Math.abs(lotARow.total_outstanding - 625) < 0.01 &&
    lotARow.days_overdue === 30 &&
    lotARow.bucket === "0_30";
  record(
    "RP-2: lot with partially-paid principal + linked penalty interest → correct split + ageing bucket",
    ok,
    `principal=${lotARow?.principal_outstanding} interest=${lotARow?.interest_outstanding} total=${lotARow?.total_outstanding} days=${lotARow?.days_overdue} bucket=${lotARow?.bucket}`,
  );
}

async function rp3_outstandingArrearsAgeingBuckets(
  ctx: FixtureContext,
  reports: typeof import("./reports"),
) {
  // Lot B: $500 principal, 65 days overdue → bucket=61_plus.
  await insertLevy(ctx, ctx.lotBId, "rp3", {
    amount: 500,
    amountPaid: 0,
    status: "overdue",
    dueDate: daysBefore(todayIso(), 65),
  });
  activeUserId = ctx.managerUserId;
  const data = await reports.getOutstandingArrearsReport(ctx.ocId);
  const lotBRow = data.find((r) => r.lot_id === ctx.lotBId);
  const ok = !!lotBRow && lotBRow.bucket === "61_plus" && lotBRow.days_overdue === 65;
  record(
    "RP-3: lot 65 days overdue → bucket='61_plus'",
    ok,
    `bucket=${lotBRow?.bucket} days=${lotBRow?.days_overdue}`,
  );
}

async function rp4_ownerStatementOpeningAndClosing(
  ctx: FixtureContext,
  reports: typeof import("./reports"),
) {
  const fromDate = daysBefore(todayIso(), 60);
  const toDate = todayIso();
  // Pre-window: $500 debit (carry-in balance = -500).
  await insertLedger(ctx, ctx.lotAId, "debit", "levy", 500, daysBefore(fromDate, 5), "OPENING");
  // In-window: $200 credit (payment), then $100 debit (adjustment).
  // Closing = -500 + 200 - 100 = -400.
  await insertLedger(ctx, ctx.lotAId, "credit", "payment", 200, daysBefore(toDate, 20), "PAY-1");
  await insertLedger(ctx, ctx.lotAId, "debit", "adjustment_debit", 100, daysBefore(toDate, 10), "ADJ-1");

  activeUserId = ctx.managerUserId;
  const report = await reports.getOwnerStatement(ctx.ocId, ctx.lotAId, fromDate, toDate);
  const ok =
    Math.abs(report.opening_balance - -500) < 0.01 &&
    Math.abs(report.closing_balance - -400) < 0.01 &&
    report.entries.length === 2;
  record(
    "RP-4: owner statement , opening (-500) + 2 in-window entries → closing (-400)",
    ok,
    `opening=${report.opening_balance} closing=${report.closing_balance} entries=${report.entries.length}`,
  );
}

async function rp5_ownerStatementOutOfWindowExcluded(
  ctx: FixtureContext,
  reports: typeof import("./reports"),
) {
  const fromDate = daysBefore(todayIso(), 10);
  const toDate = todayIso();
  // Pre-window entries already inserted in RP-4 should be in opening, not entries.
  activeUserId = ctx.managerUserId;
  const report = await reports.getOwnerStatement(ctx.ocId, ctx.lotAId, fromDate, toDate);
  // Only the ADJ-1 entry (10 days ago) lands in the window for lot A.
  const inWindow = report.entries.every((e) => e.entry_date >= fromDate && e.entry_date <= toDate);
  const ok = inWindow && report.entries.length === 1 && report.entries[0].reference === "ADJ-1";
  record(
    "RP-5: owner statement , entries strictly inside [fromDate, toDate]; pre-window entries roll into opening",
    ok,
    `entries=${report.entries.length} inWindow=${inWindow}`,
  );
}

async function rp6_trustAccountSummaryInflowsOutflowsAndReconciled(
  ctx: FixtureContext,
  reports: typeof import("./reports"),
) {
  const fromDate = daysBefore(todayIso(), 30);
  const toDate = todayIso();
  // In-window: +500 reconciled, +300 unmatched, -150 unmatched (outflow).
  await insertBankTx(ctx, 500, daysBefore(toDate, 10), "manually_matched");
  await insertBankTx(ctx, 300, daysBefore(toDate, 5), "unmatched");
  await insertBankTx(ctx, -150, daysBefore(toDate, 3), "unmatched");

  activeUserId = ctx.managerUserId;
  const rows = await reports.getTrustAccountSummary(ctx.ocId, fromDate, toDate);
  const acc = rows.find((r) => r.bank_account_id === ctx.bankAccountId);
  // opening = 10000 (no pre-window txns), inflows=800, outflows=150,
  // closing=10000+800-150=10650; reconciled=1, unreconciled=2, count=3.
  const ok =
    !!acc &&
    Math.abs(acc.opening_balance - 10000) < 0.01 &&
    Math.abs(acc.inflows - 800) < 0.01 &&
    Math.abs(acc.outflows - 150) < 0.01 &&
    Math.abs(acc.closing_balance - 10650) < 0.01 &&
    acc.transaction_count === 3 &&
    acc.reconciled_count === 1 &&
    acc.unreconciled_count === 2;
  record(
    "RP-6: trust account summary , inflows/outflows/closing/reconciled counts all correct",
    ok,
    `opening=${acc?.opening_balance} in=${acc?.inflows} out=${acc?.outflows} closing=${acc?.closing_balance} reconciled=${acc?.reconciled_count}/${acc?.unreconciled_count}`,
  );
}

// ─── Cleanup ──────────────────────────────────────────────────────────

async function cleanupMarker() {
  const { data: companies } = await supabase
    .from("management_companies")
    .select("id")
    .like("name", `${VERIFY_MARKER}%`);
  const companyIds = (companies ?? []).map((c) => (c as { id: string }).id);
  for (const cid of companyIds) await cleanupCompany(cid);

  const { data: orphanOwners } = await supabase
    .from("profiles")
    .select("id")
    .like("auth_user_id", `${VERIFY_MARKER}_OWN_%`);
  const orphanOwnerIds = (orphanOwners ?? []).map((p) => (p as { id: string }).id);
  if (orphanOwnerIds.length > 0) {
    await supabase.from("profiles").delete().in("id", orphanOwnerIds);
  }
}

async function cleanupCompany(companyId: string) {
  const { data: subs } = await supabase
    .from("owners_corporations")
    .select("id")
    .eq("management_company_id", companyId);
  const subIds = (subs ?? []).map((s) => (s as { id: string }).id);
  if (subIds.length > 0) {
    const { data: lots } = await supabase.from("lots").select("id").in("oc_id", subIds);
    const lotIds = (lots ?? []).map((l) => (l as { id: string }).id);
    if (lotIds.length > 0) {
      await supabase.from("lot_ledger_state").delete().in("lot_id", lotIds);
      await supabase.from("lot_ledger_entries").delete().in("lot_id", lotIds);
    }
    await supabase.from("levy_notices").update({ linked_levy_id: null }).in("oc_id", subIds);
    await supabase.from("levy_notices").delete().in("oc_id", subIds);
    const { data: banks } = await supabase.from("bank_accounts").select("id").in("oc_id", subIds);
    const bankIds = (banks ?? []).map((b) => (b as { id: string }).id);
    if (bankIds.length > 0) {
      await supabase.from("bank_transactions").delete().in("bank_account_id", bankIds);
      await supabase.from("bank_accounts").delete().in("id", bankIds);
    }
    await supabase.from("oc_members").delete().in("oc_id", subIds);
    await supabase.from("audit_log").delete().in("oc_id", subIds);
    await supabase.from("lots").delete().in("oc_id", subIds);
    await supabase.from("owners_corporations").delete().in("id", subIds);
  }
  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id")
    .eq("management_company_id", companyId);
  const profileIds = (profileRows ?? []).map((p) => (p as { id: string }).id);
  if (profileIds.length > 0) {
    await supabase.from("audit_log").delete().in("profile_id", profileIds).is("oc_id", null);
    await supabase.from("profiles").delete().in("id", profileIds);
  }
  await supabase.from("management_companies").delete().eq("id", companyId);
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const cleanupOnly = process.argv.includes("--cleanup");
  const noCleanup = process.argv.includes("--no-cleanup");
  if (cleanupOnly) {
    await cleanupMarker();
    process.exit(0);
  }

  console.log("PP7-B reports verification , scenarios RP-1..RP-6\n");
  console.log("[1/3] Cleaning up stale verification data");
  await cleanupMarker();

  console.log("[2/3] Setting up fixture");
  const ctx = await createFixture();

  console.log("[3/3] Running scenarios\n");
  const reports = await import("./reports");
  await rp1_outstandingArrearsEmptyOC(ctx, reports);
  await rp2_outstandingArrearsPrincipalPlusInterest(ctx, reports);
  await rp3_outstandingArrearsAgeingBuckets(ctx, reports);
  await rp4_ownerStatementOpeningAndClosing(ctx, reports);
  await rp5_ownerStatementOutOfWindowExcluded(ctx, reports);
  await rp6_trustAccountSummaryInflowsOutflowsAndReconciled(ctx, reports);

  if (!noCleanup) {
    console.log("\nCleaning up");
    await cleanupCompany(ctx.companyId);
    await cleanupMarker();
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
