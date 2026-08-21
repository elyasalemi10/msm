"use client";

import { useState, useEffect, useTransition } from "react";
import { Pencil, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
} from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { updateOCField } from "../manage/actions";
import {
  upsertLevyAutosendSchedule,
  updateAutosendOverrides,
  deleteLevyAutosendSchedule,
  getBudgetPlannedPeriods,
  type LevyAutosendSchedule,
  type PreviewPeriod,
} from "@/lib/actions/levy-autosend";
import { ordinalRunLabel } from "@/lib/levy-autosend-helpers";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Table as ListTable, TableBody as ListTBody, TableCell as ListTd, TableHead as ListTh, TableHeader as ListTHead, TableRow as ListTr,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus as PlusIcon } from "lucide-react";
import { DatePicker } from "@/components/shared/date-picker";
import { OCFollowupCard } from "./oc-followup-card";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface OCData {
  id: string;
  name: string;
  address: string;
  plan_number: string;
  status: string;
  oc_tier: number | null;
  total_lots: number;
  common_property_description: string | null;
  rules_type: string;
  financial_year_start_month: number;
  billing_cycle: string;
  is_developer_period: boolean;
  abn?: string | null;
  tfn?: string | null;
  common_seal_text?: string | null;
  inspection_address?: string | null;
  // Wizard-redesign additions.
  annual_interest_rate_percent?: number | null;
  interest_free_period_days?: number | null;
  early_payment_incentive_percent?: number | null;
  arrears_action_threshold_cents?: number | null;
  levy_calculation_basis?: string | null;
  default_delivery_method?: string | null;
  meetings_postal_buffer_days?: number | null;
  levies_postal_buffer_days?: number | null;
  financial_postal_buffer_days?: number | null;
  /** When true, levy notice PDFs include an "arrears as of {bank import
   *  date}" line. Default false , managers opt in. */
  include_arrears_on_notice?: boolean | null;
  /** Per-OC auto multi-lot note. When on, owners with 2+ lots get an
   *  automatic note on each levy notice. */
  multilot_note_enabled?: boolean | null;
  multilot_note_text?: string | null;
  /** Banking , trust account details printed on EFT instructions. */
  bank_bsb?: string | null;
  bank_account_number?: string | null;
  bank_account_name?: string | null;
}

// ─── Read-only key/value row ────────────────────────────────
// Used for every line on every settings card. All edits happen
// via SettingsEditDrawer (one per card), not inline.
function ReadonlyField({
  label, value, options,
}: {
  label: string;
  value: string | number | boolean | null | undefined;
  options?: { value: string; label: string }[];
}) {
  let display: React.ReactNode = "";
  if (value !== null && value !== undefined && value !== "") {
    if (options) {
      display = options.find((o) => String(o.value) === String(value))?.label ?? String(value);
    } else if (typeof value === "boolean") {
      display = value ? "Yes" : "No";
    } else {
      display = String(value);
    }
  }
  return (
    <div className="flex justify-between items-start py-2.5 border-b border-border/50 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground text-right max-w-[60%]">{display}</span>
    </div>
  );
}

// ─── Per-card edit drawer ───────────────────────────────────
// Opens a side sheet with a form for every field on a card.
// Save writes each changed field through updateOCField and then
// closes the drawer. Cancel discards the in-flight edits without
// touching server state.
type FieldType = "text" | "textarea" | "number" | "select" | "boolean";
type FieldConfig = {
  key: string;
  label: string;
  type: FieldType;
  value: string | number | boolean | null | undefined;
  options?: { value: string; label: string }[];
};

