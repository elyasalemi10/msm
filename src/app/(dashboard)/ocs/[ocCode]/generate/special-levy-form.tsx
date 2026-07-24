"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { DatePicker } from "@/components/shared/date-picker";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
} from "@/components/ui/combobox";
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { createLevyBatch } from "@/lib/actions/levy";
import { isoToday } from "@/lib/utils";
import { useOCCode } from "@/lib/oc-context";

interface CoaOption {
  id: string;
  code: string;
  name: string;
}

type FundType = "operating" | "maintenance_plan";

interface PreviewLot {
  lot_id: string;
  lot_number: number;
  unit_number: string | null;
  owner_display_name: string | null;
  liability: number;
  share: number;
}

const FUND_LABEL: Record<FundType, string> = {
  operating: "Admin Fund",
  maintenance_plan: "Maintenance Plan Fund",
};

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

interface LineItem {
  coa_account_id: string | null;
  description: string;
  amount: string;
}

interface PerLotAdjustment {
  coa_account_id: string | null;
  description: string;
  amount: string;
}

// Special-levy wizard:
//   1. Manager enters purpose + period + due date + fund
//      , fund options filtered to funds the OC actually has.
//   2. Adds CoA-backed line items (combobox), each with $ amount.
//   3. Hits "Calculate apportionment" , server splits by lot liability.
//   4. Per-lot share is READ-ONLY. Manager can add EXTRA CoA-backed
//      adjustments to a lot to INCREASE that lot's total (matches
//      regular levy flow).
//   5. "Create special levy" persists the batch + redirects.
//
// Validation: every required field flips its border red on a failed
// submit attempt; field-level state clears on the next edit. Period
// end can never be before period start.
export function SpecialLevyForm({
  ocId,
  coaOptions,
  availableFunds,
  preloadedLots,
  onBack,
}: {
  ocId: string;
  coaOptions: CoaOption[];
  availableFunds: FundType[];
  /** OC lots + liability + owner name, server-pre-loaded so the
   *  "Calculate per lot levies" button runs the apportionment math
   *  client-side and renders instantly. previewSpecialLevy is no
   *  longer called from this flow. */
  preloadedLots: Array<{
    lot_id: string;
    lot_number: number;
    unit_number: string | null;
    owner_display_name: string | null;
    liability: number;
  }>;
  onBack: () => void;
}) {
  const ocCode = useOCCode();
  const router = useRouter();

  const [purpose, setPurpose] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [dueDate, setDueDate] = useState("");
  // Date printed on the notices. Defaults to today; the manager can
  // back-date or forward-date a levy they're raising after the fact.
  const [issueDate, setIssueDate] = useState(isoToday);
  // Fund defaults to the first available fund the OC actually has.
  const [fundType, setFundType] = useState<FundType>(availableFunds[0] ?? "operating");

  const [items, setItems] = useState<LineItem[]>([{ coa_account_id: null, description: "", amount: "" }]);

  const [lots, setLots] = useState<PreviewLot[] | null>(null);
  // Per-lot extra adjustments , map<lotId, list>. Each extra adds to
  // the locked apportioned share.
  const [extras, setExtras] = useState<Record<string, PerLotAdjustment[]>>({});
  // Accordion state , which lot's line-item table is open.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [creating, setCreating] = useState(false);

  // Submit-only validation flags. Each field defaults to false; flips
  // true if invalid when the user tries to advance; clears on edit.
  const [invalid, setInvalid] = useState<{
    purpose?: boolean;
    fund?: boolean;
    periodStart?: boolean;
    periodEnd?: boolean;
    dueDate?: boolean;
    issueDate?: boolean;
    items?: boolean;
  }>({});

  const totalCharge = items.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

  function addLine() {
    setItems((p) => [...p, { coa_account_id: null, description: "", amount: "" }]);
  }
  function removeLine(i: number) {
    setItems((p) => p.filter((_, idx) => idx !== i));
  }
  function updateLineCoa(i: number, accountId: string) {
    const coa = coaOptions.find((c) => c.id === accountId);
    setItems((p) =>
      p.map((row, idx) =>
        idx !== i
          ? row
          : { ...row, coa_account_id: coa?.id ?? null, description: coa?.name ?? "" },
      ),
    );
    setInvalid((v) => ({ ...v, items: false }));
  }
  function updateLineAmount(i: number, value: string) {
    setItems((p) => p.map((row, idx) => (idx === i ? { ...row, amount: value } : row)));
    setInvalid((v) => ({ ...v, items: false }));
  }

  function handleCalculate() {
    // Validate fields BEFORE firing , collect every problem so the
    // manager sees ALL red borders, not just the first.
    const problems: string[] = [];
    const next: typeof invalid = {};
    if (!purpose.trim()) { next.purpose = true; problems.push("purpose"); }
    if (!availableFunds.includes(fundType)) { next.fund = true; problems.push("fund"); }
    if (!periodStart) { next.periodStart = true; problems.push("period start"); }
    if (!periodEnd) { next.periodEnd = true; problems.push("period end"); }
    if (periodStart && periodEnd && periodEnd < periodStart) { next.periodEnd = true; problems.push("period end can't be before period start"); }
    if (!dueDate) { next.dueDate = true; problems.push("due date"); }
    if (!issueDate) { next.issueDate = true; problems.push("issue date"); }
    const incompleteItems = items.some((i) => {
      const amt = parseFloat(i.amount) || 0;
      const hasCoa = !!i.coa_account_id;
      const hasAmt = amt > 0;
      return (hasCoa && !hasAmt) || (!hasCoa && hasAmt);
    });
    if (incompleteItems) {
      next.items = true;
      problems.push("every line item needs both a CoA account and an amount");
    }
    const hasValidItem = items.some((i) => i.coa_account_id && (parseFloat(i.amount) || 0) > 0);
    if (!hasValidItem && !incompleteItems) {
      next.items = true;
      problems.push("at least one line item");
    }
    setInvalid(next);
    if (problems.length) {
      toast.error(problems.length === 1 ? `Fill in the ${problems[0]} field.` : "Fix the highlighted fields.");
      return;
    }

    // Client-side apportionment , no round-trip to previewSpecialLevy.
    // Cents-precise: each lot rounded to 2dp, residual drift assigned
    // to the lot with the largest liability so the sum ties out exactly.
    if (preloadedLots.length === 0) {
      toast.error("This OC has no lots.");
      return;
    }
    const totalLiability = preloadedLots.reduce((s, l) => s + l.liability, 0);
    const cents = Math.round(totalCharge * 100);
    let assignedCents = 0;
    const shares = preloadedLots.map((l) => {
      const portion = Math.round((l.liability / totalLiability) * cents);
      assignedCents += portion;
      return { ...l, shareCents: portion };
    });
    const drift = cents - assignedCents;
    if (drift !== 0) {
      let biggest = shares[0];
      for (const s of shares) if (s.liability > biggest.liability) biggest = s;
      biggest.shareCents += drift;
    }
    const apportioned: PreviewLot[] = shares.map((s) => ({
      lot_id: s.lot_id,
      lot_number: s.lot_number,
      unit_number: s.unit_number,
      owner_display_name: s.owner_display_name,
      liability: s.liability,
      share: s.shareCents / 100,
    }));
    setLots(apportioned);
    setExtras({});
  }

  // ── Per-lot adjustments (extras) ───────────────────────────
  function addExtra(lotId: string) {
    setExtras((p) => ({ ...p, [lotId]: [...(p[lotId] ?? []), { coa_account_id: null, description: "", amount: "" }] }));
  }
  function removeExtra(lotId: string, idx: number) {
    setExtras((p) => ({ ...p, [lotId]: (p[lotId] ?? []).filter((_, i) => i !== idx) }));
  }
  function updateExtraCoa(lotId: string, idx: number, accountId: string) {
    const coa = coaOptions.find((c) => c.id === accountId);
    setExtras((p) => ({
      ...p,
      [lotId]: (p[lotId] ?? []).map((row, i) =>
        i !== idx ? row : { ...row, coa_account_id: coa?.id ?? null, description: coa?.name ?? "" },
      ),
    }));
  }
  function updateExtraAmount(lotId: string, idx: number, v: string) {
    setExtras((p) => ({
      ...p,
      [lotId]: (p[lotId] ?? []).map((row, i) => (i !== idx ? row : { ...row, amount: v })),
    }));
  }

  function lotExtraTotal(lotId: string): number {
    return (extras[lotId] ?? []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  }
  function lotGrandTotal(l: PreviewLot): number {
    return l.share + lotExtraTotal(l.lot_id);
  }

  async function handleCreate() {
    if (!lots) return;
    // The manager can clear the issue date after apportioning, so re-check
    // it here rather than trusting the handleCalculate pass.
    if (!issueDate) {
      setInvalid((iv) => ({ ...iv, issueDate: true }));
      toast.error("Pick an issue date.");
      return;
    }
    // Block submit if any per-lot adjustment is incomplete (no CoA OR
    // a $0 amount). A zero-dollar line item is never intended , the
    // manager either didn't finish typing or forgot to pick a category.
    const badExtras: string[] = [];
    for (const [lotId, list] of Object.entries(extras)) {
      for (const [idx, e] of list.entries()) {
        const amount = parseFloat(e.amount);
        if (!e.coa_account_id) badExtras.push(`${lotId}-${idx}-coa`);
        else if (!Number.isFinite(amount) || amount <= 0) badExtras.push(`${lotId}-${idx}-amount`);
      }
    }
    if (badExtras.length > 0) {
      toast.error("Every per-lot adjustment needs a CoA account and an amount above zero.");
      return;
    }
    setCreating(true);
    const cleanItems = items.filter((i) => i.coa_account_id && (parseFloat(i.amount) || 0) > 0);

    const lotPayloads = lots.map((l) => {
      const proportion = totalCharge > 0 ? l.share / totalCharge : 0;
      const baseLines = cleanItems.map((it) => {
        const itemTotal = parseFloat(it.amount) || 0;
        const share = Math.round(itemTotal * proportion * 100) / 100;
        return {
          description: it.description,
          amount: share,
          coa_account_id: it.coa_account_id,
          budget_item_id: null,
          is_adjustment: false,
        };
      });
      const extraLines = (extras[l.lot_id] ?? [])
        .filter((e) => e.coa_account_id && (parseFloat(e.amount) || 0) > 0)
        .map((e) => ({
          description: e.description,
          amount: parseFloat(e.amount) || 0,
          coa_account_id: e.coa_account_id,
          budget_item_id: null,
          is_adjustment: true,
        }));
      const allLines = [...baseLines, ...extraLines];
      return {
        lot_id: l.lot_id,
        amount: Math.round(allLines.reduce((s, x) => s + x.amount, 0) * 100) / 100,
        items: allLines,
      };
    });

    const startYear = new Date(periodStart).getFullYear();
    const fy = `${startYear}-${startYear + 1}`;

    const res = await createLevyBatch(ocId, {
      budget_id: null,
      financial_year: fy,
      fund_type: fundType,
      period_label: `Special: ${purpose.slice(0, 40)}`,
      period_start: periodStart,
      period_end: periodEnd,
      due_date: dueDate,
      issue_date: issueDate,
      lots: lotPayloads,
      is_special: true,
      special_purpose: purpose,
    });
    if (res.error) {
      setCreating(false);
      toast.error(res.error);
      return;
    }
    toast.success("Special levy created");
    router.push(`/ocs/${ocCode}/levies/${res.batchId}`);
  }

  const fundItems = availableFunds.map((f) => ({ value: f, label: FUND_LABEL[f] }));
  // Lock every input + button once the manager fires either the
  // apportionment calc or the final create , no second click, no edit
  // mid-flight. Spinner stays on until navigation.
  const locked = creating;

  return (
    <div className={`space-y-6 ${locked ? "pointer-events-none opacity-90" : ""}`}>
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Special levy</span>
            <Button variant="secondary" size="sm" onClick={onBack} disabled={creating}>
              Change levy kind
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label>Reason / Note <span className="text-destructive">*</span></Label>
            <Textarea
              value={purpose}
              onChange={(e) => { setPurpose(e.target.value); setInvalid((v) => ({ ...v, purpose: false })); }}
              placeholder="This will appear on the levy"
              aria-invalid={invalid.purpose || undefined}
              rows={3}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Fund <span className="text-destructive">*</span></Label>
              <Combobox
                items={fundItems}
                value={fundType}
                onValueChange={(v) => { setFundType(v as FundType); setInvalid((iv) => ({ ...iv, fund: false })); }}
              >
                <ComboboxInput
                  placeholder="Pick a fund"
                  className={invalid.fund ? "border-destructive" : undefined}
                />
                <ComboboxContent>
                  <ComboboxEmpty>No funds available.</ComboboxEmpty>
                  <ComboboxList>
                    {(item: { value: string; label: string }) => (
                      <ComboboxItem key={item.value} value={item.value}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
            <div className="space-y-1.5">
              <Label>Issue date <span className="text-destructive">*</span></Label>
              <DatePicker
                value={issueDate}
                onChange={(v) => { setIssueDate(v); setInvalid((iv) => ({ ...iv, issueDate: false })); }}
                invalid={invalid.issueDate}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Due date <span className="text-destructive">*</span></Label>
              <DatePicker
                value={dueDate}
                onChange={(v) => { setDueDate(v); setInvalid((iv) => ({ ...iv, dueDate: false })); }}
                invalid={invalid.dueDate}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Period start <span className="text-destructive">*</span></Label>
              <DatePicker
                value={periodStart}
                onChange={(v) => { setPeriodStart(v); setInvalid((iv) => ({ ...iv, periodStart: false, periodEnd: false })); }}
                invalid={invalid.periodStart}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Period end <span className="text-destructive">*</span></Label>
              <DatePicker
                value={periodEnd}
                onChange={(v) => { setPeriodEnd(v); setInvalid((iv) => ({ ...iv, periodEnd: false })); }}
                invalid={invalid.periodEnd}
                minDate={periodStart || undefined}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5 space-y-3">
          <Label>Line items <span className="text-destructive">*</span></Label>
          <div className="overflow-hidden rounded-md border border-border">
            <Table variant="bordered" className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="py-1">Account</TableHead>
                  <TableHead className="py-1 w-[160px] text-right">Amount</TableHead>
                  <TableHead className="py-1 w-[36px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it, i) => (
                  <TableRow key={i}>
                    <TableCell className="py-1">
                      <Combobox
                        items={coaOptions}
                        value={it.coa_account_id ?? ""}
                        onValueChange={(v) => updateLineCoa(i, v)}
                      >
                        <ComboboxInput
                          placeholder="Select an account"
                          className={invalid.items && !it.coa_account_id ? "border-destructive" : undefined}
                        />
                        <ComboboxContent>
                          <ComboboxEmpty>No accounts found.</ComboboxEmpty>
                          <ComboboxList>
                            {(c: CoaOption) => (
                              <ComboboxItem key={c.id} value={c.id} keywords={[c.name, c.code]}>
                                {c.name}
                              </ComboboxItem>
                            )}
                          </ComboboxList>
                        </ComboboxContent>
                      </Combobox>
                    </TableCell>
                    <TableCell className="py-1">
                      <NumberInput
                        value={it.amount}
                        onChange={(v) => updateLineAmount(i, v)}
                        thousandsSeparator
                        prefix="$"
                        placeholder="Amount"
                        allowDecimal
                        invalid={invalid.items && !(parseFloat(it.amount) || 0)}
                      />
                    </TableCell>
                    <TableCell className="py-1">
                      <button
                        type="button"
                        onClick={() => removeLine(i)}
                        aria-label="Remove line"
                        className="text-muted-foreground hover:text-destructive cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
                {/* Inline "Add row" sits directly below the last data
                    row so the manager doesn't have to hunt for it in
                    the top-right of the card. */}
                <TableRow>
                  <TableCell colSpan={3} className="py-1">
                    <button
                      type="button"
                      onClick={addLine}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add row
                    </button>
                  </TableCell>
                </TableRow>
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="py-1 font-semibold">Total to raise</TableCell>
                  <TableCell className="py-1 text-right font-bold tabular-nums">{formatCurrency(totalCharge)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleCalculate} disabled={totalCharge <= 0}>
              Calculate per lot levies
            </Button>
          </div>
        </CardContent>
      </Card>

      {lots && lots.length > 0 && (
        <Card>
          <CardContent className="pt-5 space-y-3">
            <Label>Per lot levy breakdown</Label>
            {/* Accordion: header row = Lot N / Owner / total. Click
                expands a compact CoA-backed line items table , matches
                the regular levy generator's LotRow exactly. */}
            <div className="rounded-md border border-border">
              {lots.map((l) => {
                const lotExtras = extras[l.lot_id] ?? [];
                const isOpen = !!expanded[l.lot_id];
                return (
                  <div key={l.lot_id} className="border-t border-border/50 first:border-t-0">
                    <button
                      type="button"
                      onClick={() => setExpanded((p) => ({ ...p, [l.lot_id]: !p[l.lot_id] }))}
                      className="flex w-full items-center justify-between px-4 py-3 text-sm hover:bg-muted/30 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                        <div className="text-left">
                          <span className="font-medium text-foreground">
                            Lot {l.lot_number}
                            {l.unit_number ? ` (Unit ${l.unit_number})` : ""}
                          </span>
                          <span className="ml-2 text-muted-foreground">
                            {l.owner_display_name ?? "Unassigned"}
                          </span>
                        </div>
                      </div>
                      <span className="font-semibold tabular-nums text-foreground">{formatCurrency(lotGrandTotal(l))}</span>
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-2 pl-11 space-y-1.5">
                        {/* Div-grid table , same pattern as the
                            levy batch detail page so the manager has
                            one mental model across both flows. Cols:
                            description (flex), amount (110px), row
                            actions (auto). */}
                        <div className="overflow-hidden rounded-md border border-border bg-card">
                          <div className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1.5 bg-primary text-[11px] font-medium text-primary-foreground">
                            <div>Description</div>
                            <div className="text-right">Amount</div>
                            <div />
                          </div>

                          <div className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1 text-[11px] border-t border-border first:border-t-0 text-foreground">
                            <div>Apportioned share</div>
                            <div className="text-right tabular-nums">{formatCurrency(l.share)}</div>
                            <div />
                          </div>

                          {lotExtras.map((adj, ei) => (
                            <div
                              key={`adj-${ei}`}
                              className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1 text-[11px] border-t border-border items-center"
                            >
                              <Combobox
                                items={coaOptions}
                                value={adj.coa_account_id ?? ""}
                                onValueChange={(v) => updateExtraCoa(l.lot_id, ei, v)}
                              >
                                <ComboboxInput
                                  placeholder="Pick a CoA account"
                                  className="h-7 text-[11px]"
                                />
                                <ComboboxContent>
                                  <ComboboxEmpty>No accounts found.</ComboboxEmpty>
                                  <ComboboxList>
                                    {(c: CoaOption) => (
                                      <ComboboxItem key={c.id} value={c.id} keywords={[c.name, c.code]}>{c.name}</ComboboxItem>
                                    )}
                                  </ComboboxList>
                                </ComboboxContent>
                              </Combobox>
                              <NumberInput
                                value={adj.amount}
                                onChange={(v) => updateExtraAmount(l.lot_id, ei, v)}
                                thousandsSeparator
                                prefix="$"
                                placeholder="Amount"
                                allowDecimal
                                invalid={
                                  adj.amount !== "" &&
                                  (!Number.isFinite(parseFloat(adj.amount)) || parseFloat(adj.amount) <= 0)
                                }
                              />
                              <button
                                type="button"
                                onClick={() => removeExtra(l.lot_id, ei)}
                                aria-label="Remove adjustment"
                                className="text-muted-foreground hover:text-destructive cursor-pointer justify-self-center"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ))}

                          <div className="grid grid-cols-[1fr_110px_28px] gap-x-4 px-3 py-1 text-[11px] border-t border-border font-semibold">
                            <div>Total</div>
                            <div className="text-right tabular-nums">{formatCurrency(lotGrandTotal(l))}</div>
                            <div />
                          </div>
                        </div>

                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => addExtra(l.lot_id)}
                          className="mt-2"
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add adjustment
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end">
              <Button onClick={handleCreate} disabled={creating} size="lg">
                {creating && <Loader2 className="mr-2 size-4 animate-spin" />}
                Create special levy
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
