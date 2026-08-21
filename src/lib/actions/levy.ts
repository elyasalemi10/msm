"use server";

import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { revalidatePath } from "next/cache";
import { generateAndUploadLevyPDF, generateLevyPDFBuffer } from "@/lib/levy-pdf";
import { getLevyNoticePdfBuffer } from "@/lib/pdf/render";
import { sendLevyEmail } from "@/lib/email";
import { formatDateLong } from "@/lib/utils";
import { notifyOCLotOwners } from "@/lib/actions/notifications";
import { getLotOwners } from "@/lib/actions/lot-ownership";
import { uploadObject } from "@/lib/storage/r2";
import { runLevyBatchSend } from "@/lib/levy-batch-send-runner";
import { tasks } from "@trigger.dev/sdk";
// generateCrn lived in the nuked reconciliation stack. Inlined here
// (BPAY MOD10V01 check digit), preserved for the bpay_crn column on
// regular levies until the new reconciliation flow ships.
function generateCrn(levyNumber: number): string {
  const padded = String(levyNumber).padStart(7, "0");
  const weights = [1, 2, 1, 2, 1, 2, 1];
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const p = Number(padded[i]) * weights[i];
    sum += p > 9 ? p - 9 : p;
  }
  const check = (10 - (sum % 10)) % 10;
  return padded + String(check);
}
import { buildOCUrl } from "@/lib/oc-resolver";
import { getLegislationRules } from "@/lib/legislation";
import type { LevyNoticeProps } from "@/lib/pdf/types";

// ─── Types ─────────────────────────────────────────────────

export interface LevyPreviewLot {
  lot_id: string;
  lot_number: number;
  unit_number: string | null;
  owner_display_name: string | null;
  owner_contact_email: string | null;
  lot_entitlement: number;
  total_entitlement: number;
  proportion: number; // lot UE / total UE
  base_amount: number;
  items: { description: string; amount: number; budget_item_id: string | null; coa_account_id?: string | null }[];
}

export interface LevyPreviewData {
  budget_id: string;
  financial_year: string;
  fund_type: "operating" | "maintenance_plan";
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  period_amount: number; // budget total / periods
  total_entitlement: number;
  lots: LevyPreviewLot[];
  billing_cycle: string;
}

export interface LevyBatchSummary {
  id: string;
  financial_year: string;
  fund_type: "operating" | "maintenance_plan";
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  total_amount: number;
  levy_count: number;
  status: "draft" | "ledger_written" | "sent" | "partially_sent" | "cancelled";
  created_at: string;
  /** Special-purpose one-off levy (raised outside the budget cycle). */
  is_special: boolean;
}

export interface LevyBatchDetail extends LevyBatchSummary {
  levies: {
    id: string;
    lot_id: string;
    lot_number: number;
    unit_number: string | null;
    owner_display_name: string | null;
    owner_contact_email: string | null;
    /** Internal LEV-NNNN reference. Kept for back-compat / audit. */
    reference_number: string;
    /** Macquarie DEFT Reference Number (DRN) active for the lot. This is
     *  what the owner uses to pay , show it in preference to the LEV
     *  reference on dashboards and the levy notice. */
    drn: string | null;
    /** Fallback owner reference (lot_owners.payment_reference, e.g.
     *  "WHDPE-001") generated at OC creation. Used when no DRN exists. */
    payment_reference: string | null;
    amount: number;
    status: string;
    pdf_url: string | null;
    items: { description: string; amount: number; is_adjustment: boolean; coa_code: string | null }[];
  }[];
}

// ─── Helpers ───────────────────────────────────────────────

const BILLING_PERIODS: Record<string, number> = {
  monthly: 12,
  quarterly: 4,
  half_yearly: 2,
  annually: 1,
};

function getPeriodsForCycle(cycle: string) {
  return BILLING_PERIODS[cycle] ?? 4;
}

function getPeriodDates(
  fyStartMonth: number,
  fyStartYear: number,
  periodIndex: number,
  periodsPerYear: number,
): { start: string; end: string; label: string } {
  const monthsPerPeriod = 12 / periodsPerYear;
  const startMonth = ((fyStartMonth - 1) + periodIndex * monthsPerPeriod) % 12;
  const startYear = fyStartYear + Math.floor(((fyStartMonth - 1) + periodIndex * monthsPerPeriod) / 12);

  const endPeriodMonth = ((fyStartMonth - 1) + (periodIndex + 1) * monthsPerPeriod) % 12;
  const endYear = fyStartYear + Math.floor(((fyStartMonth - 1) + (periodIndex + 1) * monthsPerPeriod) / 12);

  // CRITICAL: build dates with Date.UTC so .toISOString() doesn't
  // shift the day by one in non-UTC timezones. Without this, a server
  // (or dev machine) in Melbourne sees "first levy = 30 Jun" for an
  // FY starting July, because new Date(y, m, 1) is LOCAL midnight which
  // is 14:00 UTC the previous day.
  const start = new Date(Date.UTC(startYear, startMonth, 1));
  const end = new Date(Date.UTC(endYear, endPeriodMonth, 0)); // last day of previous month

  const formatDate = (d: Date) => d.toISOString().split("T")[0];

  // Label
  let label: string;
  if (periodsPerYear === 4) {
    label = `Q${periodIndex + 1}`;
  } else if (periodsPerYear === 2) {
    label = `H${periodIndex + 1}`;
  } else if (periodsPerYear === 1) {
    label = "Annual";
  } else {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    label = monthNames[startMonth];
  }

  return { start: formatDate(start), end: formatDate(end), label };
}

// Suggested default due date = the state's legislated notice window from the
// LATER of the period start or today. Anchoring on max(periodStart, today)
// stops a levy raised mid- or post-period from pre-filling a due date in the
// past (e.g. generating Q4 in June used to default to "1 Apr + 28 = 29 Apr",
// a date already gone). Result is only a DEFAULT pre-fill , the form lets the
// manager set any date (no minimum enforcement, per requirement 16).
function calculateDueDate(periodStart: string, noticeDays = 28): string {
  const start = new Date(`${periodStart}T00:00:00Z`);
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const base = start.getTime() > today.getTime() ? start : today;
  base.setUTCDate(base.getUTCDate() + noticeDays);
  return base.toISOString().split("T")[0];
}

// ─── Get next period to generate ───────────────────────────

export async function getNextPeriod(ocId: string, budgetId: string) {
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  // Get budget + oc info
  const [{ data: budget }, { data: oc }] = await Promise.all([
    supabase.from("budgets").select("*").eq("id", budgetId).single(),
    supabase.from("owners_corporations").select("financial_year_start_month, billing_cycle, state").eq("id", ocId).single(),
  ]);

  if (!budget || !oc) return null;

  const periodsPerYear = getPeriodsForCycle(oc.billing_cycle);
  const fyParts = budget.financial_year.split("-");
  const fyStartYear = parseInt(fyParts[0]);
  const fyStartMonth = oc.financial_year_start_month ?? 7;
  const rules = await getLegislationRules(oc.state);

  // Check which periods already have batches
  const { data: existingBatches } = await supabase
    .from("levy_batches")
    .select("period_start, status")
    .eq("budget_id", budgetId);

  // Cancelled batches DON'T block the period , the manager soft-cancelled
  // because they want to regenerate. Every other batch (draft / sent /
  // partially_sent / ledger_written) still blocks.
  const existingPeriodStarts = new Set(
    (existingBatches ?? [])
      .filter((b) => b.status !== "cancelled")
      .map((b) => b.period_start),
  );

  // Find first period that hasn't been generated
  for (let i = 0; i < periodsPerYear; i++) {
    const period = getPeriodDates(fyStartMonth, fyStartYear, i, periodsPerYear);
    if (!existingPeriodStarts.has(period.start)) {
      return {
        periodIndex: i,
        ...period,
        label: period.label,
        due_date: calculateDueDate(period.start, rules.levy_due_default_days),
        billing_cycle: oc.billing_cycle,
        periods_per_year: periodsPerYear,
      };
    }
  }

  return null; // All periods generated
}

// ─── Get available periods for a budget ────────────────────

export interface AvailablePeriod {
  periodIndex: number;
  label: string;
  start: string;
  end: string;
  due_date: string;
  already_generated: boolean;
}

export async function getAvailablePeriods(ocId: string, budgetId: string): Promise<AvailablePeriod[]> {
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const [{ data: budget }, { data: oc }] = await Promise.all([
    supabase.from("budgets").select("*").eq("id", budgetId).single(),
    supabase.from("owners_corporations").select("financial_year_start_month, billing_cycle, state").eq("id", ocId).single(),
  ]);

  if (!budget || !oc) return [];

  const periodsPerYear = getPeriodsForCycle(oc.billing_cycle);
  const fyParts = budget.financial_year.split("-");
  const fyStartYear = parseInt(fyParts[0]);
  const fyStartMonth = oc.financial_year_start_month ?? 7;
  const rules = await getLegislationRules(oc.state);

  const { data: existingBatches } = await supabase
    .from("levy_batches")
    .select("period_start, status")
    .eq("budget_id", budgetId);

  // Cancelled batches DON'T block the period , the manager soft-cancelled
  // because they want to regenerate. Every other batch (draft / sent /
  // partially_sent / ledger_written) still blocks.
  const existingPeriodStarts = new Set(
    (existingBatches ?? [])
      .filter((b) => b.status !== "cancelled")
      .map((b) => b.period_start),
  );

  // Period label is the bare quarter / half / month chip ("Q1") , no year
  // suffix. The form composes a richer "Q1 1 Jul - 30 Jun" via formatDayMonthShort.
  const periods: AvailablePeriod[] = [];
  for (let i = 0; i < periodsPerYear; i++) {
    const period = getPeriodDates(fyStartMonth, fyStartYear, i, periodsPerYear);
    periods.push({
      periodIndex: i,
      label: period.label,
      start: period.start,
      end: period.end,
      due_date: calculateDueDate(period.start, rules.levy_due_default_days),
      already_generated: existingPeriodStarts.has(period.start),
    });
  }

  return periods;
}