function SettingsEditDrawer({
  open, onClose, title, fields, ocId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: FieldConfig[];
  ocId: string;
  onSaved: (next: Record<string, string | boolean>) => void;
}) {
  // Stable string representation of each field's value. Booleans
  // go through "yes" / "no" so they map cleanly onto the same
  // Select primitive as other enum-style fields.
  const initial = useState(() =>
    Object.fromEntries(
      fields.map((f) => {
        if (f.type === "boolean") return [f.key, f.value ? "yes" : "no"];
        return [f.key, f.value == null ? "" : String(f.value)];
      }),
    ) as Record<string, string>,
  )[0];
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);

  // Whenever the drawer re-opens for the same card, snapshot the
  // latest server values so cancel-then-reopen doesn't show stale
  // edits.
  useEffect(() => {
    if (open) {
      setValues(
        Object.fromEntries(
          fields.map((f) => {
            if (f.type === "boolean") return [f.key, f.value ? "yes" : "no"];
            return [f.key, f.value == null ? "" : String(f.value)];
          }),
        ) as Record<string, string>,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    setSaving(true);
    const next: Record<string, string | boolean> = {};
    for (const f of fields) {
      const current = values[f.key];
      const original = f.type === "boolean"
        ? (f.value ? "yes" : "no")
        : (f.value == null ? "" : String(f.value));
      if (current === original) continue;
      const payload: string | boolean | null = f.type === "boolean"
        ? current === "yes"
        : current;
      const res = await updateOCField(ocId, f.key, payload === "" ? null : payload);
      if (res.error) {
        setSaving(false);
        toast.error(res.error);
        return;
      }
      next[f.key] = payload === "" ? "" : payload;
    }
    setSaving(false);
    onSaved(next);
    toast.success(`${title} saved`);
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="sr-only">Edit {title}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {fields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label>{f.label}</Label>
              {f.type === "text" && (
                <Input
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                />
              )}
              {f.type === "textarea" && (
                <Textarea
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.key]: e.target.value }))}
                  rows={4}
                />
              )}
              {f.type === "number" && (
                <NumberInput
                  value={values[f.key] ?? ""}
                  onChange={(v) => setValues((p) => ({ ...p, [f.key]: v }))}
                  allowDecimal
                />
              )}
              {(f.type === "select" || f.type === "boolean") && (
                <Select
                  value={values[f.key] ?? ""}
                  onValueChange={(v) => setValues((p) => ({ ...p, [f.key]: v ?? "" }))}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {(f.type === "boolean"
                        ? (values[f.key] === "yes" ? "Yes" : "No")
                        : (f.options?.find((o) => o.value === values[f.key])?.label ?? values[f.key])) || ""}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(f.type === "boolean"
                      ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
                      : (f.options ?? [])
                    ).map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-border p-4 flex justify-end gap-2">
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// "2026-08-01" -> "first of August 2026" , reads more like prose
// than ISO. Used in the auto-send "Next run will be on the X" line.
function formatNiceDate(iso: string): string {
  if (!iso) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ord = (n: number) => {
    if (n >= 11 && n <= 13) return `${n}th`;
    const last = n % 10;
    if (last === 1) return `${n}st`;
    if (last === 2) return `${n}nd`;
    if (last === 3) return `${n}rd`;
    return `${n}th`;
  };
  return `${ord(d)} of ${months[m - 1]} ${y}`;
}

// Per-card editor header. Renders the section title + an Edit
// button that opens a side drawer with the form for this card.
function CardEditHeader({
  title, onEdit,
}: {
  title: string;
  onEdit: () => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <Button variant="secondary" size="sm" onClick={onEdit}>
        <Pencil className="mr-1.5 h-3.5 w-3.5" />
        Edit
      </Button>
    </div>
  );
}

type SettingsTabKey = "general" | "financial" | "communications" | "banking" | "automation";

const TABS: Array<{ key: SettingsTabKey; label: string }> = [
  { key: "general", label: "General" },
  { key: "financial", label: "Financial" },
  { key: "communications", label: "Communications" },
  { key: "banking", label: "Banking" },
  { key: "automation", label: "Automation" },
];

export function SettingsContent({
  oc: initial,
  autosend,
  autosendMailboxOptions,
  autosendBudgets,
  autosendPreloadedPeriods,
}: {
  oc: OCData;
  autosend: LevyAutosendSchedule;
  autosendMailboxOptions: Array<{ value: string; label: string }>;
  autosendBudgets: Array<{ id: string; label: string }>;
  autosendPreloadedPeriods?: Record<string, PreviewPeriod[]>;
}) {
  const [oc, setOC] = useState(initial);
  // Per-card drawer state. Each card has its own key, exactly one
  // drawer open at a time. null = nothing open.
  const [openDrawer, setOpenDrawer] = useState<
    | null
    | "general"
    | "certificate"
    | "commonProperty"
    | "financial"
    | "commsDelivery"
    | "commsNotice"
    | "banking"
  >(null);

  function applyDrawerSave(next: Record<string, string | boolean>) {
    setOC((prev) => ({ ...prev, ...next } as OCData));
  }

  const fyMonth = MONTHS[(oc.financial_year_start_month ?? 7) - 1] ?? "July";
  const monthOptions = MONTHS.map((m, i) => ({ value: String(i + 1), label: m }));
  const billingOptions = [
    { value: "monthly", label: "Monthly" },
    { value: "quarterly", label: "Quarterly" },
    { value: "half_yearly", label: "Half-yearly" },
    { value: "annually", label: "Annually" },
  ];
  const rulesOptions = [
    { value: "model", label: "Model rules" },
    { value: "custom", label: "Custom rules" },
  ];
  const levyBasisOptions = [
    { value: "lot_liability", label: "Lot liability (standard)" },
    { value: "equal_per_lot", label: "Equal per lot" },
    { value: "custom_apportionment", label: "Custom apportionment" },
  ];
  const deliveryOptions = [
    { value: "postal", label: "Postal only" },
    { value: "mixed", label: "Mixed" },
    { value: "email", label: "Email by default" },
  ];

  // URL-synced tab state. ?tab=automation deep-links directly to the
  // auto-send card without the manager having to scroll.
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(() => {
    if (typeof window === "undefined") return "general";
    const fromUrl = new URLSearchParams(window.location.search).get("tab");
    if (TABS.some((t) => t.key === fromUrl)) return fromUrl as SettingsTabKey;
    return "general";
  });

  function switchTab(next: SettingsTabKey) {
    setActiveTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url.toString());
    }
  }

  return (
    <div className="space-y-6">
      {/* Top row: tabs on the left, edit toggle on the right. */}
      <div className="flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => switchTab(t.key)}
              className={cn(
                "h-9 border-b-2 px-3 text-sm font-medium transition-colors cursor-pointer",
                activeTab === t.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* No global Edit button anymore. Each card carries its own
            Edit/Done toggle in its header so the manager only flips
            the section they're tweaking. */}
      </div>

      {activeTab === "general" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-5">
              <CardEditHeader title="General details" onEdit={() => setOpenDrawer("general")} />
              <ReadonlyField label="Name" value={oc.name} />
              <ReadonlyField label="Plan number" value={oc.plan_number} />
              <ReadonlyField label="Address" value={oc.address} />
              <ReadonlyField label="ABN" value={oc.abn} />
              <ReadonlyField label="TFN" value={oc.tfn} />
              <ReadonlyField label="OC Tier" value={oc.oc_tier ? `Tier ${oc.oc_tier}` : null} />
              <ReadonlyField label="Total lots" value={oc.total_lots} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <CardEditHeader title="Certificate settings" onEdit={() => setOpenDrawer("certificate")} />
              <ReadonlyField label="Common seal text" value={oc.common_seal_text} />
              <ReadonlyField label="Inspection address" value={oc.inspection_address} />
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardContent className="pt-5">
              <CardEditHeader title="Common property description" onEdit={() => setOpenDrawer("commonProperty")} />
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {oc.common_property_description || ""}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "financial" && (
        <Card>
          <CardContent className="pt-5">
            <CardEditHeader title="Financial settings" onEdit={() => setOpenDrawer("financial")} />
            <ReadonlyField label="Financial year starts" value={fyMonth} />
            <ReadonlyField label="Billing cycle" value={oc.billing_cycle} options={billingOptions} />
            <ReadonlyField label="Rules type" value={oc.rules_type} options={rulesOptions} />
            <ReadonlyField label="Levy calculation basis" value={oc.levy_calculation_basis ?? "lot_liability"} options={levyBasisOptions} />
            <ReadonlyField label="Early payment incentive (%)" value={oc.early_payment_incentive_percent ?? 0} />
            <ReadonlyField label="Annual interest rate (%)" value={oc.annual_interest_rate_percent ?? 0} />
            <ReadonlyField label="Interest-free period (days)" value={oc.interest_free_period_days ?? 28} />
            <ReadonlyField label="Arrears action threshold (cents)" value={oc.arrears_action_threshold_cents ?? 5000} />
            <ReadonlyField label="Include arrears on levy notices" value={!!oc.include_arrears_on_notice} />
          </CardContent>
        </Card>
      )}

      {activeTab === "communications" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-5">
              <CardEditHeader title="Delivery" onEdit={() => setOpenDrawer("commsDelivery")} />
              <ReadonlyField label="Default delivery method" value={oc.default_delivery_method ?? "postal"} options={deliveryOptions} />
              <ReadonlyField label="Meetings postal buffer (days)" value={oc.meetings_postal_buffer_days ?? 14} />
              <ReadonlyField label="Levies postal buffer (days)" value={oc.levies_postal_buffer_days ?? 14} />
              <ReadonlyField label="Financial documents postal buffer (days)" value={oc.financial_postal_buffer_days ?? 14} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <CardEditHeader title="Levy notice content" onEdit={() => setOpenDrawer("commsNotice")} />
              <ReadonlyField label="Add note for multi-lot owners" value={!!oc.multilot_note_enabled} />
              {oc.multilot_note_enabled && (
                <ReadonlyField label="Multi-lot note text" value={oc.multilot_note_text} />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "banking" && (
        <Card>
          <CardContent className="pt-5">
            <CardEditHeader title="Trust account details" onEdit={() => setOpenDrawer("banking")} />
            <ReadonlyField label="Account name" value={oc.bank_account_name} />
            <ReadonlyField label="BSB" value={oc.bank_bsb} />
            <ReadonlyField label="Account number" value={oc.bank_account_number} />
          </CardContent>
        </Card>
      )}

      {/* One drawer per card. Mounted at the page root so each
          drawer renders its own form when opened. */}
      <SettingsEditDrawer
        open={openDrawer === "general"}
        onClose={() => setOpenDrawer(null)}
        title="General details"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "name", label: "Name", type: "text", value: oc.name },
          { key: "plan_number", label: "Plan number", type: "text", value: oc.plan_number },
          { key: "address", label: "Address", type: "text", value: oc.address },
          { key: "abn", label: "ABN", type: "text", value: oc.abn },
          { key: "tfn", label: "TFN", type: "text", value: oc.tfn },
        ]}
      />
      <SettingsEditDrawer
        open={openDrawer === "certificate"}
        onClose={() => setOpenDrawer(null)}
        title="Certificate settings"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "common_seal_text", label: "Common seal text", type: "textarea", value: oc.common_seal_text },
          { key: "inspection_address", label: "Inspection address", type: "text", value: oc.inspection_address },
        ]}
      />
      <SettingsEditDrawer
        open={openDrawer === "commonProperty"}
        onClose={() => setOpenDrawer(null)}
        title="Common property description"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "common_property_description", label: "Common property description", type: "textarea", value: oc.common_property_description },
        ]}
      />
      <SettingsEditDrawer
        open={openDrawer === "financial"}
        onClose={() => setOpenDrawer(null)}
        title="Financial settings"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "financial_year_start_month", label: "Financial year starts", type: "select", value: String(oc.financial_year_start_month), options: monthOptions },
          { key: "billing_cycle", label: "Billing cycle", type: "select", value: oc.billing_cycle, options: billingOptions },
          { key: "rules_type", label: "Rules type", type: "select", value: oc.rules_type, options: rulesOptions },
          { key: "levy_calculation_basis", label: "Levy calculation basis", type: "select", value: oc.levy_calculation_basis ?? "lot_liability", options: levyBasisOptions },
          { key: "early_payment_incentive_percent", label: "Early payment incentive (%)", type: "number", value: oc.early_payment_incentive_percent ?? 0 },
          { key: "annual_interest_rate_percent", label: "Annual interest rate (%)", type: "number", value: oc.annual_interest_rate_percent ?? 0 },
          { key: "interest_free_period_days", label: "Interest-free period (days)", type: "number", value: oc.interest_free_period_days ?? 28 },
          { key: "arrears_action_threshold_cents", label: "Arrears action threshold (cents)", type: "number", value: oc.arrears_action_threshold_cents ?? 5000 },
          { key: "include_arrears_on_notice", label: "Include arrears on levy notices", type: "boolean", value: !!oc.include_arrears_on_notice },
        ]}
      />
      <SettingsEditDrawer
        open={openDrawer === "commsDelivery"}
        onClose={() => setOpenDrawer(null)}
        title="Delivery"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "default_delivery_method", label: "Default delivery method", type: "select", value: oc.default_delivery_method ?? "postal", options: deliveryOptions },
          { key: "meetings_postal_buffer_days", label: "Meetings postal buffer (days)", type: "number", value: oc.meetings_postal_buffer_days ?? 14 },
          { key: "levies_postal_buffer_days", label: "Levies postal buffer (days)", type: "number", value: oc.levies_postal_buffer_days ?? 14 },
          { key: "financial_postal_buffer_days", label: "Financial documents postal buffer (days)", type: "number", value: oc.financial_postal_buffer_days ?? 14 },
        ]}
      />
      <SettingsEditDrawer
        open={openDrawer === "commsNotice"}
        onClose={() => setOpenDrawer(null)}
        title="Levy notice content"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "multilot_note_enabled", label: "Add note for multi-lot owners", type: "boolean", value: !!oc.multilot_note_enabled },
          { key: "multilot_note_text", label: "Multi-lot note text", type: "textarea", value: oc.multilot_note_text },
        ]}
      />
      <SettingsEditDrawer
        open={openDrawer === "banking"}
        onClose={() => setOpenDrawer(null)}
        title="Trust account details"
        ocId={oc.id}
        onSaved={applyDrawerSave}
        fields={[
          { key: "bank_account_name", label: "Account name", type: "text", value: oc.bank_account_name },
          { key: "bank_bsb", label: "BSB", type: "text", value: oc.bank_bsb },
          { key: "bank_account_number", label: "Account number", type: "text", value: oc.bank_account_number },
        ]}
      />

      {activeTab === "automation" && (
        <AutomationsTab
          ocId={oc.id}
          billingCycle={oc.billing_cycle}
          fyStartMonth={oc.financial_year_start_month}
          autosend={autosend}
          mailboxOptions={autosendMailboxOptions}
          budgets={autosendBudgets}
          preloadedPeriods={autosendPreloadedPeriods ?? {}}
        />
      )}
    </div>
  );
}

