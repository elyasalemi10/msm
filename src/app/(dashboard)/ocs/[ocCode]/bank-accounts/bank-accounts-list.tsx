"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Upload, Plus, Landmark, ChevronLeft, ChevronRight, ReceiptText, Trash2,
  AlertTriangle, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { AUSTRALIAN_BANKS } from "@/lib/data/australian-banks";
import { ImportCsvDialog } from "./import-csv-dialog";
import { AddBankAccountDrawer } from "./add-bank-account-drawer";
import { deleteBankAccount } from "./actions";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

const formatDate = (iso: string | null) => {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const monthLabelFmt = new Intl.DateTimeFormat("en-AU", {
  month: "long",
  year: "numeric",
});

function monthKey(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 7);
}

function labelForMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return monthLabelFmt.format(new Date(y, m - 1, 1));
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

interface BankAccountRow {
  id: string;
  account_name: string | null;
  bsb: string | null;
  account_number: string | null;
  bank_name: string | null;
  fund_labels: string[];
  transactions: Array<{
    id: string;
    date: string | null;
    description: string;
    amount: number | null;
    balance: number | null;
  }>;
}

function logoFor(bankName: string | null | undefined): string | null {
  if (!bankName) return null;
  return AUSTRALIAN_BANKS.find(
    (b) => b.name.toLowerCase() === bankName.toLowerCase(),
  )?.logo ?? null;
}

export function BankAccountsList({
  ocId,
  accounts,
}: {
  ocId: string;
  accounts: BankAccountRow[];
}) {
  const router = useRouter();
  const [importTarget, setImportTarget] = useState<BankAccountRow | null>(null);
  const [activeTab, setActiveTab] = useState<string>(accounts[0]?.id ?? "");
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BankAccountRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function switchTab(next: string) {
    setActiveTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url.toString());
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await deleteBankAccount(ocId, deleteTarget.id);
    if (res.error) {
      setDeleting(false);
      toast.error(res.error);
      return;
    }
    // Move to the account that just became primary BEFORE the refresh, so
    // the tab strip never points at the row that's about to disappear.
    const promoted = res.promotedAccountId ?? accounts.find((a) => a.id !== deleteTarget.id)?.id ?? "";
    switchTab(promoted);
    setDeleteTarget(null);
    setDeleting(false);
    toast.success("Bank account deleted");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={switchTab}>
        <div className="flex items-center justify-between">
          <TabsList
            variant="line"
            className="h-auto flex-wrap justify-start gap-2 border-0 bg-transparent p-0"
          >
            {accounts.map((a) => {
              const logo = logoFor(a.bank_name);
              return (
                <TabsTrigger
                  key={a.id}
                  value={a.id}
                  className="relative h-11 min-w-[6.5rem] rounded-none border-0 px-4 text-sm font-medium text-muted-foreground bg-transparent transition-colors hover:text-foreground hover:bg-transparent data-active:bg-transparent data-active:text-foreground data-active:after:bg-[color:var(--brand-gold)] data-active:after:rounded-full inline-flex items-center gap-2"
                >
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="" width={18} height={18} className="rounded shrink-0" />
                  ) : (
                    <Landmark className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  {a.account_name || a.bank_name || "Bank account"}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            aria-label="Add bank account"
            className="ml-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {accounts.map((a) => (
          <TabsContent key={a.id} value={a.id} className="mt-4">
            <AccountPane
              account={a}
              onImport={() => setImportTarget(a)}
              // An OC must keep one account , levies have to name somewhere
              // to be paid. With only one left there's nothing to delete to.
              onDelete={accounts.length > 1 ? () => setDeleteTarget(a) : undefined}
            />
          </TabsContent>
        ))}
      </Tabs>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o && !deleting) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Delete this bank account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.account_name || "This account"} and every transaction
              imported into it will be removed. The remaining account becomes the
              Owners Corporation&apos;s primary operating account and will be shown
              on new levy notices. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {importTarget && (
        <ImportCsvDialog
          ocId={ocId}
          account={importTarget}
          open={!!importTarget}
          onOpenChange={(o) => {
            if (!o) {
              setImportTarget(null);
              router.refresh();
            }
          }}
        />
      )}

      <AddBankAccountDrawer
        ocId={ocId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => {
          setAddOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function AccountPane({
  account,
  onImport,
  onDelete,
}: {
  account: BankAccountRow;
  onImport: () => void;
  /** Omitted when this is the OC's last account , nothing to fall back to. */
  onDelete?: () => void;
}) {
  // Available month keys derived from the imported transactions, newest first.
  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    for (const t of account.transactions) {
      const k = monthKey(t.date);
      if (k) set.add(k);
    }
    return Array.from(set).sort().reverse();
  }, [account.transactions]);

  // Default to the current calendar month if it has any rows, otherwise the
  // most recent month with rows, otherwise the current month (so an empty
  // account still shows a sensible label rather than blanking out).
  const initial = useMemo(() => {
    const cur = currentMonthKey();
    if (availableMonths.includes(cur)) return cur;
    return availableMonths[0] ?? cur;
  }, [availableMonths]);
  const [activeMonth, setActiveMonth] = useState<string>(initial);

  const visibleTxns = useMemo(
    () => account.transactions.filter((t) => monthKey(t.date) === activeMonth),
    [account.transactions, activeMonth],
  );

  return (
    <div className="rounded-md border border-border bg-card p-5 space-y-5">
      <div className="flex items-center justify-end gap-2">
        {onDelete && (
          <Button
            variant="secondary"
            onClick={onDelete}
            className="text-destructive hover:bg-destructive/5"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete account
          </Button>
        )}
        <Button onClick={onImport}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Import CSV
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 border-t border-border pt-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {account.fund_labels.length > 1 ? "Funds" : "Fund"}
          </p>
          <p className="text-sm text-foreground mt-1">
            {account.fund_labels.length > 0 ? account.fund_labels.join(", ") : ""}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">BSB</p>
          <p className="text-sm text-foreground mt-1">{account.bsb || ""}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Account number</p>
          <p className="text-sm text-foreground mt-1">{account.account_number || ""}</p>
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <div className="mb-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setActiveMonth((k) => shiftMonthKey(k, -1))}
            aria-label="Previous month"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="min-w-[12rem] text-center text-lg font-semibold text-foreground tabular-nums">
            {labelForMonthKey(activeMonth)}
          </span>
          <button
            type="button"
            onClick={() => setActiveMonth((k) => shiftMonthKey(k, 1))}
            aria-label="Next month"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        {account.transactions.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="No transactions yet"
            description='Import a CSV statement to populate this account. Use the "Import CSV" button above.'
            card={false}
          />
        ) : visibleTxns.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title={`No transactions in ${labelForMonthKey(activeMonth)}`}
            description="Step to a different month or import more rows."
            card={false}
          />
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table variant="striped">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[130px] text-right">Amount</TableHead>
                  <TableHead className="w-[140px] text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleTxns.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-foreground text-xs">{formatDate(t.date)}</TableCell>
                    <TableCell className="text-foreground text-xs">{t.description}</TableCell>
                    <TableCell className={`text-right tabular-nums text-xs ${t.amount !== null && t.amount < 0 ? "text-destructive" : "text-foreground"}`}>
                      {t.amount !== null ? formatCurrency(t.amount) : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-foreground">
                      {t.balance !== null ? formatCurrency(t.balance) : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