// ─── Generate levy preview ─────────────────────────────────

export async function generateLevyPreview(
  ocId: string,
  budgetId: string,
  periodIndex?: number,
  options: { _systemBypass?: boolean } = {},
): Promise<{ data?: LevyPreviewData; error?: string }> {
  if (!options._systemBypass) await requireOCAccess(ocId);
  const supabase = createServerClient();

  // Get budget with items
  const { data: budget } = await supabase
    .from("budgets")
    .select("*")
    .eq("id", budgetId)
    .eq("status", "approved")
    .single();

  if (!budget) return { error: "Budget not found or not approved" };

  // LEFT JOIN both legacy budget_categories and new chart_of_accounts so the
  // line-item label resolves regardless of which FK the budget was created
  // against. The display name fallback chain is description → CoA name →
  // legacy category name → "Budget item". Cast via `unknown` because the
  // generated Supabase types collapse multi-FK joins to a generic error tuple.
  type RawBudgetItem = {
    id: string;
    description: string | null;
    amount: number;
    category_id: string | null;
    coa_account_id: string | null;
    fund_type: string | null;
    fund_id: string | null;
    charge_group_id: string | null;
    budget_categories: { name: string } | null;
    chart_of_accounts: { name: string } | null;
  };
  const { data: rawBudgetItems } = await supabase
    .from("budget_items")
    .select(
      "id, description, amount, category_id, coa_account_id, fund_type, fund_id, charge_group_id, " +
      "budget_categories(name), chart_of_accounts(name)"
    )
    .eq("budget_id", budgetId)
    .order("sort_order");
  const budgetItems = (rawBudgetItems ?? []) as unknown as RawBudgetItem[];

  // Get oc settings
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("financial_year_start_month, billing_cycle, state")
    .eq("id", ocId)
    .single();

  if (!oc) return { error: "OC not found" };

  const rules = await getLegislationRules(oc.state);

  // Get period , either specific index or auto-detect next
  let nextPeriod;
  if (periodIndex !== undefined) {
    const periodsPerYear = getPeriodsForCycle(oc.billing_cycle);
    const fyParts = budget.financial_year.split("-");
    const fyStartYear = parseInt(fyParts[0]);
    const fyStartMonth = oc.financial_year_start_month ?? 7;
    const period = getPeriodDates(fyStartMonth, fyStartYear, periodIndex, periodsPerYear);
    nextPeriod = {
      periodIndex,
      ...period,
      label: period.label,
      due_date: calculateDueDate(period.start, rules.levy_due_default_days),
      billing_cycle: oc.billing_cycle,
      periods_per_year: periodsPerYear,
    };
  } else {
    nextPeriod = await getNextPeriod(ocId, budgetId);
    if (!nextPeriod) return { error: "All periods for this financial year have been generated" };
  }

  // Get lots
  const { data: lots } = await supabase
    .from("lots")
    .select("id, lot_number, unit_number, lot_entitlement, lot_liability")
    .eq("oc_id", ocId)
    .order("lot_number");

  if (!lots || lots.length === 0) return { error: "No lots found in this oc" };

  const owners = await getLotOwners(supabase, lots.map((l) => l.id));

  const periodsPerYear = getPeriodsForCycle(oc.billing_cycle);

  // OC-wide default liability (admin / maintenance fall back to this).
  const defaultLiabByLotId = new Map<string, number>(
    lots.map((l) => [
      l.id,
      l.lot_liability > 0 ? l.lot_liability : (l.lot_entitlement > 0 ? l.lot_entitlement : 1),
    ]),
  );
  const defaultTotal = Array.from(defaultLiabByLotId.values()).reduce((s, v) => s + v, 0);

  // Per-custom-fund liability: each custom fund has its own
  // fund_lot_entitlements (subset of lots + per-lot liability). Pull for
  // every custom fund referenced by an item so custom-fund items split
  // by the fund's own liability, not the OC-wide one.
  const customFundIds = Array.from(new Set(
    budgetItems.map((bi) => bi.fund_id).filter((id): id is string => !!id),
  ));
  const fundLiabByLotId = new Map<string, Map<string, number>>();
  if (customFundIds.length > 0) {
    const { data: ents } = await supabase
      .from("fund_lot_entitlements")
      .select("fund_id, lot_id, liability")
      .in("fund_id", customFundIds);
    for (const e of (ents ?? []) as Array<{ fund_id: string; lot_id: string; liability: number | string }>) {
      if (!fundLiabByLotId.has(e.fund_id)) fundLiabByLotId.set(e.fund_id, new Map());
      fundLiabByLotId.get(e.fund_id)!.set(e.lot_id, Number(e.liability));
    }
  }

  // Per-line-item lot exclusions: an item with a charge_group_id has a set of
  // lots that DON'T pay for it (stored as charge_group_lots). Those lots get a
  // 0 share and the item's liability total is summed over the remaining lots
  // only, so they absorb the full line cost renormalised by their liability.
  const chargeGroupIds = Array.from(new Set(
    budgetItems.map((bi) => bi.charge_group_id).filter((id): id is string => !!id),
  ));
  const excludedByGroup = new Map<string, Set<string>>();
  if (chargeGroupIds.length > 0) {
    const { data: links } = await supabase
      .from("charge_group_lots")
      .select("charge_group_id, lot_id")
      .in("charge_group_id", chargeGroupIds);
    for (const link of (links ?? []) as Array<{ charge_group_id: string; lot_id: string }>) {
      if (!excludedByGroup.has(link.charge_group_id)) excludedByGroup.set(link.charge_group_id, new Set());
      excludedByGroup.get(link.charge_group_id)!.add(link.lot_id);
    }
  }
  // Memoise each item's renormalised total (sum of liabilities of the lots
  // that DO pay). Keyed by item id since it depends only on the item's fund +
  // exclusion set, not the lot being priced.
  const itemTotalCache = new Map<string, number>();
  function excludedFor(bi: RawBudgetItem): Set<string> | undefined {
    return bi.charge_group_id ? excludedByGroup.get(bi.charge_group_id) : undefined;
  }

  function liabFor(bi: RawBudgetItem, lotId: string): { liab: number; total: number } {
    const excluded = excludedFor(bi);
    // Custom-fund items split by the fund's own per-lot liability map.
    if (bi.fund_id) {
      const map = fundLiabByLotId.get(bi.fund_id);
      if (map && map.size > 0) {
        let total = itemTotalCache.get(bi.id);
        if (total === undefined) {
          total = 0;
          for (const [lid, v] of map) if (!excluded?.has(lid)) total += v;
          itemTotalCache.set(bi.id, total);
        }
        return { liab: excluded?.has(lotId) ? 0 : (map.get(lotId) ?? 0), total };
      }
    }
    // System-fund items split by OC-wide lot liability.
    if (!excluded || excluded.size === 0) {
      return { liab: defaultLiabByLotId.get(lotId) ?? 0, total: defaultTotal };
    }
    let total = itemTotalCache.get(bi.id);
    if (total === undefined) {
      total = 0;
      for (const [lid, v] of defaultLiabByLotId) if (!excluded.has(lid)) total += v;
      itemTotalCache.set(bi.id, total);
    }
    return { liab: excluded.has(lotId) ? 0 : (defaultLiabByLotId.get(lotId) ?? 0), total };
  }

  // Build per-lot preview. base_amount + proportion + lot_entitlement
  // are OC-wide values for the header chip; the real per-item math runs
  // off liabFor() so custom-fund items respect their own liability.
  const previewLots: LevyPreviewLot[] = lots.map((lot) => {
    const lotUE = defaultLiabByLotId.get(lot.id) ?? 1;
    const proportion = defaultTotal > 0 ? lotUE / defaultTotal : 0;

    const items = budgetItems
      .filter((bi) => Number(bi.amount) > 0)
      .map((bi) => {
        const { liab, total } = liabFor(bi, lot.id);
        const itemPeriodAmount = Number(bi.amount) / periodsPerYear;
        const lotItemAmount = total > 0 && liab > 0
          ? Math.round(itemPeriodAmount * (liab / total) * 100) / 100
          : 0;
        return {
          description:
            bi.description ||
            bi.chart_of_accounts?.name ||
            bi.budget_categories?.name ||
            "Budget item",
          amount: lotItemAmount,
          budget_item_id: bi.id,
          coa_account_id: bi.coa_account_id ?? null,
        };
      });

    const lotPeriodTotal = items.reduce((s, it) => s + it.amount, 0);
    const owner = owners.get(lot.id);
    return {
      lot_id: lot.id,
      lot_number: lot.lot_number,
      unit_number: lot.unit_number,
      owner_display_name: owner?.owner_display_name ?? null,
      owner_contact_email: owner?.owner_contact_email ?? null,
      lot_entitlement: lotUE,
      total_entitlement: defaultTotal,
      proportion,
      base_amount: lotPeriodTotal,
      items,
    };
  });

  return {
    data: {
      budget_id: budgetId,
      financial_year: budget.financial_year,
      fund_type: budget.fund_type,
      period_label: nextPeriod.label,
      period_start: nextPeriod.start,
      period_end: nextPeriod.end,
      due_date: nextPeriod.due_date,
      period_amount: previewLots.reduce((s, l) => s + l.base_amount, 0),
      total_entitlement: defaultTotal,
      lots: previewLots,
      billing_cycle: oc.billing_cycle,
    },
  };
}