// ─── Auto-send levies card ──────────────────────────────────
// Lives on the Automation tab. Reads/writes
// levy_autosend_schedules. Manager toggles enabled, picks a budget,
// chooses a day of month, picks a mailbox. The daily cron fires the
// generation + send on next_send_date and advances the date by the
// OC's billing cycle (monthly / quarterly / half-yearly / annually).
// ─── Automation tab , table of automations + add-side-drawer ───────
// Today there's exactly one kind of automation (auto-send levies).
// Adding more later just means inserting another row + a different
// drawer variant. Empty state renders the table with no rows + an
// "Add automation" button.
function AutomationsTab({
  ocId,
  billingCycle,
  fyStartMonth,
  autosend,
  mailboxOptions,
  budgets,
  preloadedPeriods,
}: {
  ocId: string;
  billingCycle: string;
  fyStartMonth: number;
  autosend: LevyAutosendSchedule;
  mailboxOptions: Array<{ value: string; label: string }>;
  budgets: Array<{ id: string; label: string }>;
  preloadedPeriods: Record<string, PreviewPeriod[]>;
}) {
  // Drawer state. "edit" carries the row being edited (or "new" for
  // the Add Automation flow). null = closed.
  const [drawerMode, setDrawerMode] = useState<null | "edit-autosend" | "new">(null);

  // Today the rows array is just the auto-send row (if it exists).
  // When more automation types ship, push them here.
  const rows: Array<{
    key: string;
    type: string;
    nextRun: string | null;
    lastRun: string | null;
    status: "on" | "off" | "error";
    raw?: LevyAutosendSchedule;
  }> = [];
  if (autosend.id || autosend.enabled) {
    rows.push({
      key: autosend.id ?? "autosend",
      type: "Auto-send levies",
      nextRun: autosend.next_send_date,
      lastRun: autosend.last_sent_on,
      status: autosend.last_error ? "error" : autosend.enabled ? "on" : "off",
      raw: autosend,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {/* Add automation is always visible. Today there's one
            schedule per OC; clicking "Add" when a schedule already
            exists opens the same drawer pre-loaded with the existing
            row , equivalent to clicking the row. When more automation
            types ship, this turns into a multi-option menu. */}
        <Button
          size="sm"
          onClick={() => setDrawerMode(rows.length > 0 ? "edit-autosend" : "new")}
        >
          <PlusIcon className="mr-1.5 h-3.5 w-3.5" />
          Add automation
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <ListTable variant="striped">
          <ListTHead>
            <ListTr>
              <ListTh>Type</ListTh>
              <ListTh>Next run</ListTh>
              <ListTh>Last run</ListTh>
              <ListTh>Status</ListTh>
            </ListTr>
          </ListTHead>
          <ListTBody>
            {rows.length === 0 ? (
              <ListTr>
                <ListTd colSpan={4} className="text-center py-10 text-sm text-muted-foreground">
                  No automations yet. Click &quot;Add automation&quot; to get started.
                </ListTd>
              </ListTr>
            ) : (
              rows.map((r) => (
                <ListTr key={r.key} className="cursor-pointer" onClick={() => setDrawerMode("edit-autosend")}>
                  <ListTd className="text-foreground">{r.type}</ListTd>
                  <ListTd className="text-foreground text-sm">{r.nextRun ?? ""}</ListTd>
                  <ListTd className="text-foreground text-sm">{r.lastRun ?? ""}</ListTd>
                  <ListTd>
                    <Badge
                      variant={
                        r.status === "on" ? "success"
                        : r.status === "error" ? "destructive"
                        : "neutral"
                      }
                    >
                      {r.status === "on" ? "On" : r.status === "error" ? "Error" : "Off"}
                    </Badge>
                  </ListTd>
                </ListTr>
              ))
            )}
          </ListTBody>
        </ListTable>
      </div>

      {/* Per-OC levy follow-up: inherits the company default unless overridden. */}
      <OCFollowupCard ocId={ocId} />

      {/* Side drawer , holds the auto-send config (today the only
          automation). For Add-Automation we surface the same form
          since auto-send is the only option, plus a placeholder
          message saying more types are coming. */}
      <Sheet open={drawerMode !== null} onOpenChange={(o) => { if (!o) setDrawerMode(null); }}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              {drawerMode === "new" ? "Add automation" : "Auto-send levies"}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Configure how this automation runs.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            <AutoSendCard
              ocId={ocId}
              billingCycle={billingCycle}
              fyStartMonth={fyStartMonth}
              // For "new" we hand the drawer a blank schedule so the
              // Delete-automation button stays hidden (there's nothing
              // to delete yet) and no fields are pre-populated from a
              // stray pre-existing row.
              initial={drawerMode === "new"
                ? { id: null, oc_id: ocId, enabled: false, budget_id: null, send_day_of_month: 1, from_address: null, last_sent_on: null, next_send_date: null, last_error: null, date_overrides: {}, planned_periods: [] }
                : autosend}
              mailboxOptions={mailboxOptions}
              budgets={budgets}
              preloadedPeriods={preloadedPeriods}
              embedded
              onClose={() => setDrawerMode(null)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AutoSendCard({
  ocId,
  billingCycle,
  fyStartMonth,
  initial,
  mailboxOptions,
  budgets,
  preloadedPeriods,
  embedded = false,
  onClose,
}: {
  ocId: string;
  billingCycle: string;
  fyStartMonth: number;
  initial: LevyAutosendSchedule;
  mailboxOptions: Array<{ value: string; label: string }>;
  budgets: Array<{ id: string; label: string }>;
  /** Server-pre-loaded period maps so the schedule step renders
   *  without a network round-trip when the cache hits. */
  preloadedPeriods?: Record<string, PreviewPeriod[]>;
  /** When true, render the form's contents directly , no surrounding
   *  Card or duplicate header , so it sits cleanly inside the
   *  Automations side drawer. */
  embedded?: boolean;
  /** Drawer close handler. Called after a successful save so the
   *  parent can dismiss the sheet. */
  onClose?: () => void;
}) {
  // Day-of-month input holds a STRING so the manager can clear the
  // field while typing without us forcing 1 back in. The "Last day of
  // month" toggle short-circuits the number; when on we save 31 which
  // the cron clamps to the actual last day per month.
  // Active toggle removed , an automation either exists (saved row =
  // enabled) or it's deleted. draft.enabled is hardcoded true at save
  // time so the cron picks it up. To turn it OFF the manager hits
  // "Delete automation".
  // Mailbox default: prefer the connected Gmail mailbox over
  // the StrataWise alias when both are present. mailboxOptions is
  // already ordered "connected first" by the server, so [0] is the
  // right default for new schedules.
  const [draft, setDraft] = useState({
    budget_id: initial.budget_id ?? "",
    send_day_of_month: String(initial.send_day_of_month === 31 ? "" : initial.send_day_of_month),
    last_day_of_month: initial.send_day_of_month === 31,
    from_address: initial.from_address ?? mailboxOptions[0]?.value ?? "",
  });
  const [dayInvalid, setDayInvalid] = useState(false);
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(initial.last_sent_on);
  const [nextDate, setNextDate] = useState<string | null>(initial.next_send_date);

  const [overrides, setOverrides] = useState<Record<string, string>>(initial.date_overrides ?? {});

  const cycleLabel: Record<string, string> = {
    monthly: "Monthly",
    quarterly: "Every 3 months",
    half_yearly: "Every 6 months",
    annually: "Yearly",
  };

  /** Validate the form values. Returns the resolved day-of-month (1..31)
   *  on success, or null when invalid , in which case dayInvalid is set
   *  and a toast is shown. */
  function validateForm(): number | null {
    let resolvedDay: number | null = null;
    if (draft.last_day_of_month) {
      resolvedDay = 31;
    } else {
      const parsed = parseInt(draft.send_day_of_month, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 28) {
        resolvedDay = parsed;
      }
    }
    if (resolvedDay === null) {
      setDayInvalid(true);
      toast.error("Pick a day between 1 and 28, or turn on 'Last day of month'.");
      return null;
    }
    setDayInvalid(false);
    return resolvedDay;
  }

  function save() {
    const resolvedDay = validateForm();
    if (resolvedDay === null) return;

    startTransition(async () => {
      const res = await upsertLevyAutosendSchedule(ocId, {
        enabled: true,
        budget_id: draft.budget_id || null,
        send_day_of_month: resolvedDay,
        from_address: draft.from_address || null,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      if (Object.keys(overrides).length > 0) {
        const ovRes = await updateAutosendOverrides(ocId, overrides);
        if (ovRes.error) {
          toast.error(ovRes.error);
          return;
        }
      }
      toast.success("Automation saved");
      setSavedAt(res.schedule?.last_sent_on ?? null);
      setNextDate(res.schedule?.next_send_date ?? null);
      onClose?.();
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const res = await deleteLevyAutosendSchedule(ocId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Automation deleted");
      onClose?.();
    });
  }

  // Schedule preview reads the resolved day (1..28 or 31 for "last day").
  // Falls back to 1 while the manager is mid-edit so the popup always
  // has something to render without crashing.
  const previewDay = draft.last_day_of_month
    ? 31
    : (parseInt(draft.send_day_of_month, 10) || 1);

  // Server-resolved budget periods: walks the full FY period set for
  // the selected budget, marking ones that already have a batch as
  // done. Refreshed whenever the budget OR the send day changes (the
  // day clamps differently per month so the planned date shifts).
  // `periodsLoading` drives a shimmer skeleton on the schedule step so
  // the manager never sees "no periods" before the fetch resolves.
  const [budgetPeriods, setBudgetPeriods] = useState<PreviewPeriod[]>(() => {
    if (initial.budget_id && preloadedPeriods?.[initial.budget_id]) {
      return preloadedPeriods[initial.budget_id];
    }
    return [];
  });
  const [doneCount, setDoneCount] = useState<number>(() => {
    if (initial.budget_id && preloadedPeriods?.[initial.budget_id]) {
      return preloadedPeriods[initial.budget_id].filter((p) => p.done).length;
    }
    return 0;
  });
  const [periodsLoading, setPeriodsLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!draft.budget_id) {
      setBudgetPeriods([]);
      setDoneCount(0);
      setPeriodsLoading(false);
      return;
    }
    // Cache hit: paint instantly. Schedule a silent refresh in case
    // the cached send-day differs from the manager's current draft.
    const cached = preloadedPeriods?.[draft.budget_id];
    if (cached) {
      setBudgetPeriods(cached);
      setDoneCount(cached.filter((p) => p.done).length);
      setPeriodsLoading(false);
    } else {
      setPeriodsLoading(true);
    }
    getBudgetPlannedPeriods(ocId, draft.budget_id, previewDay).then((res) => {
      if (cancelled) return;
      setBudgetPeriods(res.periods);
      setDoneCount(res.doneCount);
      setPeriodsLoading(false);
    });
    return () => { cancelled = true; };
  }, [draft.budget_id, ocId, previewDay, preloadedPeriods]);

  // Only the pending periods need a date picker , done ones are
  // skipped by the cron, no point showing them.
  const planned = budgetPeriods
    .filter((p) => !p.done)
    .map((p) => ({
      monthKey: p.monthKey,
      defaultDate: p.plannedDate,
      effectiveDate: overrides[p.monthKey] ?? p.plannedDate,
      isOverridden: overrides[p.monthKey] && overrides[p.monthKey] !== p.plannedDate ? true : false,
    }));
  // suppress unused-var noise from removed-but-imported FY helpers
  void fyStartMonth;

  // ── Two-step flow when embedded ─────────────────────────────
  // Step "form": all the inputs + Next button.
  // Step "schedule": planned-runs preview + Confirm/Back buttons.
  // Outside the drawer (standalone card) we skip the multi-step UX
  // and use the old single-page form.
  // For EXISTING automations the schedule sits inline on the same
  // page as the form , no Next button, no second step. For NEW
  // automations we still use the two-step flow so the manager
  // confirms the schedule before saving.
  const isExisting = !!initial.id;
  const [embeddedStep, setEmbeddedStep] = useState<"form" | "schedule">(
    isExisting ? "schedule" : "form",
  );
  // When editing, render BOTH sections at once. We reuse the
  // "schedule" branch's rendering by treating the form as always-on
  // and showing schedule inline below it.
  const showFormSection = embeddedStep === "form" || isExisting;
  const showScheduleSection = embeddedStep === "schedule" || isExisting;

  // Body of the card. Single vertical column so it fits the narrow
  // drawer without anything being cramped.
  const body = (
    <div className={embedded ? "space-y-4" : ""}>
      {showFormSection && (
        <>
          {/* Budget picker , LOCKED on existing automations. Changing
              the budget mid-flight would invalidate the planned
              periods + cron history, so we only allow it at creation
              time. Same applies to day-of-month: the schedule is
              already in flight against this day. Manager who wants to
              switch budgets deletes + recreates. */}
          <div className="space-y-1.5">
            <Label>Budget</Label>
            {isExisting ? (
              <div className="h-9 rounded-md border border-border bg-cool-muted px-3 flex items-center text-sm text-cool-muted-foreground">
                {budgets.find((b) => b.id === draft.budget_id)?.label ?? "(none)"}
              </div>
            ) : (
              <Combobox
                items={budgets}
                value={draft.budget_id}
                onValueChange={(v) => setDraft((p) => ({ ...p, budget_id: v ?? "" }))}
              >
                <ComboboxInput placeholder="Pick a budget" />
                <ComboboxContent>
                  <ComboboxEmpty>No approved budgets.</ComboboxEmpty>
                  <ComboboxList>
                    {(b: { id: string; label: string }) => (
                      <ComboboxItem key={b.id} value={b.id} keywords={[b.label]}>
                        {b.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Send mailbox</Label>
            <Select
              value={draft.from_address}
              onValueChange={(v) => setDraft((p) => ({ ...p, from_address: v ?? "" }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a mailbox">
                  {mailboxOptions.find((o) => o.value === draft.from_address)?.label ?? null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {mailboxOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Day of month</Label>
            {isExisting ? (
              <div className="h-9 rounded-md border border-border bg-cool-muted px-3 flex items-center text-sm text-cool-muted-foreground">
                {draft.last_day_of_month ? "Last day of month" : draft.send_day_of_month || "(none)"}
              </div>
            ) : (
              <>
                <NumberInput
                  value={draft.send_day_of_month}
                  onChange={(v) => {
                    setDraft((p) => ({ ...p, send_day_of_month: v, last_day_of_month: false }));
                    setDayInvalid(false);
                  }}
                  allowDecimal={false}
                  disabled={draft.last_day_of_month}
                  invalid={dayInvalid}
                  placeholder="1-28"
                />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={draft.last_day_of_month}
                    onCheckedChange={(v) => {
                      const checked = v === true;
                      setDraft((p) => ({ ...p, last_day_of_month: checked, send_day_of_month: checked ? "" : p.send_day_of_month }));
                      setDayInvalid(false);
                }}
              />
                  <span>Last day of month</span>
                </div>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Cadence</Label>
            <div className="h-10 rounded-md border border-border bg-cool-muted px-3 flex items-center text-sm text-cool-muted-foreground">
              {cycleLabel[billingCycle] ?? billingCycle}
            </div>
          </div>
        </>
      )}

      {showScheduleSection && (
        <div className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
          {periodsLoading ? (
            // Skeleton shimmer , 3 stacked rows that look like the
            // real First/Second/Third run blocks. No reflow when the
            // server resolves.
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
          ) : planned.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
              Every period for this budget has already been generated. Pick a different budget, or delete the automation.
            </div>
          ) : (
            <>
              {doneCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {doneCount} period{doneCount === 1 ? "" : "s"} already generated for this budget , skipped. The dates below cover what&apos;s left.
                </p>
              )}
              {planned.map((p, idx) => {
                const [yy, mm] = p.monthKey.split("-");
                const firstOfMonth = `${p.monthKey}-01`;
                const lastDay = new Date(Date.UTC(Number(yy), Number(mm), 0)).getUTCDate();
                const lastOfMonth = `${p.monthKey}-${lastDay.toString().padStart(2, "0")}`;
                // A quarter is "in the past" when its month-end is
                // before today's date. The cron either fired it
                // already or skipped it; either way changing the
                // date now would be a no-op, so disable.
                const periodEndMs = new Date(`${lastOfMonth}T23:59:59Z`).getTime();
                const isPast = periodEndMs < Date.now();
                return (
                  <div key={p.monthKey} className="space-y-1.5">
                    <Label className={isPast ? "text-muted-foreground" : undefined}>
                      {ordinalRunLabel(idx)}
                      {isPast && <span className="ml-2 text-[10px] uppercase tracking-wide">past</span>}
                    </Label>
                    <DatePicker
                      value={p.effectiveDate}
                      onChange={(v) => {
                        setOverrides((o) => {
                          const next = { ...o };
                          if (v === p.defaultDate) delete next[p.monthKey];
                          else next[p.monthKey] = v;
                          return next;
                        });
                      }}
                      minDate={firstOfMonth}
                      maxDate={lastOfMonth}
                      disabled={isPast}
                    />
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

        {/* Next-run line only shows on the standalone (non-embedded)
            card. Inside the drawer the schedule step already lays out
            every run date, so repeating "Next run" up top is noise. */}
        {!embedded && savedAt && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Last sent: <span className="font-medium text-foreground">{savedAt}</span>
          </div>
        )}

      <div className="flex justify-between gap-2 pt-2">
        {/* Delete is destructive-styled (red) and only shown when
            editing an existing automation. New automations have
            nothing to delete yet. */}
        <div>
          {embedded && isExisting && (
            <Button
              variant="secondary"
              onClick={handleDelete}
              disabled={pending}
              className="!text-destructive hover:!bg-destructive/10"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete automation
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {embedded && isExisting && (
            <Button onClick={save} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save changes
            </Button>
          )}
          {embedded && !isExisting && embeddedStep === "form" && (
            <Button
              onClick={() => {
                if (validateForm() === null) return;
                setEmbeddedStep("schedule");
              }}
              disabled={pending}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              Next
            </Button>
          )}
          {embedded && !isExisting && embeddedStep === "schedule" && (
            <>
              <Button variant="secondary" onClick={() => setEmbeddedStep("form")} disabled={pending}>
                Back
              </Button>
              {planned.length > 0 && (
                <Button onClick={save} disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  Confirm
                </Button>
              )}
            </>
          )}
          {!embedded && (
            <Button onClick={save} disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save auto-send
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return embedded ? body : (
    <Card>
      <CardContent className="pt-5">{body}</CardContent>
    </Card>
  );
}
