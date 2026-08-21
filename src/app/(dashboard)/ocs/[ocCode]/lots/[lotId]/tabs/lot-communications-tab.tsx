"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PhoneInput } from "@/components/shared/phone-input";
import { NumberInput } from "@/components/ui/number-input";
import { EditSheet } from "@/components/shared/edit-sheet";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Phone as PhoneIcon,
  MessageSquare,
  Paperclip,
  X,
  PhoneCall,
  Send,
  ChevronDown,
  Lock,
  Unlock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DatePicker } from "@/components/shared/date-picker";
import { toast } from "sonner";
import {
  logPhoneCall,
  sendLotSms,
  sendLotEmail,
  setCommunicationConfidential,
  type LotCommunicationRow,
} from "@/lib/actions/lot-communications";
import {
  getManagerSendAddress,
  getSmsSenderId,
  listManagerInboxes,
} from "@/lib/actions/manager-username";

// Communications tab: one "Actions" dropdown that opens a drawer per action
// (Send email / Send SMS / Log phone call). History below renders one row per
// past communication; clicking a row opens a read-only detail dialog with the
// full subject / body / metadata instead of dumping everything inline.

interface Props {
  ocId: string;
  lotId: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
  ownerName: string | null;
  initialCommunications: LotCommunicationRow[];
  // When the lot page's More-actions menu picks Send email / Send SMS,
  // the parent flips activeTab to communications AND sets this. We open
  // the matching drawer and call onPendingActionHandled to clear it.
  pendingAction?: "email" | "sms" | null;
  onPendingActionHandled?: () => void;
  // Preloaded by the lot detail page so the Send-email / Send-SMS
  // drawers can paint with the right "From" address on first frame
  // instead of doing their own client-side fetch.
  initialSenderEmailAddress?: string | null;
  initialSmsSenderId?: string | null;
}

type DrawerName = null | "email" | "sms" | "call";

export function LotCommunicationsTab(props: Props) {
  const router = useRouter();
  const {
    ocId,
    lotId,
    ownerEmail,
    ownerPhone,
    ownerName,
    initialCommunications,
    pendingAction,
    onPendingActionHandled,
    initialSenderEmailAddress,
    initialSmsSenderId,
  } = props;
  const [open, setOpen] = React.useState<DrawerName>(null);

  React.useEffect(() => {
    if (pendingAction === "email" || pendingAction === "sms") {
      setOpen(pendingAction);
      onPendingActionHandled?.();
    }
  }, [pendingAction, onPendingActionHandled]);
  const [detail, setDetail] = React.useState<LotCommunicationRow | null>(null);
  const [rows, setRows] = React.useState<LotCommunicationRow[]>(initialCommunications);
  // Keep local state in sync if the server refreshes the page (e.g. after
  // a successful send , router.refresh() re-runs the server component and
  // re-mounts this tab with new initialCommunications).
  React.useEffect(() => {
    setRows(initialCommunications);
  }, [initialCommunications]);

  return (
    <TooltipProvider delay={120}>
    <div className="space-y-6">
      {/* Communication history , Actions dropdown lives in the header row of
          this single card. The standalone "Reach out" tile is gone. */}
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">
              Communication history
            </h3>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm">
                    Actions
                    <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" sideOffset={6}>
                <DropdownMenuItem onClick={() => setOpen("email")}>
                  <Mail className="mr-2 h-4 w-4 text-[color:var(--brand-gold)]" />
                  Send email
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setOpen("sms")}>
                  <Send className="mr-2 h-4 w-4 text-[color:var(--brand-gold)]" />
                  Send SMS
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setOpen("call")}>
                  <PhoneCall className="mr-2 h-4 w-4 text-[color:var(--brand-gold)]" />
                  Log phone call
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <CommunicationHistoryList
            rows={rows}
            onRowClick={(row) => setDetail(row)}
          />
        </CardContent>
      </Card>

      {/* Drawers , only the open one mounts. Mount/unmount on `open` so each
          drawer's local state resets between uses. */}
      {open === "email" && (
        <SendEmailDrawer
          ocId={ocId}
          lotId={lotId}
          ownerEmail={ownerEmail}
          ownerName={ownerName}
          initialSenderAddress={initialSenderEmailAddress ?? null}
          onClose={() => setOpen(null)}
          onSaved={() => router.refresh()}
        />
      )}
      {open === "sms" && (
        <SendSmsDrawer
          ocId={ocId}
          lotId={lotId}
          ownerPhone={ownerPhone}
          initialSenderId={initialSmsSenderId ?? null}
          onClose={() => setOpen(null)}
          onSaved={() => router.refresh()}
        />
      )}
      {open === "call" && (
        <LogCallDrawer
          ocId={ocId}
          lotId={lotId}
          ownerPhone={ownerPhone}
          onClose={() => setOpen(null)}
          onSaved={() => router.refresh()}
        />
      )}

      {detail && (
        <CommunicationDetailDialog
          row={detail}
          onClose={() => setDetail(null)}
          initialSmsSenderId={initialSmsSenderId ?? null}
        />
      )}
    </div>
    </TooltipProvider>
  );
}