// ─── Create levy batch (generate levies) ───────────────────
//
// Atomicity approach (Prompt 1 , Option B orchestration):
//   1. Insert levy_batches row (status='draft').
//   2. Per lot: allocate reference number, insert levy_notices, insert
//      levy_notice_items.
//   3. Defensive parity check , if the loop produced fewer notices than lots
//      we were given, bail out with a CRITICAL audit entry. The batch row
//      is left in place (notices too) so an operator can inspect.
//   4. Generate PDFs in parallel and stamp pdf_url.
//      (The old step 4 wrote ledger debits via rpc_levy_batch_debit; that
//       was removed when the reconciliation/ledger stack was nuked.)
//
// Not using a single monolithic RPC because PDF generation + R2 uploads
// live in JS and would require base64-shuttling through SQL.
// Receiving account for levy payments. Owners pay into the OC's ADMIN
// (operating) trust account , the "main" account , regardless of which fund
// a levy belongs to; the money is then disbursed across fund ledgers
// internally. Prefer the operating bank_accounts row; fall back to the
// legacy OC-level columns when no admin account exists yet. Returns null when
// neither is configured (PDF then shows blank EFT, as before).
// Bulk reference lookup for a set of levy notices. Returns a
// Map<levyId, ref> using a strict precedence:
//
//   1. DRN (lot_drns active on the levy's period_start)
//   2. lot_owners.payment_reference (e.g. "WHDPE-001" , generated on OC
//      creation as a system-owned "owner reference" similar to a DRN)
//
// The internal LEV-NNNN reference number is NEVER surfaced to owners.
// If neither a DRN nor a payment_reference exists, the levy is mapped to
// an empty string and callers should fall back to whatever sensible
// label they have (lot number, owner name) , but in practice every lot
// gets a payment_reference at OC creation, so this Map is always
// populated.
// For each lot, count how many OTHER lots in the same OC share the same
// owner contact (by email when present, otherwise by lot_owners.name).
// Used to drive the auto multi-lot note + future "you own N lots"
// hints. Returns Map<lotId, totalLotsThisOwnerHolds>; 1 = single-lot,
// 2+ = multi-lot.
async function countLotsPerOwnerInOc(
  supabase: ReturnType<typeof createServerClient>,
  ocId: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const { data: rows } = await supabase
    .from("lot_owners")
    .select("lot_id, name, email")
    .eq("oc_id", ocId);
  if (!rows?.length) return result;
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.lot_id) continue;
    const key = (r.email ?? r.name ?? "").trim().toLowerCase();
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    if (!arr.includes(r.lot_id)) arr.push(r.lot_id);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    for (const lotId of arr) result.set(lotId, arr.length);
  }
  return result;
}

async function resolveLevyReferences(
  supabase: ReturnType<typeof createServerClient>,
  levies: Array<{ id: string; lot_id: string; period_start: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!levies.length) return result;
  const lotIds = Array.from(new Set(levies.map((l) => l.lot_id))).filter(Boolean) as string[];
  if (!lotIds.length) return result;

  // ── 1. DRN cascade ────────────────────────────────────────
  const { data: drnRows } = await supabase
    .from("lot_drns")
    .select("lot_id, drn, active_from, active_to")
    .in("lot_id", lotIds);
  const drnByLevy = new Map<string, string>();
  for (const levy of levies) {
    const matches = (drnRows ?? [])
      .filter((r) => r.lot_id === levy.lot_id)
      .filter((r) => r.active_from <= levy.period_start)
      .filter((r) => !r.active_to || r.active_to >= levy.period_start)
      .sort((a, b) => (a.active_from < b.active_from ? 1 : -1));
    if (matches[0]) drnByLevy.set(levy.id, matches[0].drn);
  }

  // ── 2. payment_reference cascade ──────────────────────────
  // First-seen wins for joint-owner lots.
  const { data: ownerRows } = await supabase
    .from("lot_owners")
    .select("lot_id, payment_reference")
    .in("lot_id", lotIds);
  const refByLot = new Map<string, string>();
  for (const r of ownerRows ?? []) {
    if (r.lot_id && r.payment_reference && !refByLot.has(r.lot_id)) {
      refByLot.set(r.lot_id, r.payment_reference);
    }
  }

  for (const levy of levies) {
    const drn = drnByLevy.get(levy.id);
    if (drn) {
      result.set(levy.id, drn);
      continue;
    }
    const owner = refByLot.get(levy.lot_id);
    if (owner) {
      result.set(levy.id, owner);
      continue;
    }
    result.set(levy.id, ""); // sentinel , callers default to lot label
  }
  return result;
}

async function resolveReceivingEft(
  supabase: ReturnType<typeof createServerClient>,
  ocId: string,
  oc: {
    bank_bsb?: string | null;
    bank_account_number?: string | null;
    bank_account_name?: string | null;
    name?: string | null;
  } | null,
): Promise<{ bsb: string; account_number: string; account_name: string } | null> {
  const { data: admin } = await supabase
    .from("bank_accounts")
    .select("bsb, account_number, account_name")
    .eq("oc_id", ocId)
    .eq("fund_type", "operating")
    .limit(1)
    .maybeSingle();
  if (admin?.bsb && admin?.account_number) {
    return {
      bsb: admin.bsb,
      account_number: admin.account_number,
      account_name: admin.account_name ?? oc?.name ?? "",
    };
  }
  if (oc?.bank_bsb && oc?.bank_account_number) {
    return {
      bsb: oc.bank_bsb,
      account_number: oc.bank_account_number,
      account_name: oc.bank_account_name ?? oc?.name ?? "",
    };
  }
  return null;
}

// Per-lot apportionment for a SPECIAL levy. Returns one row per active
// lot in the OC with the lot's calculated share of the supplied total
// amount, distributed by lot_liability (with lot_entitlement as a
// fallback, matching the regular generator). The caller can then
// adjust the per-lot amounts in the UI before sending to createLevyBatch.
export async function previewSpecialLevy(
  ocId: string,
  totalAmount: number,
): Promise<{
  data?: {
    lots: Array<{
      lot_id: string;
      lot_number: number;
      unit_number: string | null;
      owner_display_name: string | null;
      liability: number;
      share: number;
    }>;
    total: number;
  };
  error?: string;
}> {
  await requireOCAccess(ocId);
  const supabase = createServerClient();
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return { error: "Total amount must be greater than zero." };
  }

  const { data: rawLots } = await supabase
    .from("lots")
    .select("id, lot_number, unit_number, lot_entitlement, lot_liability")
    .eq("oc_id", ocId)
    .order("lot_number");
  if (!rawLots?.length) return { error: "No lots found." };

  const lotIds = rawLots.map((l) => l.id);
  const owners = await getLotOwners(supabase, lotIds);

  // Liability denominator: prefer lot_liability, fall back to entitlement,
  // last-resort 1 so each lot pays an equal share.
  const liabilities = rawLots.map((l) => ({
    id: l.id,
    lot_number: l.lot_number,
    unit_number: l.unit_number,
    liability:
      Number(l.lot_liability) > 0
        ? Number(l.lot_liability)
        : Number(l.lot_entitlement) > 0
        ? Number(l.lot_entitlement)
        : 1,
  }));
  const totalLiability = liabilities.reduce((s, l) => s + l.liability, 0);

  // Cents-precise apportionment: round to 2dp and assign the residual
  // (rounding drift) to the lot with the largest liability so the sum
  // ties out to totalAmount exactly.
  const cents = Math.round(totalAmount * 100);
  let assignedCents = 0;
  const shares = liabilities.map((l) => {
    const portion = Math.round((l.liability / totalLiability) * cents);
    assignedCents += portion;
    return { ...l, shareCents: portion };
  });
  const drift = cents - assignedCents;
  if (drift !== 0) {
    const largest = shares.reduce((a, b) => (a.liability >= b.liability ? a : b));
    largest.shareCents += drift;
  }

  return {
    data: {
      lots: shares.map((s) => ({
        lot_id: s.id,
        lot_number: s.lot_number,
        unit_number: s.unit_number,
        owner_display_name: owners.get(s.id)?.owner_display_name ?? null,
        liability: s.liability,
        share: s.shareCents / 100,
      })),
      total: totalAmount,
    },
  };
}

