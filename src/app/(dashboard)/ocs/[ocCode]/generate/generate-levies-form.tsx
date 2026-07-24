"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, X, Loader2 } from "lucide-react";
import { formatDayMonthShort, isoToday } from "@/lib/utils";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { DatePicker } from "@/components/shared/date-picker";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  generateLevyPreview,
  createLevyBatch,
  type LevyPreviewData,
  type LevyPreviewLot,
  type AvailablePeriod,
} from "@/lib/actions/levy";
import type { BudgetWithItems } from "@/lib/actions/budget";
import { useOCCode } from "@/lib/oc-context";
import { SpecialLevyForm } from "./special-levy-form";

interface CoaOption {
  id: string;
  code: string;
  name: string;
}

type LevyKind = "regular" | "special";

type FundType = "operating" | "maintenance_plan";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

const FUND_LABEL: Record<string, string> = {
  operating: "Admin Fund",
  maintenance_plan: "Maintenance Plan Fund",
};

function budgetDisplayLabel(b: BudgetWithItems): string {
  // Generate-levies only shows single-fund budgets (multi-fund needs a
  // per-fund picker which isn't wired yet) so fund_type is guaranteed.
  const ft = b.fund_type ?? (b.fund_types?.[0] ?? "");
  return `${FUND_LABEL[ft] ?? ft}, ${b.financial_year} (${formatCurrency(b.total_amount)})`;
}

function periodChipLabel(p: AvailablePeriod): string {
  return `${p.label} ${formatDayMonthShort(p.start)} - ${formatDayMonthShort(p.end)}`;
}

// ─── Lot Accordion Row ─────────────────────────────────────
// Base items (computed from the budget split) are read-only. Adjustments
// (custom line items) can be added, edited, removed freely.

