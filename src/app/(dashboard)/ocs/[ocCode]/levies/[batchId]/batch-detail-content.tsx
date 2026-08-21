"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, ChevronDown, Download, ExternalLink, Mail, Trash2, FolderDown,
  Undo2, RefreshCw, AlertTriangle, Loader2,
} from "lucide-react";
import { useSetBreadcrumb } from "@/lib/breadcrumb-context";
import { format } from "date-fns";
import { formatDateLong } from "@/lib/utils";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { LevyStatusBadge } from "@/components/shared/levy-status-badge";
import { DatePicker } from "@/components/shared/date-picker";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  markBatchSent,
  markLevySent,
  cancelBatch,
  recallBatch,
  regenerateBatch,
  type LevyBatchDetail,
} from "@/lib/actions/levy";
import { useOCCode } from "@/lib/oc-context";
import { SendEmailsDialog } from "./send-emails-dialog";

const formatCurrency = (n: number) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);

export function BatchDetailContent({
  ocId,
  batch: initialBatch,
  reminderSentLevyIds = [],
  mailboxOptions,
}: {
  ocId: string;
  batch: LevyBatchDetail;
  reminderSentLevyIds?: string[];
  /** Real mailbox addresses the manager can send from. Computed
   *  server-side from the firm's mail_provider + manager profile.
   *  Never includes provider names like "Resend". */
  mailboxOptions: Array<{ value: string; label: string }>;
}) {
  const ocCode = useOCCode();
  const router = useRouter();
  const [batch, setBatch] = useState(initialBatch);
  const reminderSentSet = new Set(reminderSentLevyIds);

  // Override the URL-derived breadcrumb so the manager sees
  // "Levies > Regular batch" or "Levies > Special batch" instead of
  // just "Levies" (the UUID segment gets skipped by default).
  useSetBreadcrumb([
    { label: "Levies", href: `/ocs/${ocCode}/levies` },
    { label: batch.is_special ? "Special batch" : "Regular batch" },
  ]);
  const [openLevyId, setOpenLevyId] = useState<string | null>(null);

  // Batch-level pending flags , each action keeps a spinner on its own button.
  const [sendingAll, setSendingAll] = useState(false);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [resendDialogOpen, setResendDialogOpen] = useState(false);
  const [downloadingZip, startDownload] = useTransition();
  const [cancelling, setCancelling] = useState(false);
  const [recalling, setRecalling] = useState(false);

  // Per-row pending state
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());

  // Confirmation dialogs
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [showRecallConfirm, setShowRecallConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [regenDate, setRegenDate] = useState<string>("");
  const [regenerating, setRegenerating] = useState(false);

  async function handleSendAll() {
    setSendingAll(true);
    const result = await markBatchSent(ocId, batch.id);
    setSendingAll(false);
    if (result.success) {
      toast.success("All levies marked as sent");
      setBatch((prev) => ({
        ...prev,
        status: "sent",
        levies: prev.levies.map((l) => ({ ...l, status: l.status === "draft" ? "issued" : l.status })),
      }));
    }
  }

  async function handleMarkSent(levyId: string) {
    setSendingIds((prev) => new Set(prev).add(levyId));
    const result = await markLevySent(ocId, levyId);
    setSendingIds((prev) => {
      const next = new Set(prev);
      next.delete(levyId);
      return next;
    });
    if (result.success) {
      toast.success("Levy marked as sent");
      setBatch((prev) => {
        const updatedLevies = prev.levies.map((l) =>
          l.id === levyId ? { ...l, status: "issued" } : l,
        );
        const allSent = updatedLevies.every((l) => l.status !== "draft");
        return {
          ...prev,
          status: allSent ? "sent" : "partially_sent",
          levies: updatedLevies,
        };
      });
    }
  }

  async function handleRegenerate() {
    if (!regenDate) { toast.error("Select a new due date"); return; }
    setRegenerating(true);
    const result = await regenerateBatch(ocId, batch.id, regenDate);
    setRegenerating(false);
    if (result.success) {
      toast.success("Batch regenerated with new due date");
      setShowRegenerate(false);
      setShowRegenConfirm(false);
      router.refresh();
    }
  }

  async function handleRecall() {
    setRecalling(true);
    const result = await recallBatch(ocId, batch.id);
    setRecalling(false);
    setShowRecallConfirm(false);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success("Batch recalled, levies reverted to draft");
      setBatch((prev) => ({
        ...prev,
        status: "draft",
        levies: prev.levies.map((l) => ({ ...l, status: "draft" })),
      }));
    }
  }

  async function handleCancel() {
    setCancelling(true);
    const result = await cancelBatch(ocId, batch.id);
    setCancelling(false);
    setShowCancelConfirm(false);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success("Batch cancelled");
      router.push(`/ocs/${ocCode}/levies`);
    }
  }

  // Server-side zip , single GET, single download, no per-PDF popup.
  function handleDownloadAllZip() {
    startDownload(async () => {
      try {
        const res = await fetch(`/api/levy-batches/${batch.id}/zip`);
        if (!res.ok) {
          toast.error("Couldn't build the zip. Try again.");
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${batch.period_label.replace(/[^\w-]+/g, "-")}-${batch.financial_year}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("ZIP download failed", err);
        toast.error("Couldn't download the zip.");
      }
    });
  }

  const draftCount = batch.levies.filter((l) => l.status === "draft").length;
  const toLevyRow = (l: typeof batch.levies[number]) => ({
    id: l.id,
    lot_number: l.lot_number,
    unit_number: l.unit_number,
    owner_display_name: l.owner_display_name,
    owner_contact_email: l.owner_contact_email,
    reference_number: l.reference_number,
  });
  const draftLeviesForDialog = batch.levies.filter((l) => l.status === "draft").map(toLevyRow);
  const allLeviesForDialog = batch.levies.map(toLevyRow);
  const fundLabel = batch.fund_type === "operating" ? "Admin Fund" : "Maintenance Plan Fund";
  const hasPaidLevies = batch.levies.some((l) => l.status === "paid");
  const canRecall = (batch.status === "sent" || batch.status === "partially_sent") && !hasPaidLevies;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {/* Back arrow removed , the sidebar breadcrumb already
              names "Levies > <Regular|Special> batch" so the manager
              has a one-click way back without an extra in-page chevron. */}
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-foreground">{batch.period_label}</h1>
              <Badge variant={batch.fund_type === "operating" ? "info" : "neutral"}>
                {fundLabel}
              </Badge>
              <Badge
                variant={
                  batch.status === "sent" ? "success"
                  : batch.status === "partially_sent" ? "warning"
                  : batch.status === "cancelled" ? "destructive"
                  : "neutral"
                }
              >
                {batch.status === "sent" ? "Sent"
                  : batch.status === "partially_sent" ? "Partially sent"
                  : batch.status === "cancelled" ? "Cancelled"
                  : "Draft"}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {draftCount > 0 ? (
            <Button onClick={() => setEmailDialogOpen(true)} size="sm">
              <Mail className="size-3.5" />
              Send by email ({draftCount})
            </Button>
          ) : batch.levies.length > 0 ? (
            <Button onClick={() => setResendDialogOpen(true)} size="sm">
              <Mail className="size-3.5" />
              Resend all by email
            </Button>
          ) : null}

          {/* Single Actions menu bundles every batch-level operation:
              mark sent, download zip, regenerate, recall, cancel. Popover
              over Base UI Menu primitive (the Menu Trigger render slot
              kept throwing error #31 with our Button). */}
          <Popover>
            <PopoverTrigger className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted cursor-pointer">
              Actions
              <ChevronDown className="size-3.5" />
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="end" showBackdrop={false}>
              {draftCount > 0 && (
                <button
                  type="button"
                  onClick={handleSendAll}
                  disabled={sendingAll}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted cursor-pointer disabled:opacity-50"
                >
                  {sendingAll ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                  Mark all as sent
                </button>
              )}
              <button
                type="button"
                onClick={handleDownloadAllZip}
                disabled={downloadingZip}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted cursor-pointer disabled:opacity-50"
              >
                {downloadingZip ? <Loader2 className="size-3.5 animate-spin" /> : <FolderDown className="size-3.5" />}
                Download all
              </button>
              <button
                type="button"
                onClick={() => { setRegenDate(""); setShowRegenerate(true); }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted cursor-pointer"
              >
                <RefreshCw className="size-3.5" />
                Regenerate
              </button>
              {canRecall && (
                <button
                  type="button"
                  onClick={() => setShowRecallConfirm(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-muted cursor-pointer"
                >
                  <Undo2 className="size-3.5" />
                  Recall batch
                </button>
              )}
              {batch.status === "draft" && (
                <button
                  type="button"
                  onClick={() => setShowCancelConfirm(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/5 cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                  Cancel batch
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Levy list. Each row's dropdown carries its own period + due-date
          info, line items table, and per-lot actions. The page-level
          summary cards are gone , total + counts moved to the bottom strip. */}
      <Card>
        <CardContent className="pt-5">
          <div className="overflow-hidden rounded-lg border border-border">
            {batch.levies.map((levy) => (
              <div key={levy.id} className="border-t border-border/50 first:border-t-0">
                <button
                  type="button"
                  onClick={() => setOpenLevyId(openLevyId === levy.id ? null : levy.id)}
                  className="flex w-full items-center justify-between px-4 py-3 text-sm hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${openLevyId === levy.id ? "rotate-180" : ""}`} />
                    <div className="text-left">
                      <span className="font-medium text-foreground">
                        Lot {levy.lot_number}
                        {levy.unit_number ? ` (Unit ${levy.unit_number})` : ""}
                      </span>
                      <span className="ml-2 text-muted-foreground">
                        {levy.owner_display_name ?? ""}
                      </span>
                      {/* Reference cascade: DRN > owner payment_reference.
                          The internal LEV-NNNN sequence is never shown
                          to users (it's an internal sequence, not an
                          owner-facing reference). */}
                      <span className="ml-2 font-mono text-xs text-foreground">
                        {levy.drn
                          ? `DRN ${levy.drn}`
                          : (levy.payment_reference ?? "")}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold tabular-nums">{formatCurrency(levy.amount)}</span>
                    <LevyStatusBadge
                      status={levy.status as "draft" | "issued" | "partially_paid" | "paid" | "overdue" | "written_off"}
                      dueDate={batch.due_date}
                      reminderSent={reminderSentSet.has(levy.id)}
                    />
                  </div>
                </button>

                {openLevyId === levy.id && (
                  <div className="px-4 pb-2 pl-11 space-y-1.5">
                    {/* Line items , plain div grid (NOT the Table
                        primitive). The shared Table component bakes in
                        h-14 rows + text-base cells; overriding both
                        cleanly is fiddly and the previous attempt left
                        body rows invisible. A div grid lets us pick the
                        exact density (text-[11px], py-1 rows) directly. */}
                    <div className="overflow-hidden rounded-md border border-border bg-card">
                      <div className="grid grid-cols-[60px_1fr_auto] gap-x-4 px-3 py-1.5 bg-primary text-[11px] font-medium text-primary-foreground">
                        <div>Code</div>
                        <div>Description</div>
                        <div className="w-24 text-right">Amount</div>
                      </div>
                      {levy.items.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-muted-foreground">
                          No line items on this levy.
                        </div>
                      ) : (
                        levy.items.map((item, i) => (
                          <div
                            key={i}
                            className="grid grid-cols-[60px_1fr_auto] gap-x-4 px-3 py-1 text-[11px] border-t border-border first:border-t-0 hover:bg-muted/40"
                          >
                            <div className="font-mono text-muted-foreground">
                              {item.coa_code ?? ""}
                            </div>
                            <div className="text-foreground">
                              {item.description}
                              {item.is_adjustment && (
                                <span className="ml-1 text-[10px] text-primary">(adj)</span>
                              )}
                            </div>
                            <div className="w-24 text-right tabular-nums text-foreground">
                              {formatCurrency(item.amount)}
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    {/* Per-row actions */}
                    <div className="flex items-center gap-2 pt-1">
                      {levy.status === "draft" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleMarkSent(levy.id)}
                          disabled={sendingIds.has(levy.id)}
                        >
                          {sendingIds.has(levy.id)
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <CheckCircle2 className="size-3.5" />}
                          Mark as sent
                        </Button>
                      )}
                      {levy.pdf_url && (
                        <>
                          <a href={levy.pdf_url} target="_blank" rel="noopener noreferrer" aria-label="Open levy PDF in new tab">
                            <Button variant="outline" size="sm">
                              <ExternalLink className="size-3.5" />
                            </Button>
                          </a>
                          <a href={levy.pdf_url} download aria-label="Download levy PDF">
                            <Button variant="outline" size="sm">
                              <Download className="size-3.5" />
                            </Button>
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {/* Total row , sits at the bottom of the levy list so the
                dollar number column reads as a column-total, no separate
                summary card needed. */}
            <div className="flex items-center justify-between border-t-2 border-foreground/20 px-4 py-3 text-sm">
              <span className="font-semibold text-foreground">Total</span>
              <span className="font-bold tabular-nums text-foreground">
                {formatCurrency(batch.total_amount)}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>


      {/* Send-by-email dialog (drafts only) */}
      <SendEmailsDialog
        ocId={ocId}
        batchId={batch.id}
        mode="send"
        levies={draftLeviesForDialog}
        mailboxOptions={mailboxOptions}
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        onSent={(sent) => {
          setBatch((prev) => {
            let remaining = sent;
            return {
              ...prev,
              status: sent >= draftLeviesForDialog.length ? "sent" : "partially_sent",
              levies: prev.levies.map((l) => {
                if (l.status === "draft" && remaining > 0) {
                  remaining--;
                  return { ...l, status: "issued" };
                }
                return l;
              }),
            };
          });
        }}
      />

      {/* Resend-all dialog (every levy in the batch) */}
      <SendEmailsDialog
        ocId={ocId}
        batchId={batch.id}
        mode="resend"
        levies={allLeviesForDialog}
        mailboxOptions={mailboxOptions}
        open={resendDialogOpen}
        onOpenChange={setResendDialogOpen}
        onSent={() => { /* Resend doesn't change status , nothing to mirror. */ }}
      />

      {/* Regenerate dialog */}
      <Dialog open={showRegenerate} onOpenChange={setShowRegenerate}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Regenerate levy batch</DialogTitle>
            <DialogDescription>
              Set a new due date. All levy PDFs will be regenerated and the batch reverts to draft so it can be re-sent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>New due date</Label>
            <DatePicker value={regenDate} onChange={setRegenDate} />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowRegenerate(false)}>Cancel</Button>
            <Button
              onClick={() => setShowRegenConfirm(true)}
              disabled={!regenDate}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerate confirmation */}
      <AlertDialog open={showRegenConfirm} onOpenChange={setShowRegenConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Regenerate this batch?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite every levy PDF in the batch and revert all
              levies to draft. Owners who have already received an email will
              NOT be re-notified automatically , you&apos;ll need to send the
              new notices manually. This action can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRegenerate} disabled={regenerating}>
              {regenerating && <Loader2 className="size-4 animate-spin" />}
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Recall confirmation */}
      <AlertDialog open={showRecallConfirm} onOpenChange={setShowRecallConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Recall this batch?
            </AlertDialogTitle>
            <AlertDialogDescription>
              All levies revert to draft and are hidden from lot owners. Emails already sent cannot be unsent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRecall} disabled={recalling}>
              {recalling && <Loader2 className="size-4 animate-spin" />}
              Recall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel batch confirmation */}
      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Cancel this batch?
            </AlertDialogTitle>
            <AlertDialogDescription>
              All levy notices in this batch will be deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep batch</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={cancelling}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {cancelling && <Loader2 className="size-4 animate-spin" />}
              Cancel batch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