export async function createLevyBatch(
  ocId: string,
  data: {
    /** Required for regular budget-driven batches; null for special levies. */
    budget_id: string | null;
    financial_year: string;
    fund_type: "operating" | "maintenance_plan";
    period_label: string;
    period_start: string;
    period_end: string;
    due_date: string;
    /** Date printed as "Issue date" on every notice in the batch. The
     *  manager picks it in the generate flow (back-dating a batch they
     *  raised earlier is routine); omitted means today. */
    issue_date?: string | null;
    lots: {
      lot_id: string;
      amount: number;
      items: {
        description: string;
        amount: number;
        budget_item_id: string | null;
        is_adjustment: boolean;
        /** Optional CoA account this line was raised against. Surfaced
         *  to managers in the levy detail page (Code column); never
         *  shown to lot owners on the PDF. */
        coa_account_id?: string | null;
      }[];
    }[];
    /** Set true for special-purpose one-off levies. The batch gets
     *  is_special=true + the descriptive purpose, and notices are
     *  marked levy_type='special'. */
    is_special?: boolean;
    special_purpose?: string;
    /** Internal: when called from a server-only system context (e.g.
     *  the auto-send cron), the caller resolves the performer profile
     *  itself and skips the Clerk-based auth check that the manager
     *  UI flow needs. NEVER expose this to client callers. */
    _systemPerformerId?: string;
  },
): Promise<{ batchId?: string; error?: string }> {
  const profile = data._systemPerformerId
    ? { id: data._systemPerformerId }
    : await requireCompanyRole();
  if (!data._systemPerformerId) await requireOCAccess(ocId);
  const supabase = createServerClient();

  const totalAmount = data.lots.reduce((sum, lot) => sum + lot.amount, 0);

  // Issue date the manager picked, falling back to today. Persisted on the
  // batch AND every notice so a later regeneration reprints the same date
  // instead of stamping whatever day the PDF happened to be rebuilt.
  const issueDate = data.issue_date || new Date().toISOString().slice(0, 10);

  // Create batch
  const { data: batch, error: batchError } = await supabase
    .from("levy_batches")
    .insert({
      oc_id: ocId,
      budget_id: data.budget_id,
      financial_year: data.financial_year,
      fund_type: data.fund_type,
      period_start: data.period_start,
      period_end: data.period_end,
      period_label: data.period_label,
      due_date: data.due_date,
      issue_date: issueDate,
      total_amount: totalAmount,
      levy_count: data.lots.length,
      status: "draft",
      generated_by: profile.id,
      is_special: data.is_special ?? false,
      special_purpose: data.special_purpose ?? null,
    })
    .select("id")
    .single();

  if (batchError) return { error: batchError.message };

  // Fetch oc + management company for PDF generation
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, address, abn, plan_number, bank_bsb, bank_account_number, bank_account_name, management_company_id")
    .eq("id", ocId)
    .single();

  let managementCompany = { name: "", logo_url: null as string | null };
  let brandColors = { primary: "#0E314C", secondary: "#CFA753" };
  if (oc?.management_company_id) {
    const { data: mc } = await supabase
      .from("management_companies")
      .select("name, logo_url, brand_color, brand_color_secondary")
      .eq("id", oc.management_company_id)
      .single();
    if (mc) {
      managementCompany = { name: mc.name, logo_url: mc.logo_url };
      const isHex = (v: string | null | undefined): v is string =>
        !!v && /^#[0-9a-f]{3,8}$/i.test(v);
      brandColors = {
        primary: isHex(mc.brand_color) ? mc.brand_color : "#0E314C",
        secondary: isHex(mc.brand_color_secondary) ? mc.brand_color_secondary : "#CFA753",
      };
    }
  }

  // Fetch lot details for PDF
  const lotIds = data.lots.map((l) => l.lot_id);
  const { data: lotsData } = await supabase
    .from("lots")
    .select("id, lot_number, unit_number")
    .in("id", lotIds);
  const lotMap = new Map((lotsData ?? []).map((l) => [l.id, l]));
  const ownerMap = await getLotOwners(supabase, lotIds);

  // Build payment instructions (EFT from oc, no BPAY if not configured)
  const eftAccount = await resolveReceivingEft(supabase, ocId, oc);

  // Step 1: Create all levy notices in DB (sequential for reference numbers).
  // Skip lots that owe $0 for this period — there's nothing to bill so we
  // don't generate a notice / PDF / ledger debit. They still appear in the
  // breakdown UI; we just don't write a row for them. The defensive
  // count-check below uses billableLots so a fully-zero allocation doesn't
  // get flagged as a partial insert.
  const billableLots = data.lots.filter((l) => Number(l.amount) > 0);
  const createdLevies: { id: string; lotId: string; refNum: string; items: typeof data.lots[0]["items"] }[] = [];

  for (const lot of billableLots) {
    // Special levies use their own SLEV-NNNN per-OC sequence (the SLEV
    // counter lives on owners_corporations.next_special_levy_number).
    // Distinct prefix keeps ledger + audit lines obviously different
    // from standard contributions in reporting.
    const refPrefix = data.is_special ? "SLEV" : "LEV";
    const { data: refNum } = await supabase.rpc("next_reference_number", {
      p_prefix: refPrefix,
      p_oc_id: ocId,
    });
    if (!refNum) continue;

    // BPAY CRN: 7-digit zero-padded number + MOD10V01 check digit.
    // ONLY generated for regular levies , special levies skip BPAY
    // because:
    //   (a) Special levies are typically settled by direct deposit,
    //       not BPAY, and the unique index (oc_id, bpay_crn) would
    //       collide with regular LEV-N notices that share the same
    //       numeric value (SLEV-1's CRN == LEV-1's CRN), causing the
    //       per-lot insert loop to silently fail and the batch to
    //       land "0 of N notices written" in draft.
    //   (b) Macquarie DRN already covers EFT identification.
    const numericStr = String(refNum).split("-").pop() ?? "";
    const levyNumber = Number.parseInt(numericStr, 10);
    const bpayCrn = !data.is_special && Number.isFinite(levyNumber)
      ? generateCrn(levyNumber)
      : null;

    const { data: levy, error: levyError } = await supabase
      .from("levy_notices")
      .insert({
        oc_id: ocId,
        lot_id: lot.lot_id,
        budget_id: data.budget_id,
        batch_id: batch.id,
        reference_number: refNum,
        bpay_crn: bpayCrn,
        fund_type: data.fund_type,
        levy_type: data.is_special ? "special" : "regular",
        period_start: data.period_start,
        period_end: data.period_end,
        amount: lot.amount,
        due_date: data.due_date,
        issue_date: issueDate,
        status: "draft",
      })
      .select("id")
      .single();

    if (levyError) { console.error("Failed to create levy:", levyError); continue; }

    const itemInserts = lot.items
      .filter((item) => item.amount !== 0)
      .map((item, i) => ({
        levy_notice_id: levy.id,
        description: item.description,
        amount: item.amount,
        is_adjustment: item.is_adjustment,
        budget_item_id: item.budget_item_id,
        coa_account_id: item.coa_account_id ?? null,
        sort_order: i,
      }));

    if (itemInserts.length > 0) {
      await supabase.from("levy_notice_items").insert(itemInserts);
    }

    createdLevies.push({ id: levy.id, lotId: lot.lot_id, refNum, items: lot.items });
  }

  // Defensive: every billable lot must have produced a notice. If not, some
  // step silently failed , surface loudly before we write ledger debits.
  // ($0 lots are intentionally excluded from billableLots above.)
  if (createdLevies.length !== billableLots.length) {
    await supabase.from("audit_log").insert({
      profile_id: profile.id,
      oc_id: ocId,
      action: "levy_batch.notice_insert.partial",
      entity_type: "levy_batch",
      entity_id: batch.id,
      metadata: {
        severity: "critical",
        expected_lot_count: billableLots.length,
        actual_notice_count: createdLevies.length,
        message:
          "Per-lot notice insert loop produced fewer notices than billable lots. Ledger debits not written. Batch left in draft for manual inspection.",
      },
    });
    return {
      error:
        `Levy batch partially inserted (${createdLevies.length}/${billableLots.length} notices). ` +
        `Ledger debits not written. Batch id ${batch.id} left in draft for manual review.`,
    };
  }

  // Step 1.5 (ledger debit) was removed when the reconciliation /
  // ledger stack was nuked. Batches are now persisted as notices +
  // line items only; the ledger will be rebuilt in a follow-up.

  // Owner-facing payment reference for the EFT "Reference" line: DRN >
  // lot_owners.payment_reference > "Lot N". NEVER the internal LEV-NNNN
  // sequence (that's our DB counter, shown only as the document reference
  // top-right). Mirrors assembleLevyNoticeProps so every levy PDF, however
  // it's produced, prints the same reference the owner reconciles against.
  const ownerRefByLevy = await resolveLevyReferences(
    supabase,
    createdLevies.map((l) => ({ id: l.id, lot_id: l.lotId, period_start: data.period_start })),
  );

  // Step 2: Generate all PDFs in parallel and upload to R2
  const pdfPromises = createdLevies.map(async (levy) => {
    try {
      const lotInfo = lotMap.get(levy.lotId);
      const ownerInfo = ownerMap.get(levy.lotId);
      const ownerRef = ownerRefByLevy.get(levy.id) || `Lot ${lotInfo?.lot_number ?? ""}`.trim();
      const pdfProps: LevyNoticeProps = {
        managementCompany,
        oc: {
          name: oc?.name ?? "",
          address: oc?.address ?? "",
          abn: oc?.abn ?? null,
          plan_number: oc?.plan_number ?? "",
        },
        documentTitle: "Levy Notice",
        referenceNumber: levy.refNum,
        date: new Date(`${issueDate}T00:00:00`),
        lotOwner: {
          name: ownerInfo?.owner_display_name ?? "Lot Owner",
          lot_number: `${lotInfo?.lot_number ?? ""}${lotInfo?.unit_number ? ` Unit ${lotInfo.unit_number}` : ""}`,
          address: oc?.address ?? "",
        },
        levyPeriod: { start: formatDateLong(data.period_start), end: formatDateLong(data.period_end) },
        lineItems: levy.items
          .filter((item) => item.amount !== 0)
          .map((item) => ({ description: item.description, amount: item.amount })),
        totalDue: levy.items.reduce((s, i) => s + i.amount, 0),
        dueDate: formatDateLong(data.due_date),
        paymentInstructions: {
          bpay: null,
          eft: eftAccount ? {
            ...eftAccount,
            reference: ownerRef,
          } : { bsb: "", account_number: "", account_name: "", reference: ownerRef },
        },
        brandColors,
      };

      // Upload to R2 (confidential bucket per CONFIDENTIAL_PREFIXES). The
      // public URL it returns won't resolve from outside the app , that's
      // intentional. We persist the authenticated app URL instead so the
      // dashboard <a href={pdf_url}> still works. The ?v cache-buster changes
      // each (re)generation so a refreshed dashboard never serves a stale
      // browser-cached PDF after the levy is regenerated.
      await generateAndUploadLevyPDF(pdfProps, ocId, levy.refNum);
      const pdfUrl = `/api/levies/${levy.id}/pdf?v=${Date.now()}`;
      await supabase.from("levy_notices").update({ pdf_url: pdfUrl }).eq("id", levy.id);
    } catch (err) {
      console.error("PDF generation failed for", levy.refNum, err);
    }
  });

  await Promise.all(pdfPromises);

  // Audit log
  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "create",
    entity_type: "levy_batch",
    entity_id: batch.id,
    after_state: {
      period_label: data.period_label,
      issue_date: issueDate,
      total_amount: totalAmount,
      levy_count: createdLevies.length,
      lots_supplied: data.lots.length,
      lots_skipped_zero_amount: data.lots.length - billableLots.length,
    },
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");

  return { batchId: batch.id };
}