// Page size for the in-card pagination control. Small enough to stay above
// the fold on a typical lot detail; large enough that an active lot isn't
// click-click-clicking through eight rows of history.
const HISTORY_PAGE_SIZE = 15;
const MAX_SUBJECT_CHARS = 60;

function truncateSubject(subject: string | null): string {
  if (!subject) return "(no subject)";
  if (subject.length <= MAX_SUBJECT_CHARS) return subject;
  return `${subject.slice(0, MAX_SUBJECT_CHARS - 1).trimEnd()}…`;
}

function rowTitle(row: LotCommunicationRow): string {
  if (row.channel === "voice") {
    return row.direction === "inbound" ? "Inbound call" : "Outbound call";
  }
  if (row.channel === "sms") {
    return "SMS";
  }
  // email
  return `Email: ${truncateSubject(row.subject)}`;
}

function CommunicationHistoryList({
  rows,
  onRowClick,
}: {
  rows: LotCommunicationRow[];
  onRowClick: (row: LotCommunicationRow) => void;
}) {
  const [page, setPage] = React.useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * HISTORY_PAGE_SIZE;
  const visible = rows.slice(start, start + HISTORY_PAGE_SIZE);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No communications yet"
        description="Calls, SMS and emails to the lot owner will show up here."
        card={false}
      />
    );
  }

  return (
    <div className="space-y-3">
      <ol className="divide-y divide-border">
        {visible.map((row) => (
          <CommunicationRow
            key={row.id}
            row={row}
            onClick={() => onRowClick(row)}
          />
        ))}
      </ol>
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1 text-xs text-muted-foreground">
          <span>
            Showing {start + 1}–{Math.min(start + HISTORY_PAGE_SIZE, rows.length)} of{" "}
            {rows.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            >
              Previous
            </Button>
            <span className="px-2 tabular-nums">
              Page {safePage + 1} of {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommunicationRow({
  row,
  onClick,
}: {
  row: LotCommunicationRow;
  onClick: () => void;
}) {
  const Icon =
    row.channel === "email"
      ? Mail
      : row.channel === "sms"
        ? MessageSquare
        : PhoneIcon;

  return (
    <li className="flex w-full items-center gap-1 py-1.5">
      <button
        type="button"
        onClick={onClick}
        className="flex flex-1 items-center justify-between gap-3 py-1.5 text-left transition-colors hover:bg-muted/50 cursor-pointer rounded-md px-2 -mx-1"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="h-4 w-4 shrink-0 text-[color:var(--brand-gold)]" />
          <p className="truncate text-sm font-medium text-foreground">
            {rowTitle(row)}
          </p>
          {row.attachments.length > 0 && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
              title={`${row.attachments.length} attachment${row.attachments.length === 1 ? "" : "s"}`}
            >
              <Paperclip className="h-3 w-3" />
              {row.attachments.length}
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatShortDate(row.created_at)}
        </span>
      </button>
      {/* Owner this communication is logged against (the owner at the time
          the row was created). Avatar when they have a portal picture, else
          initials; nothing when there was no owner then. */}
      {row.owner_name && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-[10px] font-medium text-muted-foreground">
                {row.owner_avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.owner_avatar_url} alt={row.owner_name} className="h-full w-full object-cover" />
                ) : (
                  row.owner_name
                    .split(/\s+/)
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()
                )}
              </span>
            }
          />
          <TooltipContent>Owner at the time: {row.owner_name}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Date-only formatter for call_date (when the call happened) , the manager
// only ever picks a date in the form, never a time of day, so showing
// "13:00" in the detail dialog is misleading.
function formatDateOnly(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ─── Detail dialog ─────────────────────────────────────────────────────────

function CommunicationDetailDialog({
  row,
  onClose,
  initialSmsSenderId,
}: {
  row: LotCommunicationRow;
  onClose: () => void;
  initialSmsSenderId: string | null;
}) {
  if (row.channel === "email") {
    return <EmailDetailDialog row={row} onClose={onClose} />;
  }
  if (row.channel === "sms") {
    return (
      <SmsDetailDialog
        row={row}
        onClose={onClose}
        initialSenderId={initialSmsSenderId}
      />
    );
  }
  return <CallDetailDialog row={row} onClose={onClose} />;
}

// Email preview , wider dialog with a visible grey outer border. Each row
// is its own bordered strip so long values don't push out past the dialog
// edge , From / To wrap, Subject scrolls horizontally, Body scrolls
// vertically.
function EmailDetailDialog({
  row,
  onClose,
}: {
  row: LotCommunicationRow;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl rounded-xl border border-border shadow-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-[color:var(--brand-gold)]" />
            Email
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm overflow-hidden">
          <HeaderField label="From" value={row.actor_name ?? ","} />
          <HeaderField label="To" value={row.recipient_email ?? ","} />
          <HeaderField
            label="Subject"
            value={row.subject ?? "(no subject)"}
            scrollX
          />
          <HeaderField label="Sent" value={formatShortDate(row.created_at)} />
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Body
            </p>
            <div className="h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-sm leading-relaxed text-foreground">
              {row.body_preview || "(empty)"}
            </div>
          </div>
          {row.attachments.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Attachments ({row.attachments.length})
              </p>
              <ul className="space-y-1.5">
                {row.attachments.map((a) => (
                  <li key={a.id}>
                    <a
                      href={`/api/inbox-attachments/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:border-primary/40 hover:bg-muted/40"
                    >
                      <span className="inline-flex items-center gap-2 min-w-0">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium text-foreground">
                          {a.filename}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatFileSize(a.size_bytes)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SmsDetailDialog({
  row,
  onClose,
  initialSenderId,
}: {
  row: LotCommunicationRow;
  onClose: () => void;
  initialSenderId: string | null;
}) {
  // Pull the platform-level SMS sender id so the "From" row matches what
  // landed on the recipient's handset , the manager's profile name only
  // shows up in the audit log, not in the SMS itself. Preloaded
  // server-side and threaded through the tab; only fetch as a fallback.
  const [senderId, setSenderId] = React.useState<string | null>(initialSenderId);
  React.useEffect(() => {
    if (senderId) return;
    let cancelled = false;
    getSmsSenderId().then((res) => {
      if (!cancelled) setSenderId(res.sender);
    });
    return () => {
      cancelled = true;
    };
  }, [senderId]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md rounded-xl border border-border shadow-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-[color:var(--brand-gold)]" />
            SMS
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm overflow-hidden">
          <HeaderField label="From" value={senderId ?? ","} />
          <HeaderField label="To" value={row.recipient_phone ?? ","} />
          <HeaderField label="Sent" value={formatShortDate(row.created_at)} />
          {row.actor_name && (
            <HeaderField label="Logged by" value={row.actor_name} />
          )}
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Message
            </p>
            <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-sm leading-relaxed text-foreground">
              {row.body_preview || "(empty)"}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CallDetailDialog({
  row,
  onClose,
}: {
  row: LotCommunicationRow;
  onClose: () => void;
}) {
  const title =
    row.direction === "inbound" ? "Inbound call" : "Outbound call";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md rounded-xl border border-border shadow-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PhoneIcon className="h-4 w-4 text-[color:var(--brand-gold)]" />
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm overflow-hidden">
          <HeaderField label="Logged by" value={row.actor_name ?? ","} />
          <HeaderField label="Number" value={row.recipient_phone ?? ","} />
          <HeaderField
            label="Call date"
            value={formatDateOnly(row.sent_at ?? row.created_at)}
          />
          <HeaderField
            label="Logged on"
            value={formatShortDate(row.created_at)}
          />
          {row.duration_seconds !== null && row.duration_seconds !== undefined && (
            <HeaderField
              label="Duration"
              value={`${Math.floor(row.duration_seconds / 60)} min`}
            />
          )}
          {row.body_preview && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Notes
              </p>
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-sm leading-relaxed text-foreground">
                {row.body_preview}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HeaderField({
  label,
  value,
  scrollX,
}: {
  label: string;
  value: string;
  scrollX?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div
        className={`mt-0.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground ${
          scrollX ? "overflow-x-auto whitespace-nowrap" : "break-words"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

// ─── Send email drawer ─────────────────────────────────────────────────────

interface AttachmentDraft {
  file: File;
  base64: string;
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB each

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // result: "data:<mime>;base64,<payload>" , strip the prefix.
      const result = reader.result as string;
      const idx = result.indexOf(",");
      resolve(idx === -1 ? result : result.slice(idx + 1));
    };
    reader.readAsDataURL(file);
  });
}

function SendEmailDrawer({
  ocId,
  lotId,
  ownerEmail,
  ownerName,
  initialSenderAddress,
  onClose,
  onSaved,
}: {
  ocId: string;
  lotId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  initialSenderAddress: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [to, setTo] = React.useState(ownerEmail ?? "");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [attachments, setAttachments] = React.useState<AttachmentDraft[]>([]);
  // Inbox dropdown , populated from listManagerInboxes(). Default
  // selection is the first connected custom inbox (Gmail) if
  // any, otherwise the manager's StrataWise address.
  const [inboxes, setInboxes] = React.useState<Array<{ email: string; kind: "stratawise" | "gmail" }>>(
    initialSenderAddress ? [{ email: initialSenderAddress, kind: "stratawise" }] : [],
  );
  const [selectedInbox, setSelectedInbox] = React.useState<string>(initialSenderAddress ?? "");
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    listManagerInboxes()
      .then((rows) => {
        if (cancelled) return;
        if (rows.length === 0) return;
        setInboxes(rows);
        // Default to the first custom inbox; if none, fall back to whatever
        // is first in the list (which will be the StrataWise default).
        const firstCustom = rows.find((r) => r.kind !== "stratawise");
        setSelectedInbox((prev) => prev || (firstCustom?.email ?? rows[0]?.email ?? ""));
      })
      .catch(() => {
        // Fallback: at least show the stratawise address if we can.
        getManagerSendAddress()
          .then((res) => {
            if (!cancelled && res.address) {
              setInboxes([{ email: res.address, kind: "stratawise" }]);
              setSelectedInbox((prev) => prev || res.address!);
            }
          })
          .catch(() => {});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ownerHasEmail = !!(ownerEmail && ownerEmail.trim());

  async function handleFiles(filesList: FileList | null) {
    if (!filesList || filesList.length === 0) return;
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) {
      toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    const incoming = Array.from(filesList).slice(0, remaining);
    const accepted: AttachmentDraft[] = [];
    for (const file of incoming) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`${file.name} is over 8MB.`);
        continue;
      }
      try {
        const base64 = await readFileAsBase64(file);
        accepted.push({ file, base64 });
      } catch {
        toast.error(`Could not read ${file.name}.`);
      }
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <EditSheet
      label="Send email"
      description={ownerName ? `To ${ownerName}` : "Choose where this email should go"}
      headerKicker={null}
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      renderTrigger={() => <span />}
      saveLabel="Send email"
      successToast="Email sent"
      onSave={async () => {
        if (!to.trim()) return { ok: false as const, error: "Recipient email is required." };
        if (!subject.trim()) return { ok: false as const, error: "Subject is required." };
        if (!body.trim()) return { ok: false as const, error: "Message body is required." };
        const res = await sendLotEmail({
          oc_id: ocId,
          lot_id: lotId,
          recipient_email: to.trim(),
          subject: subject.trim(),
          body,
          attachments: attachments.map((a) => ({
            filename: a.file.name,
            contentType: a.file.type || "application/octet-stream",
            base64: a.base64,
          })),
        });
        if (res.ok) onSaved();
        return res.ok
          ? { ok: true as const }
          : { ok: false as const, error: res.error };
      }}
    >
      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">
          From
        </Label>
        {inboxes.length <= 1 ? (
          <p className="text-sm font-medium text-foreground break-all">
            {selectedInbox || "your StrataWise email address"}
          </p>
        ) : (
          <Select value={selectedInbox} onValueChange={(v) => setSelectedInbox(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a sending inbox" />
            </SelectTrigger>
            <SelectContent>
              {inboxes.map((i) => (
                <SelectItem key={i.email} value={i.email}>
                  {i.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="comm-to">To</Label>
        <Input
          id="comm-to"
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Recipient email"
        />
        {!ownerHasEmail && (
          <p className="text-xs text-destructive">
            This owner doesn&apos;t have an email on file , type one above to
            send anyway. It won&apos;t be saved to the owner&apos;s details.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="comm-subject">Subject</Label>
        <Input
          id="comm-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="comm-body">Message</Label>
        <Textarea
          id="comm-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your message…"
          rows={8}
          className="max-h-72 resize-none overflow-y-auto"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Attachments</Label>
          <span className="text-xs text-muted-foreground">
            {attachments.length}/{MAX_ATTACHMENTS} · max 8MB each
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={attachments.length >= MAX_ATTACHMENTS}
        >
          <Paperclip className="mr-1.5 h-3.5 w-3.5" />
          Add files
        </Button>
        {attachments.length > 0 && (
          <ul className="space-y-1.5 pt-1">
            {attachments.map((a, idx) => (
              <li
                key={`${a.file.name}-${idx}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
              >
                <span className="truncate text-foreground">{a.file.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(idx)}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${a.file.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </EditSheet>
  );
}

// ─── Send SMS drawer ────────────────────────────────────────────────────────
// GSM-7 character + segment math (per Mobile Message). The "extended set"
// characters (curly braces, pipe, backslash, tilde, caret, euro) eat 2 chars
// each because GSM-7 encodes them with an escape byte. Anything outside the
// supported set blocks the send: no Unicode / emoji / non-Latin scripts.

const GSM7_SINGLE = new Set(
  // Letters (caseless), digits, the basic GSM-7 punctuation, accented Euro
  // characters, lowercase Greek that GSM-7 supports directly. Whitespace
  // (space, newline, carriage return, tab) counts as 1.
  [
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ..." \n\r\t",
    ...".,?!:;'\"-_/&@#%$*+=()<>§",
    ..."äöüñéèìòùàÄÖÜÆæßÉ",
    ..."αβγδεζηικλμνξοπρστυφχψω", // lowercase Greek subset present in GSM-7
  ],
);
const GSM7_EXTENDED = new Set([..."[]{}|\\~^€"]);

type SmsCounted = {
  units: number;
  segments: number;
  costCents: number;
  invalidChars: string[];
};

function countSmsUnits(body: string): SmsCounted {
  let units = 0;
  const invalid: string[] = [];
  for (const ch of body) {
    if (GSM7_SINGLE.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else if (ch && !invalid.includes(ch)) invalid.push(ch);
  }
  // Mobile Message rule: ≤160 units = 1 segment; otherwise 153 per segment.
  const segments = units === 0
    ? 0
    : units <= 160
      ? 1
      : Math.ceil(units / 153);
  return { units, segments, costCents: segments * 3, invalidChars: invalid };
}

function SendSmsDrawer({
  ocId,
  lotId,
  ownerPhone,
  initialSenderId,
  onClose,
  onSaved,
}: {
  ocId: string;
  lotId: string;
  ownerPhone: string | null;
  initialSenderId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Preloaded server-side and threaded through lot-detail-content.tsx so
  // the "From" line under the recipient field paints on first frame
  // instead of needing a client-side fetch on every drawer open.
  void initialSenderId;
  const [phone, setPhone] = React.useState(ownerPhone ?? "");
  const [body, setBody] = React.useState("");
  const [billConsent, setBillConsent] = React.useState(false);
  const ownerHasPhone = !!(ownerPhone && ownerPhone.trim());

  const counted = countSmsUnits(body);
  const hasInvalid = counted.invalidChars.length > 0;
  const costLabel = `${counted.costCents}c`;

  return (
    <EditSheet
      label="Send SMS"
      headerKicker={null}
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      renderTrigger={() => <span />}
      saveLabel="Send SMS"
      successToast="SMS sent"
      disabled={!billConsent || hasInvalid || counted.units === 0}
      onSave={async () => {
        if (!phone.trim())
          return { ok: false as const, error: "Recipient mobile is required." };
        if (!body.trim())
          return { ok: false as const, error: "Message body is required." };
        if (hasInvalid)
          return {
            ok: false as const,
            error: `Unsupported character: ${counted.invalidChars.join(" ")}`,
          };
        if (!billConsent)
          return {
            ok: false as const,
            error: "Confirm the billing checkbox to send.",
          };
        const res = await sendLotSms({
          oc_id: ocId,
          lot_id: lotId,
          recipient_phone: phone,
          body,
          confirmed: true,
        });
        if (res.ok) onSaved();
        return res.ok
          ? { ok: true as const }
          : { ok: false as const, error: res.error };
      }}
    >
      <div className="space-y-1.5">
        <Label>
          To <span className="text-destructive">*</span>
        </Label>
        <PhoneInput value={phone} onChange={setPhone} />
        {!ownerHasPhone && (
          <p className="text-xs text-destructive">
            This owner doesn&apos;t have a mobile on file , enter one above to
            send. It won&apos;t be saved to the owner&apos;s details.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label>
            Message <span className="text-destructive">*</span>
          </Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {counted.units} chars · {counted.segments} segment
            {counted.segments === 1 ? "" : "s"}
          </span>
        </div>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your SMS…"
          rows={6}
          className="max-h-60 resize-none overflow-y-auto"
        />
        {hasInvalid && (
          <p className="text-xs text-destructive">
            Unsupported character{counted.invalidChars.length === 1 ? "" : "s"}:{" "}
            <span className="font-mono">
              {counted.invalidChars.join(" ")}
            </span>
            . Remove emoji / non-Latin text before sending.
          </p>
        )}
      </div>

      <div className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={billConsent}
          onCheckedChange={(v) => setBillConsent(v === true)}
          className="mt-0.5 bg-card"
        />
        <span className="text-foreground">
          I understand I will be billed{" "}
          <span className="font-semibold text-[color:var(--brand-gold)]">
            {costLabel}
          </span>{" "}
          for this SMS.
        </span>
      </div>
    </EditSheet>
  );
}

// ─── Log call drawer ────────────────────────────────────────────────────────

function LogCallDrawer({
  ocId,
  lotId,
  ownerPhone,
  onClose,
  onSaved,
}: {
  ocId: string;
  lotId: string;
  ownerPhone: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [phone, setPhone] = React.useState(ownerPhone ?? "");
  const [direction, setDirection] = React.useState<"" | "outbound" | "inbound">(
    "",
  );
  const [callDate, setCallDate] = React.useState<string>(() => {
    // Default to today (ISO yyyy-mm-dd).
    return new Date().toISOString().slice(0, 10);
  });
  const [durationMinutes, setDurationMinutes] = React.useState<string>("");
  const [notes, setNotes] = React.useState("");

  return (
    <EditSheet
      label="Log phone call"
      description="Record a call you've already had with this owner."
      headerKicker={null}
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      renderTrigger={() => <span />}
      saveLabel="Save call log"
      successToast="Phone call logged"
      onSave={async () => {
        if (!direction)
          return { ok: false as const, error: "Please choose Inbound or Outbound." };
        if (!phone.trim())
          return { ok: false as const, error: "Phone number is required." };
        if (!notes.trim())
          return { ok: false as const, error: "Please add a short note." };
        const durationSeconds = durationMinutes.trim()
          ? Math.round(parseFloat(durationMinutes) * 60)
          : null;
        const res = await logPhoneCall({
          oc_id: ocId,
          lot_id: lotId,
          recipient_phone: phone,
          direction,
          // The day the call actually happened , recorded on sent_at on the
          // server. The row's created_at (always "now") is the audit-trail
          // "logged on" date, kept separate.
          call_date: callDate || undefined,
          duration_seconds: durationSeconds,
          notes,
        });
        if (res.ok) onSaved();
        return res.ok
          ? { ok: true as const }
          : { ok: false as const, error: res.error };
      }}
    >
      <div className="space-y-1.5">
        <Label>
          Direction <span className="text-destructive">*</span>
        </Label>
        <Select
          value={direction}
          onValueChange={(v) => setDirection(v as "outbound" | "inbound")}
        >
          {/* Wider trigger so the trailing hint ("(I called them)" / "(they
              called me)") never truncates. base-ui's <SelectValue> defaults
              to the raw value string when SelectItem children are not
              registered with a label , we override via a child render so the
              trigger reads as "Outbound", not "outbound". */}
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose direction">
              {direction === "outbound"
                ? "Outbound (I called them)"
                : direction === "inbound"
                  ? "Inbound (they called me)"
                  : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="min-w-[18rem]">
            <SelectItem value="outbound">Outbound (I called them)</SelectItem>
            <SelectItem value="inbound">Inbound (they called me)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>
          Phone number <span className="text-destructive">*</span>
        </Label>
        <PhoneInput value={phone} onChange={setPhone} />
      </div>

      <div className="space-y-1.5">
        <Label>Call date</Label>
        <DatePicker value={callDate} onChange={setCallDate} />
      </div>

      <div className="space-y-1.5">
        <Label>Duration (minutes)</Label>
        <NumberInput
          value={durationMinutes}
          onChange={setDurationMinutes}
          placeholder="Duration in minutes"
          allowDecimal
        />
      </div>

      <div className="space-y-1.5">
        <Label>Notes</Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What did you talk about?"
          rows={6}
          className="max-h-60 resize-none overflow-y-auto"
        />
      </div>

    </EditSheet>
  );
}

