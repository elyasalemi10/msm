"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Loader2, Paperclip, X, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { queueBatchSend } from "@/lib/actions/levy";

interface LevyRow {
  id: string;
  lot_number: number;
  unit_number: string | null;
  owner_display_name: string | null;
  owner_contact_email: string | null;
  reference_number: string;
}

interface Props {
  ocId: string;
  batchId: string;
  /** Send mode dictates which action runs + the dialog copy. */
  mode: "send" | "resend";
  levies: LevyRow[];
  /** Real mailbox addresses the manager can send from. Loaded server-side
   *  so the dialog opens instantly with no loading state. When there are
   *  2+ options the dialog renders a dropdown so the manager can pick
   *  between e.g. their connected Gmail address and the noreply@
   *  StrataWise mailbox. */
  mailboxOptions: Array<{ value: string; label: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: (sentCount: number) => void;
}

const ATTACHMENT_LIMIT_BYTES = 20 * 1024 * 1024;
// Recipient table shows 4.5 rows worth of vertical room before scrolling so
// users can scan the recipients and feel there's more if they scroll. Each
// row is roughly 44px tall (Input height + padding).
const RECIPIENT_TABLE_MAX_HEIGHT = 4.5 * 44 + 36; // + header

export function SendEmailsDialog({
  ocId, batchId, mode, levies, mailboxOptions, open, onOpenChange, onSent,
}: Props) {
  // Default to the first option (typically the manager's connected
  // mailbox). Manager can switch when there are 2+ options.
  const [fromAddress, setFromAddress] = useState<string>(mailboxOptions[0]?.value ?? "");
  useEffect(() => {
    if (open) setFromAddress(mailboxOptions[0]?.value ?? "");
  }, [open, mailboxOptions]);

  // Pre-fill overrides with the owner's stored email so the manager can
  // edit in place instead of typing into an empty input.
  const initialOverrides = useMemo(() => {
    const seed: Record<string, string> = {};
    for (const l of levies) seed[l.id] = l.owner_contact_email ?? "";
    return seed;
  }, [levies]);
  const [overrides, setOverrides] = useState<Record<string, string>>(initialOverrides);
  // Reset whenever the dialog reopens (levies set may have changed).
  useEffect(() => {
    if (open) setOverrides(initialOverrides);
  }, [open, initialOverrides]);

  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(false);
  // `locked` is the in-flight flag. ONCE the manager clicks Send we
  // freeze every interactive control so they can't edit recipients,
  // add attachments, or change the sender mid-dispatch.
  const locked = sending || pending;

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = [...attachments];
    for (const f of Array.from(files)) {
      if (next.find((x) => x.name === f.name && x.size === f.size)) continue;
      next.push(f);
    }
    const total = next.reduce((s, f) => s + f.size, 0);
    if (total > ATTACHMENT_LIMIT_BYTES) {
      toast.error(`Attachments exceed the 20 MB email cap.`);
      return;
    }
    setAttachments(next);
  }

  function removeFile(name: string, size: number) {
    setAttachments((prev) => prev.filter((f) => !(f.name === name && f.size === size)));
  }

  async function handleSend() {
    setSending(true);
    startTransition(async () => {
      const extras = await Promise.all(
        attachments.map(async (f) => ({
          filename: f.name,
          contentType: f.type || "application/octet-stream",
          contentBase64: Buffer.from(await f.arrayBuffer()).toString("base64"),
        })),
      );
      const cleanOverrides = Object.fromEntries(
        Object.entries(overrides).filter(([, v]) => v.trim().length > 0),
      );

      const result = await queueBatchSend(ocId, batchId, mode, {
        emailOverrides: cleanOverrides,
        extraAttachments: extras,
        fromAddress: fromAddress || undefined,
      });
      setSending(false);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${levies.length} levy ${levies.length === 1 ? "email" : "emails"} ${mode === "resend" ? "resending" : "sending"} in the background`,
      );
      onSent(levies.length);
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Don't allow closing the dialog mid-send , the user could
        // double-trigger or lose the in-progress state.
        if (locked && !o) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            {mode === "resend" ? "Resend levies by email" : "Send levies by email"}
          </DialogTitle>
          <DialogDescription>
            {mailboxOptions.length <= 1 ? (
              <>Sending from <strong className="text-foreground">{mailboxOptions[0]?.label ?? "noreply"}</strong></>
            ) : (
              "Choose which mailbox these emails come from."
            )}
          </DialogDescription>
        </DialogHeader>

        {mailboxOptions.length > 1 && (
          <div className="space-y-1.5">
            <Label>Sending from</Label>
            <Select
              value={fromAddress}
              onValueChange={(v) => setFromAddress(v ?? "")}
              disabled={locked}
            >
              <SelectTrigger>
                <SelectValue>
                  {mailboxOptions.find((o) => o.value === fromAddress)?.label ?? fromAddress}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {mailboxOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Whole body wrapper , when locked, drop interactivity + fade
            so the manager sees the dialog is "in motion" and stays out
            of the way. */}
        <div className={locked ? "pointer-events-none opacity-60 transition-opacity" : ""}>
          {/* Recipient table , scrolls past 4.5 rows so the dialog stays a
              consistent height regardless of batch size. */}
          <div
            className="overflow-y-auto rounded-md border border-border"
            style={{ maxHeight: `${RECIPIENT_TABLE_MAX_HEIGHT}px` }}
          >
            <Table variant="bordered" className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Lot</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Email</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {levies.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs">
                      {l.lot_number}{l.unit_number ? `/${l.unit_number}` : ""}
                    </TableCell>
                    <TableCell className="text-foreground">
                      {l.owner_display_name ?? ""}
                    </TableCell>
                    <TableCell>
                      <Input
                        value={overrides[l.id] ?? ""}
                        onChange={(e) =>
                          setOverrides((prev) => ({ ...prev, [l.id]: e.target.value }))
                        }
                        disabled={locked}
                        className="h-8 text-sm"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Attachments , no total counter, just the file list. */}
          <div className="space-y-2 mt-3">
            <div className="flex items-center justify-between">
              <Label>Attachments</Label>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={locked}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip className="size-4" />
                Add files
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
              />
            </div>
            {attachments.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-border p-2">
                {attachments.map((f) => (
                  <li key={`${f.name}-${f.size}`} className="flex items-center justify-between text-sm">
                    <span className="truncate text-foreground">
                      {f.name}{" "}
                      <span className="text-muted-foreground text-xs">
                        ({(f.size / 1024).toFixed(0)} KB)
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(f.name, f.size)}
                      aria-label="Remove attachment"
                      disabled={locked}
                      className="text-muted-foreground hover:text-destructive cursor-pointer disabled:cursor-not-allowed"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={locked}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={locked}>
            {locked && <Loader2 className="size-4 animate-spin" />}
            {mode === "resend" ? "Resend" : "Send"} {levies.length} {levies.length === 1 ? "email" : "emails"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