// ─── Get levy batches for oc ──────────────────────

export async function getLevyBatches(ocId: string): Promise<LevyBatchSummary[]> {
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data } = await supabase
    .from("levy_batches")
    .select("*")
    .eq("oc_id", ocId)
    .order("created_at", { ascending: false });

  return (data ?? []).map((b) => ({
    id: b.id,
    financial_year: b.financial_year,
    fund_type: b.fund_type,
    period_label: b.period_label,
    period_start: b.period_start,
    period_end: b.period_end,
    due_date: b.due_date,
    total_amount: Number(b.total_amount),
    levy_count: b.levy_count,
    status: b.status,
    created_at: b.created_at,
    is_special: b.is_special ?? false,
  }));
}

// ─── Get single batch with levy details ────────────────────

export async function getLevyBatchDetail(ocId: string, batchId: string): Promise<LevyBatchDetail | null> {
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: batch } = await supabase
    .from("levy_batches")
    .select("*")
    .eq("id", batchId)
    .eq("oc_id", ocId)
    .single();

  if (!batch) return null;

  const { data: levies } = await supabase
    .from("levy_notices")
    .select("id, lot_id, reference_number, amount, status, pdf_url, lots!inner(lot_number, unit_number)")
    .eq("batch_id", batchId)
    .order("lots(lot_number)");

  const levyIds = (levies ?? []).map((l) => l.id);
  const lotIds = (levies ?? []).map((l) => l.lot_id).filter(Boolean) as string[];
  // Resolve the lot's CURRENT active DRN. The mapping is time-bounded so we
  // pick the row whose window covers today. Historical batches keep their
  // stored reference; this lookup is only for what we DISPLAY to the
  // manager today.
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: allItems }, owners, { data: drns }, { data: ownerRefs }] = await Promise.all([
    levyIds.length > 0
      ? supabase
          .from("levy_notice_items")
          .select("*, chart_of_accounts(code)")
          .in("levy_notice_id", levyIds)
          .order("sort_order")
      : Promise.resolve({ data: [] }),
    getLotOwners(supabase, lotIds),
    lotIds.length > 0
      ? supabase
          .from("lot_drns")
          .select("lot_id, drn, active_from, active_to")
          .in("lot_id", lotIds)
          .lte("active_from", today)
      : Promise.resolve({ data: [] }),
    lotIds.length > 0
      ? supabase
          .from("lot_owners")
          .select("lot_id, payment_reference")
          .in("lot_id", lotIds)
          .not("payment_reference", "is", null)
      : Promise.resolve({ data: [] }),
  ]);
  const drnByLot = new Map<string, string>();
  for (const d of (drns ?? []) as Array<{ lot_id: string; drn: string; active_to: string | null }>) {
    if (d.active_to && d.active_to < today) continue;
    if (!drnByLot.has(d.lot_id)) drnByLot.set(d.lot_id, d.drn);
  }
  const ownerRefByLot = new Map<string, string>();
  for (const r of (ownerRefs ?? []) as Array<{ lot_id: string; payment_reference: string }>) {
    if (!ownerRefByLot.has(r.lot_id)) ownerRefByLot.set(r.lot_id, r.payment_reference);
  }

  return {
    id: batch.id,
    financial_year: batch.financial_year,
    fund_type: batch.fund_type,
    period_label: batch.period_label,
    period_start: batch.period_start,
    period_end: batch.period_end,
    due_date: batch.due_date,
    total_amount: Number(batch.total_amount),
    levy_count: batch.levy_count,
    status: batch.status,
    created_at: batch.created_at,
    is_special: (batch as { is_special?: boolean }).is_special ?? false,
    levies: (levies ?? []).map((l) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lot = (l as any).lots;
      const owner = owners.get(l.lot_id);
      return {
        id: l.id,
        lot_id: l.lot_id,
        lot_number: lot?.lot_number ?? 0,
        unit_number: lot?.unit_number ?? null,
        owner_display_name: owner?.owner_display_name ?? null,
        owner_contact_email: owner?.owner_contact_email ?? null,
        reference_number: l.reference_number,
        drn: drnByLot.get(l.lot_id) ?? null,
        payment_reference: ownerRefByLot.get(l.lot_id) ?? null,
        amount: Number(l.amount),
        status: l.status,
        pdf_url: l.pdf_url,
        items: (allItems ?? [])
          .filter((item) => item.levy_notice_id === l.id)
          .map((item) => ({
            description: item.description,
            amount: Number(item.amount),
            is_adjustment: item.is_adjustment,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            coa_code: ((item as any).chart_of_accounts as { code: string } | null)?.code ?? null,
          })),
      };
    }),
  };
}

// ─── Mark batch as sent ────────────────────────────────────

export async function markBatchSent(
  ocId: string,
  batchId: string,
  options: { _systemPerformerId?: string } = {},
) {
  const profile = options._systemPerformerId
    ? { id: options._systemPerformerId }
    : await requireCompanyRole();
  if (!options._systemPerformerId) await requireOCAccess(ocId);
  const supabase = createServerClient();

  // Update all draft levies to issued
  await supabase
    .from("levy_notices")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("batch_id", batchId)
    .eq("status", "draft");

  // Update batch status
  await supabase
    .from("levy_batches")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", batchId);

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "send",
    entity_type: "levy_batch",
    entity_id: batchId,
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");

  return { success: true };
}

// ─── Mark individual levy as sent ──────────────────────────

export async function markLevySent(ocId: string, levyId: string) {
  await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  await supabase
    .from("levy_notices")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("id", levyId);

  // Check if all levies in batch are now issued
  const { data: levy } = await supabase
    .from("levy_notices")
    .select("batch_id")
    .eq("id", levyId)
    .single();

  if (levy?.batch_id) {
    const { data: remaining } = await supabase
      .from("levy_notices")
      .select("id")
      .eq("batch_id", levy.batch_id)
      .eq("status", "draft");

    if (!remaining || remaining.length === 0) {
      await supabase
        .from("levy_batches")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", levy.batch_id);
    } else {
      await supabase
        .from("levy_batches")
        .update({ status: "partially_sent" })
        .eq("id", levy.batch_id);
    }
  }

  revalidatePath("/ocs/[ocCode]/levies", "page");
  return { success: true };
}

// ─── Cancel batch ──────────────────────────────────────────

export async function cancelBatch(ocId: string, batchId: string) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: batch } = await supabase
    .from("levy_batches")
    .select("status")
    .eq("id", batchId)
    .eq("oc_id", ocId)
    .single();

  if (!batch) return { error: "Batch not found" };
  if (batch.status === "ledger_written" || batch.status === "sent" || batch.status === "partially_sent") {
    return {
      error:
        "Cannot cancel a batch once ledger debits have been written. " +
        "Use the void flow (per-notice) to reverse individual levies.",
    };
  }

  // Soft cancel: keep the batch row + every levy_notice + every line
  // item intact so historical info is preserved. Status flips to
  // 'cancelled' on both the batch and its notices so the period is
  // free again for a fresh batch (getAvailablePeriods only blocks on
  // active statuses). Audit/reporting still has the original data.
  //
  // Use returning rows on each UPDATE so a silent failure (RLS denial,
  // bad enum coercion, etc) raises an error instead of looking like a
  // successful no-op. Earlier we hit the issue where the cancel
  // appeared to "delete" the batch , the rows survived but the UI
  // showed nothing because the update silently rejected, and a later
  // delete path elsewhere did the actual removal.
  const nowIso = new Date().toISOString();

  const { error: notesErr } = await supabase
    .from("levy_notices")
    .update({ status: "cancelled", cancelled_at: nowIso })
    .eq("batch_id", batchId)
    .select("id");
  if (notesErr) {
    console.error("[cancelBatch] notices update failed:", notesErr);
    return { error: "Couldn't cancel the batch's levies. Try again." };
  }

  const { data: batchRow, error: batchUpdErr } = await supabase
    .from("levy_batches")
    .update({ status: "cancelled", cancelled_at: nowIso })
    .eq("id", batchId)
    .select("id, status")
    .single();
  if (batchUpdErr || !batchRow) {
    console.error("[cancelBatch] batch update failed:", batchUpdErr);
    return { error: "Couldn't cancel the batch. Try again." };
  }

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "cancel",
    entity_type: "levy_batch",
    entity_id: batchId,
    metadata: { mode: "soft", policy: "keep_rows_free_period" },
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");
  revalidatePath(`/ocs/[ocCode]/levies/${batchId}`, "page");
  return { success: true };
}