function LotRow({
  lot,
  isOpen,
  onToggle,
  onUpdateAdjustment,
  onAddAdjustment,
  onRemoveAdjustment,
  coaOptions,
  locked,
}: {
  lot: LevyPreviewLot & { adjustments?: { description: string; amount: number; coa_account_id: string | null }[] };
  isOpen: boolean;
  onToggle: () => void;
  onUpdateAdjustment: (adjIndex: number, field: "description" | "amount" | "coa_account_id", value: string | number) => void;
  onAddAdjustment: () => void;
  onRemoveAdjustment: (adjIndex: number) => void;
  coaOptions: CoaOption[];
  locked: boolean;
}) {
  const baseTotal = lot.items.reduce((s, i) => s + i.amount, 0);
  const adjTotal = (lot.adjustments ?? []).reduce((s, a) => s + a.amount, 0);
  const totalAmount = baseTotal + adjTotal;

  return (
    <div className="border-t border-border/50 first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-3 text-sm hover:bg-muted/30 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
          <div className="text-left">
            <span className="font-medium text-foreground">
              Lot {lot.lot_number}
              {lot.unit_number ? ` (Unit ${lot.unit_number})` : ""}
            </span>
            <span className="ml-2 text-muted-foreground">
              {lot.owner_display_name ?? "Unassigned"}
            </span>
          </div>
        </div>
        <span className="font-semibold tabular-nums text-foreground">{formatCurrency(totalAmount)}</span>
      </button>

      {isOpen && (
        <div className="px-4 pb-2 pl-11 space-y-1.5">
          {/* Div + CSS grid version of the per-lot table , identical
              footprint to the special-levy accordion so both flows
              read the same. Cols: description (flex), amount (110px),
              row actions (28px). */}
          <div className="overflow-hidden rounded-md border border-border bg-card">
            <div className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1.5 bg-primary text-[11px] font-medium text-primary-foreground">
              <div>Description</div>
              <div className="text-right">Amount</div>
              <div />
            </div>

            {lot.items.map((item, i) => (
              <div
                key={`base-${i}`}
                className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1 text-[11px] border-t border-border text-foreground"
              >
                <div>{item.description}</div>
                <div className="text-right tabular-nums">{formatCurrency(item.amount)}</div>
                <div />
              </div>
            ))}

            {(lot.adjustments ?? []).map((adj, i) => (
              <div
                key={`adj-${i}`}
                className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1 text-[11px] border-t border-border items-center"
              >
                <Select
                  value={adj.coa_account_id ?? ""}
                  onValueChange={(v) => onUpdateAdjustment(i, "coa_account_id", v ?? "")}
                  disabled={locked}
                >
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue placeholder="Pick a CoA account">
                      {adj.description || null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {coaOptions.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No CoA accounts available</div>
                    ) : (
                      coaOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code} , {c.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <NumberInput
                  value={adj.amount ? String(adj.amount) : ""}
                  onChange={(v) => onUpdateAdjustment(i, "amount", parseFloat(v) || 0)}
                  thousandsSeparator
                  prefix="$"
                  placeholder="Amount"
                  allowDecimal
                  disabled={locked}
                />
                {!locked ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAdjustment(i)}
                    aria-label="Remove adjustment"
                    className="text-muted-foreground hover:text-destructive cursor-pointer justify-self-center"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : <div />}
              </div>
            ))}

            <div className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1 text-[11px] border-t border-border font-semibold">
              <div>Total</div>
              <div className="text-right tabular-nums">{formatCurrency(totalAmount)}</div>
              <div />
            </div>
          </div>
          {!locked && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onAddAdjustment}
              className="mt-3"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add adjustment
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Form ─────────────────────────────────────────────

interface AdjustedLot extends LevyPreviewLot {
  adjustments: { description: string; amount: number; coa_account_id: string | null }[];
}

export function GenerateLeviesForm({
  ocId,
  budgets,
  periodsByBudgetId,
  coaOptions,
  availableFunds,
  preloadedLots,
}: {
  ocId: string;
  budgets: BudgetWithItems[];
  // Pre-loaded on the server so the period dropdown is instant; the form
  // does NOT make a fetch on budget selection.
  periodsByBudgetId: Record<string, AvailablePeriod[]>;
  coaOptions: CoaOption[];
  availableFunds: FundType[];
  /** OC lots + per-lot liability + owner name, pre-loaded server-side
   *  so the special-levy "Calculate per lot levies" button can run
   *  the apportionment math client-side without a round-trip. */
  preloadedLots: Array<{
    lot_id: string;
    lot_number: number;
    unit_number: string | null;
    owner_display_name: string | null;
    liability: number;
  }>;
}) {
  const ocCode = useOCCode();
  const router = useRouter();
  // Step 1: pick the levy kind. Regular = budget-driven quarterly/annual
  // levies; Special = one-off levy for a specific purpose (paint job,
  // legal action, etc) that the budget doesn't cover.
  const [levyKind, setLevyKind] = useState<LevyKind | null>(null);
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>("");
  const [selectedPeriodIndex, setSelectedPeriodIndex] = useState<string>("");
  const [preview, setPreview] = useState<LevyPreviewData | null>(null);
  const [lots, setLots] = useState<AdjustedLot[]>([]);
  const [dueDate, setDueDate] = useState<string>("");
  // Date printed on the notices. Defaults to today; the manager can
  // back-date or forward-date a batch they're raising after the fact.
  const [issueDate, setIssueDate] = useState<string>(isoToday);
  const [issueDateInvalid, setIssueDateInvalid] = useState(false);
  const [periodStart, setPeriodStart] = useState<string>("");
  const [periodEnd, setPeriodEnd] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [openLotId, setOpenLotId] = useState<string | null>(null);

  const selectedBudget = budgets.find((b) => b.id === selectedBudgetId);
  const allPeriods = (selectedBudgetId && periodsByBudgetId[selectedBudgetId]) || [];
  const ungenPeriods = allPeriods.filter((p) => !p.already_generated);
  const selectedPeriod = ungenPeriods.find((p) => String(p.periodIndex) === selectedPeriodIndex);

  function handleBudgetSelect(budgetId: string) {
    if (generating) return;
    setSelectedBudgetId(budgetId);
    setSelectedPeriodIndex("");
    setPreview(null);
    setLots([]);
    setOpenLotId(null);
    setPeriodStart("");
    setPeriodEnd("");
    setDueDate("");
  }

  async function handlePeriodSelect(periodIdx: string) {
    if (generating) return;
    setSelectedPeriodIndex(periodIdx);
    setPreview(null);
    setLots([]);

    if (!periodIdx || !selectedBudgetId) return;

    setLoading(true);
    const result = await generateLevyPreview(ocId, selectedBudgetId, parseInt(periodIdx));
    setLoading(false);

    if (result.error) {
      toast.error(result.error);
      return;
    }

    if (result.data) {
      setPreview(result.data);
      setPeriodStart(result.data.period_start);
      setPeriodEnd(result.data.period_end);
      setDueDate(result.data.due_date);
      setLots(result.data.lots.map((lot) => ({ ...lot, adjustments: [] })));
    }
  }

  const updateAdjustment = useCallback((lotId: string, adjIndex: number, field: "description" | "amount" | "coa_account_id", value: string | number) => {
    setLots((prev) =>
      prev.map((lot) => {
        if (lot.lot_id !== lotId) return lot;
        const newAdj = [...lot.adjustments];
        if (field === "coa_account_id") {
          // CoA pick drives BOTH the stored id AND the user-facing
          // description ("4310 , Window cleaning") so the ledger entry
          // and the levy notice describe the same line. No free text.
          // Store the CoA name only (no code). The PDF / email body must
          // never surface internal account codes to lot owners.
          const coa = coaOptions.find((c) => c.id === String(value));
          newAdj[adjIndex] = {
            ...newAdj[adjIndex],
            coa_account_id: coa?.id ?? null,
            description: coa?.name ?? "",
          };
        } else if (field === "description") {
          newAdj[adjIndex] = { ...newAdj[adjIndex], description: String(value) };
        } else {
          newAdj[adjIndex] = { ...newAdj[adjIndex], amount: Number(value) || 0 };
        }
        return { ...lot, adjustments: newAdj };
      })
    );
  }, [coaOptions]);

  const addAdjustment = useCallback((lotId: string) => {
    setLots((prev) =>
      prev.map((lot) =>
        lot.lot_id === lotId
          ? { ...lot, adjustments: [...lot.adjustments, { description: "", amount: 0, coa_account_id: null }] }
          : lot
      )
    );
  }, []);

  const removeAdjustment = useCallback((lotId: string, adjIndex: number) => {
    setLots((prev) =>
      prev.map((lot) =>
        lot.lot_id === lotId
          ? { ...lot, adjustments: lot.adjustments.filter((_, i) => i !== adjIndex) }
          : lot
      )
    );
  }, []);

  async function handleGenerate() {
    if (!preview) return;
    if (!issueDate) {
      setIssueDateInvalid(true);
      toast.error("Pick an issue date.");
      return;
    }
    setGenerating(true);

    const result = await createLevyBatch(ocId, {
      budget_id: preview.budget_id,
      financial_year: preview.financial_year,
      fund_type: preview.fund_type,
      period_label: preview.period_label,
      period_start: periodStart || preview.period_start,
      period_end: periodEnd || preview.period_end,
      due_date: dueDate || preview.due_date,
      issue_date: issueDate,
      lots: lots.map((lot) => {
        const allItems = [
          ...lot.items.map((item) => ({ ...item, is_adjustment: false })),
          ...lot.adjustments
            // Adjustments require both a CoA pick AND a non-zero amount,
            // so the ledger can post the entry against a real account.
            .filter((a) => a.coa_account_id && a.amount !== 0)
            .map((a) => ({
              description: a.description,
              amount: a.amount,
              coa_account_id: a.coa_account_id,
              budget_item_id: null,
              is_adjustment: true,
            })),
        ];
        const totalAmount = allItems.reduce((sum, item) => sum + item.amount, 0);
        return {
          lot_id: lot.lot_id,
          amount: Math.round(totalAmount * 100) / 100,
          items: allItems,
        };
      }),
    });

    if (result.error) {
      setGenerating(false);
      toast.error(result.error);
      return;
    }

    toast.success("Levies generated");
    router.push(`/ocs/${ocCode}/levies/${result.batchId}`);
  }

  const grandTotal = lots.reduce((sum, lot) => {
    const lotTotal = lot.items.reduce((s, i) => s + i.amount, 0) +
      lot.adjustments.reduce((s, a) => s + a.amount, 0);
    return sum + lotTotal;
  }, 0);

  // Step 0: the manager picks the kind of levy first. Until they do,
  // nothing else renders , keeps the page from looking busy with
  // controls they haven't committed to using yet.
  if (!levyKind) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-5 space-y-3">
            <Label>What kind of levy?</Label>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setLevyKind("regular")}
                className={cn(
                  "rounded-md border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 cursor-pointer",
                )}
              >
                <div className="text-sm font-semibold text-foreground">Regular levy</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Budget-driven contribution. Quarterly / annual issuance from an approved budget.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setLevyKind("special")}
                className={cn(
                  "rounded-md border border-border bg-card p-4 text-left transition-colors hover:border-foreground/30 cursor-pointer",
                )}
              >
                <div className="text-sm font-semibold text-foreground">Special levy</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  One-off raise outside the budget (paint job, legal action, insurance shortfall, etc).
                </p>
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (levyKind === "special") {
    return (
      <SpecialLevyForm
        ocId={ocId}
        coaOptions={coaOptions}
        availableFunds={availableFunds}
        preloadedLots={preloadedLots}
        onBack={() => setLevyKind(null)}
      />
    );
  }

  return (
    <div className={`space-y-6 ${generating ? "pointer-events-none opacity-90" : ""}`}>
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Regular levy
            </span>
            <Button variant="secondary" size="sm" onClick={() => setLevyKind(null)} disabled={generating}>
              Change levy kind
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label>Budget</Label>
            {budgets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approved budgets. Create and approve a budget first.
              </p>
            ) : (
              <Select
                value={selectedBudgetId}
                onValueChange={(v) => handleBudgetSelect(v ?? "")}
                disabled={generating}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a budget">
                    {selectedBudget ? budgetDisplayLabel(selectedBudget) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {budgets.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {budgetDisplayLabel(b)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {selectedBudgetId && (
            <div className="space-y-1.5">
              <Label>Period</Label>
              {ungenPeriods.length === 0 ? (
                <p className="text-sm text-muted-foreground">All periods have been generated for this budget.</p>
              ) : (
                <Select
                  value={selectedPeriodIndex}
                  onValueChange={(v) => handlePeriodSelect(v ?? "")}
                  disabled={generating}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a period">
                      {selectedPeriod ? periodChipLabel(selectedPeriod) : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ungenPeriods.map((p) => (
                      <SelectItem key={p.periodIndex} value={String(p.periodIndex)}>
                        {periodChipLabel(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {preview && (
            <div className="grid grid-cols-1 gap-4 pt-2 border-t border-border sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Issue date</Label>
                <DatePicker
                  value={issueDate}
                  onChange={(v) => { setIssueDate(v); setIssueDateInvalid(false); }}
                  disabled={generating}
                  invalid={issueDateInvalid}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Period start</Label>
                <DatePicker value={periodStart} onChange={setPeriodStart} disabled={generating} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Period end</Label>
                <DatePicker value={periodEnd} onChange={setPeriodEnd} disabled={generating} minDate={periodStart || undefined} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Due date</Label>
                <DatePicker value={dueDate} onChange={setDueDate} disabled={generating} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Loading spinner , no helper text. */}
      {loading && (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      )}

      {preview && lots.length > 0 && !loading && (
        <>
          <Card>
            <CardContent className="pt-5">
              <div className="mb-3">
                <Label className="block">Levy breakdown by lot</Label>
              </div>

              <div className={`overflow-hidden rounded-lg border border-border ${generating ? "pointer-events-none opacity-75" : ""}`}>
                {lots.map((lot) => (
                  <LotRow
                    key={lot.lot_id}
                    lot={lot}
                    isOpen={openLotId === lot.lot_id}
                    onToggle={() => setOpenLotId(openLotId === lot.lot_id ? null : lot.lot_id)}
                    onUpdateAdjustment={(i, f, v) => updateAdjustment(lot.lot_id, i, f, v)}
                    onAddAdjustment={() => addAdjustment(lot.lot_id)}
                    onRemoveAdjustment={(i) => removeAdjustment(lot.lot_id, i)}
                    coaOptions={coaOptions}
                    locked={generating}
                  />
                ))}
                {/* Total row , sits at the bottom of the lot list under
                    the $ column, so the breakdown reads like a column sum. */}
                <div className="flex items-center justify-between border-t-2 border-foreground/20 px-4 py-3 text-sm">
                  <span className="font-semibold text-foreground">Total</span>
                  <span className="font-bold tabular-nums text-foreground">{formatCurrency(grandTotal)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleGenerate} disabled={generating || grandTotal === 0} size="lg">
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                `Generate ${lots.length} levies`
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