// ─── Regenerate batch (new due date, new PDFs) ────────────

export async function regenerateBatch(ocId: string, batchId: string, newDueDate: string) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  // Read the batch's issue date first , regeneration changes the due date
  // only. The printed issue date is whatever the manager picked when the
  // batch was raised, never the day of the rebuild.
  const { data: existingBatch } = await supabase
    .from("levy_batches")
    .select("issue_date")
    .eq("id", batchId)
    .single();
  const issueDate = (existingBatch as { issue_date: string | null } | null)?.issue_date ?? null;

  // Update batch due date
  await supabase
    .from("levy_batches")
    .update({ due_date: newDueDate, status: "draft" })
    .eq("id", batchId);

  // Update all levy notices with new due date and revert to draft
  await supabase
    .from("levy_notices")
    .update({ due_date: newDueDate, status: "draft", issued_at: null })
    .eq("batch_id", batchId);

  // Fetch data for PDF regeneration
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, address, abn, plan_number, bank_bsb, bank_account_number, bank_account_name, management_company_id")
    .eq("id", ocId)
    .single();

  let managementCompany = { name: "", logo_url: null as string | null };
  let brandColors = { primary: "#0E314C", secondary: "#CFA753" };
  if (oc?.management_company_id) {
    const { data: mc } = await supabase
      .from("management_companies")
      .select("name, logo_url, brand_color, brand_color_secondary")
      .eq("id", oc.management_company_id)
      .single();
    if (mc) {
      managementCompany = { name: mc.name, logo_url: mc.logo_url };
      const isHex = (v: string | null | undefined): v is string =>
        !!v && /^#[0-9a-f]{3,8}$/i.test(v);
      brandColors = {
        primary: isHex(mc.brand_color) ? mc.brand_color : "#0E314C",
        secondary: isHex(mc.brand_color_secondary) ? mc.brand_color_secondary : "#CFA753",
      };
    }
  }

  const eftAccount = await resolveReceivingEft(supabase, ocId, oc);

  // Get levies with lot info and items
  const { data: levies } = await supabase
    .from("levy_notices")
    .select("id, reference_number, amount, period_start, period_end, lot_id, lots!inner(lot_number, unit_number)")
    .eq("batch_id", batchId);

  const regenLotIds = (levies ?? []).map((l) => l.lot_id).filter(Boolean) as string[];
  const regenOwners = await getLotOwners(supabase, regenLotIds);

  // Owner payment reference (DRN > payment_reference > "Lot N") for the EFT
  // line, same as createLevyBatch. Never the internal LEV-NNNN.
  const ownerRefByLevy = await resolveLevyReferences(
    supabase,
    (levies ?? []).map((l) => ({ id: l.id, lot_id: l.lot_id as string, period_start: l.period_start })),
  );

  // Regenerate PDFs in parallel
  const pdfPromises = (levies ?? []).map(async (levy) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lot = (levy as any).lots;
      const owner = regenOwners.get(levy.lot_id);
      const ownerRef = ownerRefByLevy.get(levy.id) || `Lot ${lot?.lot_number ?? ""}`.trim();
      const { data: items } = await supabase
        .from("levy_notice_items")
        .select("description, amount")
        .eq("levy_notice_id", levy.id)
        .order("sort_order");

      const pdfProps: LevyNoticeProps = {
        managementCompany,
        oc: {
          name: oc?.name ?? "",
          address: oc?.address ?? "",
          abn: oc?.abn ?? null,
          plan_number: oc?.plan_number ?? "",
        },
        documentTitle: "Levy Notice",
        referenceNumber: levy.reference_number,
        date: issueDate ? new Date(`${issueDate}T00:00:00`) : new Date(),
        lotOwner: {
          name: owner?.owner_display_name ?? "Lot Owner",
          lot_number: `${lot?.lot_number ?? ""}${lot?.unit_number ? ` Unit ${lot.unit_number}` : ""}`,
          address: oc?.address ?? "",
        },
        levyPeriod: { start: formatDateLong(levy.period_start), end: formatDateLong(levy.period_end) },
        lineItems: (items ?? []).map((i) => ({ description: i.description, amount: Number(i.amount) })),
        totalDue: Number(levy.amount),
        dueDate: formatDateLong(newDueDate),
        paymentInstructions: {
          bpay: null,
          eft: eftAccount ? {
            ...eftAccount,
            reference: ownerRef,
          } : { bsb: "", account_number: "", account_name: "", reference: ownerRef },
        },
        brandColors,
      };

      // Upload to R2 (confidential bucket). The public URL it returns won't
      // resolve from outside the app , persist the authenticated app route
      // instead so the dashboard <a href={pdf_url}> hits /api/levies, which
      // streams the bytes via fetchObject. (Mirrors createLevyBatch; storing
      // the CDN URL here was the 404-on-regenerate bug.)
      await generateAndUploadLevyPDF(pdfProps, ocId, levy.reference_number);
      // ?v changes every regeneration so a dashboard that already cached the
      // previous PDF (Cache-Control max-age) re-fetches the fresh one , this
      // was why "only some" notices appeared to keep the old due date.
      const pdfUrl = `/api/levies/${levy.id}/pdf?v=${Date.now()}`;
      await supabase.from("levy_notices").update({ pdf_url: pdfUrl }).eq("id", levy.id);
    } catch (err) {
      console.error("PDF regeneration failed for", levy.reference_number, err);
    }
  });

  await Promise.all(pdfPromises);

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "regenerate",
    entity_type: "levy_batch",
    entity_id: batchId,
    after_state: { new_due_date: newDueDate },
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");
  return { success: true };
}

// ─── Recall batch (unsend , revert to draft) ──────────────

export async function recallBatch(ocId: string, batchId: string) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  // Can't recall if any levy is already paid
  const { data: paidLevies } = await supabase
    .from("levy_notices")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "paid");

  if (paidLevies && paidLevies.length > 0) {
    return { error: "Cannot recall , some levies have already been paid" };
  }

  // Revert all levies to draft
  await supabase
    .from("levy_notices")
    .update({ status: "draft", issued_at: null })
    .eq("batch_id", batchId);

  // Revert batch status
  await supabase
    .from("levy_batches")
    .update({ status: "draft", sent_at: null })
    .eq("id", batchId);

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "recall",
    entity_type: "levy_batch",
    entity_id: batchId,
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");
  return { success: true };
}

// Resolve the active lot_owner row id for a lot at "now". Used to
// stamp communication_log rows so historical communications stay tied
// to the owner who held the lot when they were sent (lot owner
// segregation , a new owner doesn't inherit the previous owner's
// inbox).
async function activeLotOwnerId(
  supabase: ReturnType<typeof createServerClient>,
  lotId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("lot_owners")
    .select("id, ownership_since")
    .eq("lot_id", lotId)
    .order("ownership_since", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// Centralised insert for email/letter sends into communication_log.
// Keeps the column set + segregation rule (lot_owner_id_at_creation) in
// one place so future sends can't accidentally drop fields the lot
// communications tab + audit trail rely on.
async function logLevyCommunication(
  supabase: ReturnType<typeof createServerClient>,
  args: {
    ocId: string;
    lotId: string;
    senderProfileId: string;
    recipientEmail?: string | null;
    channel: "email" | "letter";
    subject: string;
    levyNoticeId: string;
    bodyPreview?: string;
    externalId?: string | null;
    status?: "queued" | "sent" | "delivered" | "opened" | "bounced" | "failed";
    sentAt?: string;
  },
): Promise<void> {
  const ownerId = await activeLotOwnerId(supabase, args.lotId);
  await supabase.from("communication_log").insert({
    oc_id: args.ocId,
    lot_id: args.lotId,
    lot_owner_id_at_creation: ownerId,
    sender_profile_id: args.senderProfileId,
    recipient_email: args.recipientEmail ?? null,
    channel: args.channel,
    direction: "outbound",
    type: "levy_notice",
    subject: args.subject,
    external_id: args.externalId ?? null,
    status: args.status ?? "sent",
    sent_at: args.sentAt ?? new Date().toISOString(),
    related_entity_type: "levy_notice",
    related_entity_id: args.levyNoticeId,
    body_preview: args.bodyPreview ?? null,
    confidential: false,
  });
}

// ─── Send batch emails ─────────────────────────────────────

// Send batch emails with per-levy recipient overrides + extra attachments
// applied to every send. Wraps sendBatchEmails' logic but accepts the
// extras instead of using defaults. Called from the "Send by email" popup
// on the batch detail page (so a manager can correct a wrong email or
// attach a meeting agenda / cover letter on this one batch).
export async function sendBatchEmailsCustom(
  ocId: string,
  batchId: string,
  options: {
    /** Optional: { levyId: emailOverride }. Falls back to owner email. */
    emailOverrides?: Record<string, string>;
    /** Optional: extra files (base64-encoded) attached to every email. */
    extraAttachments?: Array<{ filename: string; contentBase64: string; contentType: string }>;
    /** Optional: override the FROM mailbox address. The dialog passes the
     *  manager's selection so the email comes from the right account. */
    fromAddress?: string;
    /** Internal: bypass Clerk auth check when invoked from a system
     *  context (auto-send cron). NEVER expose to client callers. */
    _systemPerformerId?: string;
  } = {},
): Promise<{ sentCount?: number; error?: string }> {
  const profile = options._systemPerformerId
    ? { id: options._systemPerformerId }
    : await requireCompanyRole();
  if (!options._systemPerformerId) await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: batch } = await supabase
    .from("levy_batches")
    .select("period_label")
    .eq("id", batchId)
    .single();

  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, plan_number, address, abn, management_company_id")
    .eq("id", ocId)
    .single();

  let managementCompanyLogoUrl: string | null = null;
  if (oc?.management_company_id) {
    const { data: mc } = await supabase
      .from("management_companies")
      .select("logo_url")
      .eq("id", oc.management_company_id)
      .single();
    managementCompanyLogoUrl = mc?.logo_url ?? null;
  }

  const { data: levies } = await supabase
    .from("levy_notices")
    .select("id, reference_number, amount, due_date, period_start, lot_id")
    .eq("batch_id", batchId)
    .eq("status", "draft");
  if (!levies?.length) return { error: "No draft levies to send" };

  const lotIds = levies.map((l) => l.lot_id).filter(Boolean) as string[];
  const owners = await getLotOwners(supabase, lotIds);
  // Pull the active DRN per lot at the levy's period_start so the email
  // body shows the same reference the PDF and Macquarie reconciliation use.
  const drnByLevy = await resolveLevyReferences(supabase, levies);

  // Materialise extra attachments once , they're the same on every email.
  const extras = (options.extraAttachments ?? []).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.contentBase64, "base64"),
    contentType: a.contentType,
  }));

  let sentCount = 0;
  for (const levy of levies) {
    const owner = owners.get(levy.lot_id);
    const overrideEmail = options.emailOverrides?.[levy.id]?.trim() || null;
    const email = overrideEmail || owner?.owner_contact_email || null;
    if (!email) continue;

    try {
      const pdfBuffer = await getLevyNoticePdfBuffer(levy.id, supabase);
      if (!pdfBuffer) {
        console.error("No PDF available for levy", levy.reference_number);
        continue;
      }

      const formatCurrency = (n: number) =>
        new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

      // DRN-first → payment_reference (owner reference). LEV-NNNN is
      // internal-only and is never surfaced to owners. Sentinel empty
      // string falls back to the lot label so the email still names
      // *something* useful (resolveLevyReferences always populates the
      // map; the fallback is a defensive guard).
      const resolvedRef = drnByLevy.get(levy.id) ?? "";
      const displayRef = resolvedRef || `Lot ${levy.lot_id}`;

      await sendLevyEmail({
        to: email,
        ownerName: owner?.owner_display_name ?? null,
        ocName: oc?.name ?? "",
        ocAddress: oc?.address ?? "",
        companyLogoUrl: managementCompanyLogoUrl,
        referenceNumber: levy.reference_number,
        dueDate: formatDateLong(levy.due_date),
        totalAmount: formatCurrency(Number(levy.amount)),
        periodLabel: batch?.period_label ?? "",
        pdfBuffer,
        pdfFilename: `${levy.reference_number}.pdf`,
        extraAttachments: extras,
        ocId,
        fromOverride: options.fromAddress ?? null,
      });

      await logLevyCommunication(supabase, {
        ocId,
        lotId: levy.lot_id,
        senderProfileId: profile.id,
        recipientEmail: email,
        channel: "email",
        subject: `Levy notice ${displayRef}`,
        levyNoticeId: levy.id,
        bodyPreview: `Levy ${displayRef} due ${formatDateLong(levy.due_date)} (${formatCurrency(Number(levy.amount))})`,
      });

      await supabase
        .from("levy_notices")
        .update({ status: "issued", issued_at: new Date().toISOString() })
        .eq("id", levy.id);
      sentCount++;
    } catch (err) {
      console.error("Failed to send levy email for", levy.reference_number, err);
    }
  }

  const { data: remaining } = await supabase
    .from("levy_notices")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "draft");
  const newStatus = (!remaining || remaining.length === 0) ? "sent" : "partially_sent";
  await supabase
    .from("levy_batches")
    .update({ status: newStatus, ...(newStatus === "sent" ? { sent_at: new Date().toISOString() } : {}) })
    .eq("id", batchId);

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "send_emails_custom",
    entity_type: "levy_batch",
    entity_id: batchId,
    after_state: {
      sent_count: sentCount,
      override_count: Object.keys(options.emailOverrides ?? {}).length,
      attachment_count: extras.length,
    },
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");
  return { sentCount };
}

// Resend variant: same dialog UX but targets the entire batch (not just
// drafts) and never flips statuses. Used by the "Resend all" button on the
// batch page once everything's already been sent once.
export async function resendBatchEmailsCustom(
  ocId: string,
  batchId: string,
  options: {
    emailOverrides?: Record<string, string>;
    extraAttachments?: Array<{ filename: string; contentBase64: string; contentType: string }>;
    fromAddress?: string;
    /** Internal: bypass Clerk auth when invoked from the background send task. */
    _systemPerformerId?: string;
  } = {},
): Promise<{ sentCount?: number; error?: string }> {
  const profile = options._systemPerformerId
    ? { id: options._systemPerformerId }
    : await requireCompanyRole();
  if (!options._systemPerformerId) await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: batch } = await supabase
    .from("levy_batches")
    .select("period_label")
    .eq("id", batchId)
    .single();
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, plan_number, address, abn, management_company_id")
    .eq("id", ocId)
    .single();

  let logoUrl: string | null = null;
  if (oc?.management_company_id) {
    const { data: mc } = await supabase
      .from("management_companies")
      .select("logo_url")
      .eq("id", oc.management_company_id)
      .single();
    logoUrl = mc?.logo_url ?? null;
  }

  const { data: levies } = await supabase
    .from("levy_notices")
    .select("id, reference_number, amount, due_date, period_start, lot_id")
    .eq("batch_id", batchId);
  if (!levies?.length) return { error: "No levies to resend" };

  const lotIds = levies.map((l) => l.lot_id).filter(Boolean) as string[];
  const owners = await getLotOwners(supabase, lotIds);
  const drnByLevy = await resolveLevyReferences(supabase, levies);

  const extras = (options.extraAttachments ?? []).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.contentBase64, "base64"),
    contentType: a.contentType,
  }));

  let sentCount = 0;
  for (const levy of levies) {
    const owner = owners.get(levy.lot_id);
    const overrideEmail = options.emailOverrides?.[levy.id]?.trim() || null;
    const email = overrideEmail || owner?.owner_contact_email || null;
    if (!email) continue;
    try {
      const pdfBuffer = await getLevyNoticePdfBuffer(levy.id, supabase);
      if (!pdfBuffer) continue;
      const fmt = (n: number) =>
        new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
      const resolvedRef = drnByLevy.get(levy.id) ?? "";
      const displayRef = resolvedRef || `Lot ${levy.lot_id}`;
      await sendLevyEmail({
        to: email,
        ownerName: owner?.owner_display_name ?? null,
        ocName: oc?.name ?? "",
        ocAddress: oc?.address ?? "",
        companyLogoUrl: logoUrl,
        referenceNumber: levy.reference_number,
        dueDate: formatDateLong(levy.due_date),
        totalAmount: fmt(Number(levy.amount)),
        periodLabel: batch?.period_label ?? "",
        pdfBuffer,
        pdfFilename: `${levy.reference_number}.pdf`,
        extraAttachments: extras,
        ocId,
        fromOverride: options.fromAddress ?? null,
      });
      await logLevyCommunication(supabase, {
        ocId,
        lotId: levy.lot_id,
        senderProfileId: profile.id,
        recipientEmail: email,
        channel: "email",
        subject: `Levy notice ${displayRef} (resent)`,
        levyNoticeId: levy.id,
        bodyPreview: `Resent levy ${displayRef} due ${formatDateLong(levy.due_date)} (${fmt(Number(levy.amount))})`,
      });
      sentCount++;
    } catch (err) {
      console.error("Failed to resend levy email for", levy.reference_number, err);
    }
  }

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "resend_emails_custom",
    entity_type: "levy_batch",
    entity_id: batchId,
    after_state: {
      sent_count: sentCount,
      override_count: Object.keys(options.emailOverrides ?? {}).length,
      attachment_count: extras.length,
    },
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");
  return { sentCount };
}

// ─── queueBatchSend (background dispatch for the send/resend dialog) ────────
// The manager's "Send" click should return instantly instead of blocking
// while every notice email goes out. This validates + auth-checks, uploads
// any manager attachments to R2 (so only keys cross the queue), then enqueues
// the send-levy-batch Trigger task. The status flip + email loop happen inside
// the task (via runLevyBatchSend -> sendBatchEmailsCustom). Falls back to an
// inline run when Trigger.dev isn't configured (local dev).
export async function queueBatchSend(
  ocId: string,
  batchId: string,
  mode: "send" | "resend",
  options: {
    emailOverrides?: Record<string, string>;
    extraAttachments?: Array<{ filename: string; contentBase64: string; contentType: string }>;
    fromAddress?: string;
  } = {},
): Promise<{ queued?: boolean; error?: string }> {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);

  // Park attachments in R2 so the queue payload stays small (keys, not bytes).
  const attachmentKeys: Array<{ key: string; filename: string; contentType: string }> = [];
  for (const a of options.extraAttachments ?? []) {
    const safe = a.filename.replace(/[/\\]/g, "_").slice(0, 200) || "attachment";
    const key = `levies/${ocId}/send-attachments/${crypto.randomUUID()}-${safe}`;
    await uploadObject(key, Buffer.from(a.contentBase64, "base64"), a.contentType || "application/octet-stream");
    attachmentKeys.push({ key, filename: a.filename, contentType: a.contentType });
  }

  const payload = {
    ocId,
    batchId,
    mode,
    emailOverrides: options.emailOverrides,
    attachmentKeys,
    fromAddress: options.fromAddress ?? null,
    performerId: profile.id,
  };

  if (process.env.TRIGGER_SECRET_KEY) {
    try {
      await tasks.trigger("send-levy-batch", payload);
      return { queued: true };
    } catch (err) {
      console.error("queueBatchSend: failed to queue send-levy-batch, sending inline", err);
    }
  }
  // Dev / fallback: run inline (still returns once done).
  const res = await runLevyBatchSend(payload);
  if (res.error) return { error: res.error };
  return { queued: true };
}

export async function sendBatchEmails(ocId: string, batchId: string) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  // Get batch info
  const { data: batch } = await supabase
    .from("levy_batches")
    .select("period_label")
    .eq("id", batchId)
    .single();

  // Get oc name
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, bank_bsb, bank_account_number, bank_account_name, plan_number, address, abn, management_company_id")
    .eq("id", ocId)
    .single();

  let managementCompany = { name: "", logo_url: null as string | null };
  if (oc?.management_company_id) {
    const { data: mc } = await supabase
      .from("management_companies")
      .select("name, logo_url")
      .eq("id", oc.management_company_id)
      .single();
    if (mc) {
      managementCompany = { name: mc.name, logo_url: mc.logo_url };
    }
  }

  // Get draft levies with lot info (owner resolved separately)
  const { data: levies } = await supabase
    .from("levy_notices")
    .select("id, reference_number, amount, due_date, period_start, period_end, pdf_url, lot_id, lots!inner(lot_number, unit_number)")
    .eq("batch_id", batchId)
    .eq("status", "draft");

  if (!levies || levies.length === 0) return { error: "No draft levies to send" };

  const sendLotIds = levies.map((l) => l.lot_id).filter(Boolean) as string[];
  const sendOwners = await getLotOwners(supabase, sendLotIds);
  const drnByLevy = await resolveLevyReferences(supabase, levies);

  const eftAccount = await resolveReceivingEft(supabase, ocId, oc);

  let sentCount = 0;
  for (const levy of levies) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lot = (levy as any).lots;
    const owner = sendOwners.get(levy.lot_id);
    const email = owner?.owner_contact_email ?? null;

    if (!email) continue;

    try {
      // Re-use the PDF that was generated + stored when the batch was
      // created. We do NOT re-render here , the dashboard download, the
      // email attachment, and the owner-portal download must all be the
      // SAME file. getLevyNoticePdfBuffer reads pdf_url from R2 and only
      // re-renders if the row never had a PDF (defensive fallback).
      const pdfBuffer = await getLevyNoticePdfBuffer(levy.id, supabase);
      if (!pdfBuffer) {
        console.error("No PDF available for levy", levy.reference_number, ", skipping email");
        continue;
      }

      const formatCurrency = (n: number) =>
        new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

      const resolvedRef = drnByLevy.get(levy.id) ?? "";
      const displayRef = resolvedRef || `Lot ${levy.lot_id}`;

      await sendLevyEmail({
        to: email,
        ownerName: owner?.owner_display_name ?? null,
        ocName: oc?.name ?? "",
        ocAddress: oc?.address ?? "",
        companyLogoUrl: managementCompany.logo_url,
        referenceNumber: levy.reference_number,
        dueDate: formatDateLong(levy.due_date),
        totalAmount: formatCurrency(Number(levy.amount)),
        periodLabel: batch?.period_label ?? "",
        pdfBuffer,
        pdfFilename: `${levy.reference_number}.pdf`,
        ocId,
      });

      await logLevyCommunication(supabase, {
        ocId,
        lotId: levy.lot_id,
        senderProfileId: profile.id,
        recipientEmail: email,
        channel: "email",
        subject: `Levy notice ${displayRef}`,
        levyNoticeId: levy.id,
        bodyPreview: `Levy ${displayRef} due ${formatDateLong(levy.due_date)} (${formatCurrency(Number(levy.amount))})`,
      });

      // Mark as issued
      await supabase
        .from("levy_notices")
        .update({ status: "issued", issued_at: new Date().toISOString() })
        .eq("id", levy.id);

      sentCount++;
    } catch (emailError) {
      console.error("Failed to send levy email for", levy.reference_number, emailError);
    }
  }

  // Update batch status
  const { data: remaining } = await supabase
    .from("levy_notices")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "draft");

  const newStatus = (!remaining || remaining.length === 0) ? "sent" : "partially_sent";
  await supabase
    .from("levy_batches")
    .update({ status: newStatus, ...(newStatus === "sent" ? { sent_at: new Date().toISOString() } : {}) })
    .eq("id", batchId);

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "send_emails",
    entity_type: "levy_batch",
    entity_id: batchId,
    after_state: { sent_count: sentCount },
  });

  // Notify lot owners
  if (sentCount > 0) {
    await notifyOCLotOwners({
      ocId,
      type: "levy_issued",
      title: "New levy notice",
      message: `A levy notice for ${batch?.period_label ?? "this period"} has been issued. Check your levies for details.`,
      link: (await buildOCUrl(ocId, "/my-levies")) ?? "/dashboard",
    });
  }

  revalidatePath("/ocs/[ocCode]/levies", "page");

  return { success: true, sentCount };
}

// ─── Resend batch emails (for already-sent batches) ────────

export async function resendBatchEmails(ocId: string, batchId: string) {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: batch } = await supabase
    .from("levy_batches")
    .select("period_label")
    .eq("id", batchId)
    .single();

  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("name, bank_bsb, bank_account_number, bank_account_name, plan_number, address, abn, management_company_id")
    .eq("id", ocId)
    .single();

  let managementCompany = { name: "", logo_url: null as string | null };
  if (oc?.management_company_id) {
    const { data: mc } = await supabase
      .from("management_companies")
      .select("name, logo_url")
      .eq("id", oc.management_company_id)
      .single();
    if (mc) {
      managementCompany = { name: mc.name, logo_url: mc.logo_url };
    }
  }

  // Get ALL levies (not just drafts)
  const { data: levies } = await supabase
    .from("levy_notices")
    .select("id, reference_number, amount, due_date, period_start, period_end, pdf_url, lot_id, lots!inner(lot_number, unit_number)")
    .eq("batch_id", batchId);

  if (!levies || levies.length === 0) return { error: "No levies to resend" };

  const resendLotIds = levies.map((l) => l.lot_id).filter(Boolean) as string[];
  const resendOwners = await getLotOwners(supabase, resendLotIds);

  const eftAccount = await resolveReceivingEft(supabase, ocId, oc);
  let sentCount = 0;

  for (const levy of levies) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lot = (levy as any).lots;
    const owner = resendOwners.get(levy.lot_id);
    const email = owner?.owner_contact_email ?? null;
    if (!email) continue;

    try {
      // Re-use the stored PDF , no re-render. (See sendBatchEmails for the
      // full reasoning; the dashboard download, email attachment, and owner
      // portal must all serve the same file.)
      const pdfBuffer = await getLevyNoticePdfBuffer(levy.id, supabase);
      if (!pdfBuffer) {
        console.error("No PDF available for levy", levy.reference_number, ", skipping email");
        continue;
      }

      const formatCurrency = (n: number) =>
        new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

      await sendLevyEmail({
        to: email,
        ownerName: owner?.owner_display_name ?? null,
        ocName: oc?.name ?? "",
        ocAddress: oc?.address ?? "",
        companyLogoUrl: managementCompany.logo_url,
        referenceNumber: levy.reference_number,
        dueDate: formatDateLong(levy.due_date),
        totalAmount: formatCurrency(Number(levy.amount)),
        periodLabel: batch?.period_label ?? "",
        pdfBuffer,
        pdfFilename: `${levy.reference_number}.pdf`,
        ocId,
      });

      sentCount++;
    } catch (err) {
      console.error("Failed to resend levy email for", levy.reference_number, err);
    }
  }

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "resend_emails",
    entity_type: "levy_batch",
    entity_id: batchId,
    after_state: { sent_count: sentCount },
  });

  revalidatePath("/ocs/[ocCode]/levies", "page");
  return { success: true, sentCount };
}
