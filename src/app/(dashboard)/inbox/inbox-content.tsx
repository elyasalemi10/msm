"use client";

import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Inbox,
  Check,
  RefreshCw,
  FileText,
  Shield,
  CalendarDays,
  Mail,
  Info,
  ArrowLeft,
  Reply,
  Loader2,
  Link as LinkIcon,
  Trash2,
  ChevronDown,
  Paperclip,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { EditSheet } from "@/components/shared/edit-sheet";
import { EmptyState } from "@/components/shared/empty-state";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatDateLong } from "@/lib/utils";
import {
  markAsRead,
  markAllAsRead,
  type Notification,
} from "@/lib/actions/notifications";
import {
  getInboxEmail,
  replyToInboxEmail,
  associateInboxEmailToLot,
  removeInboxEmail,
  type InboxEmailDetail,
  type PersonOwnershipOption,
} from "@/lib/actions/inbox-email";

const TYPE_ICONS: Record<string, typeof FileText> = {
  levy_issued: FileText,
  insurance_expiry: Shield,
  meeting_notice: CalendarDays,
  invitation: Mail,
  payment_received: FileText,
  email_reply: Mail,
  system: Info,
};

const TYPE_COLORS: Record<string, string> = {
  levy_issued: "bg-blue-50 text-blue-600",
  insurance_expiry: "bg-amber-50 text-amber-600",
  meeting_notice: "bg-purple-50 text-purple-600",
  invitation: "bg-green-50 text-green-600",
  payment_received: "bg-emerald-50 text-emerald-600",
  email_reply: "bg-[color:var(--brand-gold)]/15 text-[color:var(--brand-gold)]",
  system: "bg-muted text-muted-foreground",
};

// Provider hint comes from the SERVER (inbox metadata + gmail_mailbox_subscriptions
// lookup) , NOT from the sender's email domain. A reply from any address still
// arrived via the Gmail webhook, so the Gmail glyph is what reflects "how it
// got here." Sender-domain inference was misleading (a gmail-pushed reply
// from joe@randomfirm.com was rendering as a generic mail icon).
type Provider = "gmail" | null;

function ProviderIcon({
  provider,
  size = "sm",
}: {
  provider: Provider;
  size?: "sm" | "md";
}) {
  const px = size === "md" ? 20 : 14;
  const klass = cn(size === "md" ? "size-5" : "size-3.5", "object-contain");
  if (provider === "gmail") {
    return <Image src="/logos/gmail.webp" alt="Gmail" width={px} height={px} className={klass} />;
  }
  return <Mail className={cn(size === "md" ? "size-5" : "size-3.5", "text-muted-foreground")} />;
}

// Compact one-line preview text: strip the obvious markdown / HTML
// noise so notification rows don't read like `**Message not delivered**`.
// Used for list-row + bell-dropdown previews , the full body still
// gets the proper ReactMarkdown render in the detail pane.
function stripMarkdownForPreview(s: string | null | undefined): string {
  if (!s) return "";
  return s
    // Strip ** / __ bold / italic markers
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    // Strip [text](href) link markdown → keep `text`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Strip leading > quote / # heading markers
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*#{1,6}\s?/gm, "")
    // Strip backtick code fences
    .replace(/`+/g, "")
    // Collapse runs of whitespace + newlines into single spaces.
    .replace(/\s+/g, " ")
    .trim();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDateLong(dateStr);
}

export function InboxContent({
  notifications: initial,
  rowProviders,
  prefetchedEmails,
  allOwnerships,
}: {
  notifications: Notification[];
  rowProviders: Record<string, "gmail">;
  // Pre-fetched detail for the top N unread email_reply rows so opening
  // any of them is instant (no "Loading email…" flash). Anything not in
  // this map falls back to getInboxEmail() on demand.
  prefetchedEmails: Record<string, InboxEmailDetail>;
  // Eager-loaded ownership list for the firm , drives the link-to-lot
  // popover with zero per-keystroke server traffic.
  allOwnerships: PersonOwnershipOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [notifications, setNotifications] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  // Manual + auto refresh. `refreshing` drives the button's spinner;
  // `lastRefreshAt` is updated after each successful refresh so the
  // "Refreshed Xs ago" label stays honest. Auto-poll fires every 60s
  // when the tab is visible (skipped when the user has tabbed away).
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(() => Date.now());

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    router.refresh();
    setLastRefreshAt(Date.now());
    // router.refresh() resolves synchronously; the server fetch happens
    // out of band. Drop the spinner after a short delay so users see
    // it long enough to register the click.
    window.setTimeout(() => setRefreshing(false), 600);
  }, [router]);

  // Auto-refresh every 60s while the tab is visible. Pause when hidden
  // so background tabs don't keep hitting the server. The visibility
  // listener also fires an immediate refresh when the tab is re-shown
  // (managers who come back after lunch get fresh state instantly).
  useEffect(() => {
    const POLL_MS = 60_000;
    let intervalId: number | null = null;
    function start() {
      if (intervalId != null) return;
      intervalId = window.setInterval(() => {
        if (!document.hidden) {
          router.refresh();
          setLastRefreshAt(Date.now());
        }
      }, POLL_MS);
    }
    function stop() {
      if (intervalId != null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    }
    function onVisibilityChange() {
      if (document.hidden) {
        stop();
      } else {
        // Re-show → fresh data + restart the poll.
        router.refresh();
        setLastRefreshAt(Date.now());
        start();
      }
    }
    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  // Sync local notifications with server-rendered prop after every
  // router.refresh , without this the auto-refresh runs but the list
  // stays stale because we never read the new prop.
  useEffect(() => {
    setNotifications(initial);
  }, [initial]);

  // Sync the open notification with `?n=<id>`.
  const urlOpenId = searchParams.get("n");
  useEffect(() => {
    if (urlOpenId && urlOpenId !== openId) {
      setOpenId(urlOpenId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlOpenId]);

  const unreadCount = notifications.filter((n) => !n.read_at).length;
  const openNotification = notifications.find((n) => n.id === openId) ?? null;

  async function handleOpen(notification: Notification) {
    setOpenId(notification.id);
    const url = new URL(window.location.href);
    url.searchParams.set("n", notification.id);
    window.history.replaceState(null, "", url.toString());
    if (!notification.read_at) {
      await markAsRead(notification.id);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notification.id
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        ),
      );
    }
  }

  function handleClose() {
    setOpenId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("n");
    window.history.replaceState(null, "", url.toString());
  }

  async function handleMarkAllRead() {
    await markAllAsRead();
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })),
    );
  }

  async function handleRemove(notificationId: string) {
    const res = await removeInboxEmail(notificationId);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    if (openId === notificationId) {
      handleClose();
    }
    toast.success("Removed from inbox");
  }

  if (notifications.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="All caught up"
        description="You'll receive notifications here for levy notices, owner replies, insurance alerts, meetings, and more."
      />
    );
  }

  return (
    <div className="grid h-[calc(100vh-7rem)] grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
      <Card
        className={cn(
          "flex flex-col overflow-hidden h-full lg:sticky lg:top-4",
          openNotification && "hidden lg:flex",
        )}
      >
        <CardContent className="p-0 flex flex-col min-h-0 flex-1">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 shrink-0">
            <p className="text-xs text-muted-foreground">
              {unreadCount > 0 ? `${unreadCount} unread` : `${notifications.length} total`}
            </p>
            <div className="flex items-center gap-1">
              {/* Manual refresh , checks for new inbound mail without
                  changing read state. Auto-refresh fires every 60s in
                  the background; this button is the manager's escape
                  hatch when something arrives mid-call. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                className="h-7 cursor-pointer text-xs"
                title={`Last refreshed ${Math.max(0, Math.round((Date.now() - lastRefreshAt) / 1000))}s ago`}
              >
                <RefreshCw className={`mr-1 size-3 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleMarkAllRead}
                  className="h-7 cursor-pointer text-xs"
                >
                  <Check className="mr-1 size-3" />
                  Mark all read
                </Button>
              )}
            </div>
          </div>
          {/* Scroll-hidden list , content fills the panel and you scroll by
              wheel / touchpad / arrow keys. No visible bar (matches the
              global no-scrollbar treatment for body / dashboard <main>). */}
          <div className="divide-y divide-border flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {notifications.map((n) => {
              const Icon = TYPE_ICONS[n.type] ?? Info;
              const isUnread = !n.read_at;
              const isOpen = n.id === openId;
              const provider = rowProviders[n.id] ?? null;
              const showProvider = n.type === "email_reply";

              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleOpen(n)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors cursor-pointer",
                    isOpen
                      ? "bg-primary/10"
                      : isUnread
                        ? "bg-primary/5 hover:bg-primary/10"
                        : "hover:bg-muted/30",
                  )}
                >
                  <div className="flex h-8 w-8 items-center justify-center shrink-0">
                    {showProvider ? (
                      <ProviderIcon provider={provider} size="md" />
                    ) : (
                      <Icon className={cn(
                        "h-4 w-4",
                        // Tint matches the previous chip background's accent so the row
                        // still communicates type at a glance, just without the circle.
                        (TYPE_COLORS[n.type] ?? TYPE_COLORS.system).split(" ").find((c) => c.startsWith("text-")) ?? "text-muted-foreground",
                      )} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p
                        className={cn(
                          "text-sm truncate",
                          isUnread
                            ? "font-semibold text-foreground"
                            : "text-foreground",
                        )}
                      >
                        {n.title}
                      </p>
                      <span className="ml-auto text-xs text-muted-foreground/60 shrink-0">
                        {timeAgo(n.created_at)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {stripMarkdownForPreview(n.message)}
                    </p>
                  </div>
                  {isUnread && (
                    <div className="h-2 w-2 rounded-full bg-primary shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className={cn("min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", !openNotification && "hidden lg:block")}>
        {openNotification ? (
          openNotification.type === "email_reply" ? (
            <EmailDetailPane
              key={openNotification.id}
              notification={openNotification}
              onBack={handleClose}
              onRemove={() => handleRemove(openNotification.id)}
              prefetched={prefetchedEmails[openNotification.id] ?? null}
              allOwnerships={allOwnerships}
            />
          ) : (
            <GenericDetailPane
              notification={openNotification}
              onBack={handleClose}
              onRouteTo={(href) => router.push(href)}
            />
          )
        ) : (
          <Card>
            <CardContent className="flex h-full min-h-[20rem] flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Mail className="size-10 text-muted-foreground/40" />
              <p>Pick an email from the list to read it.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── Generic (non-email) detail pane ──────────────────────────────────────

function GenericDetailPane({
  notification,
  onBack,
  onRouteTo,
}: {
  notification: Notification;
  onBack: () => void;
  onRouteTo: (href: string) => void;
}) {
  const Icon = TYPE_ICONS[notification.type] ?? Info;
  return (
    <Card>
      <CardContent className="pt-5">
        <BackBar onBack={onBack} compact />
        <div className="flex items-start gap-3 pb-4 border-b border-border">
          <Icon className={cn(
            "h-5 w-5 mt-0.5 shrink-0",
            (TYPE_COLORS[notification.type] ?? TYPE_COLORS.system).split(" ").find((c) => c.startsWith("text-")) ?? "text-muted-foreground",
          )} />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">
              {notification.title}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatDateLong(notification.created_at)}
            </p>
          </div>
        </div>
        <div className="pt-4">
          <p className="text-sm text-foreground leading-relaxed">
            {notification.message}
          </p>
        </div>
        {notification.link && (
          <div className="pt-4 mt-4 border-t border-border">
            <Button
              variant="default"
              size="sm"
              onClick={() => onRouteTo(notification.link!)}
            >
              View details
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Email detail pane ────────────────────────────────────────────────────

function EmailDetailPane({
  notification,
  onBack,
  onRemove,
  prefetched,
  allOwnerships,
}: {
  notification: Notification;
  onBack: () => void;
  onRemove: () => Promise<void> | void;
  prefetched: InboxEmailDetail | null;
  allOwnerships: PersonOwnershipOption[];
}) {
  const communicationLogId = (notification.metadata?.communication_log_id ??
    null) as string | null;
  // Seed with the server-prefetched detail so the first paint shows the
  // body instead of a loading spinner. We still re-fetch in the background
  // so stale prefetches (e.g. assoc was set in another tab) overwrite.
  const [detail, setDetail] = useState<InboxEmailDetail | null>(prefetched);
  const [error, setError] = useState<string | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);

  useEffect(() => {
    if (!communicationLogId) {
      setError("This notification isn't linked to an email.");
      return;
    }
    let cancelled = false;
    getInboxEmail(communicationLogId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setDetail(res.data);
        } else if (!prefetched) {
          // Only surface the error when we have nothing else to show.
          setError(res.error);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("getInboxEmail threw:", err);
        if (!prefetched) {
          setError("This email couldn't be loaded. Please refresh and try again.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communicationLogId]);

  if (error) {
    return (
      <Card>
        <CardContent className="pt-5 space-y-4">
          <BackBar onBack={onBack} compact />
          <EmptyState icon={Mail} title="Email unavailable" description={error} card={false} />
        </CardContent>
      </Card>
    );
  }

  if (!detail) {
    return (
      <Card>
        <CardContent className="pt-5 space-y-4">
          <BackBar onBack={onBack} compact />
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading email…
          </div>
        </CardContent>
      </Card>
    );
  }

  const provider = detail.inbox_provider;
  // Prefer the Gmail-internal messageId stashed on the notification , that
  // deep-links straight to the conversation. Falls back to a sender-keyed
  // search when older ingests didn't capture the id.
  const openInProviderUrl =
    provider === "gmail" && detail.gmail_message_id
      ? `https://mail.google.com/mail/u/0/#inbox/${detail.gmail_message_id}`
      : provider === "gmail"
        ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(detail.sender_email)}`
        : null;

  return (
    <TooltipProvider delay={120}>
      <Card>
        <CardContent className="pt-5 space-y-4">
          <BackBar onBack={onBack} compact />

          {/* Header */}
          <div className="flex items-start justify-between gap-3 pb-4 border-b border-border">
            <div className="flex items-start gap-3 min-w-0">
              <ProviderIcon provider={provider} size="md" />
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-foreground break-words">
                  {detail.subject || "(no subject)"}
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatDateLong(detail.sent_at ?? detail.created_at)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" onClick={() => setReplyOpen(true)}>
                <Reply className="mr-1.5 h-3.5 w-3.5" />
                Reply
              </Button>
              <LinkToLotPopover
                ownerships={allOwnerships}
                linkedKey={
                  detail.oc_id && detail.lot_id
                    ? `${detail.oc_id}:${detail.lot_id}`
                    : null
                }
                onPick={async (option) => {
                  const res = await associateInboxEmailToLot({
                    communicationLogId: detail.id,
                    oc_id: option.oc_id,
                    lot_id: option.lot_id,
                  });
                  if (res.ok) {
                    // The detail panel renders the "Lot:" line from
                    // `oc_short_code`, `lot_label`, and `lot_link_label` ,
                    // not just `oc_id` / `lot_id`. Update all of them
                    // locally so the panel reflects the new link without a
                    // server round-trip; otherwise the line keeps reading
                    // "Not associated" until the page is reloaded.
                    setDetail((d) =>
                      d
                        ? {
                            ...d,
                            oc_id: option.oc_id,
                            lot_id: option.lot_id,
                            oc_name: option.oc_name,
                            oc_short_code: option.oc_short_code,
                            lot_label: option.lot_label,
                            lot_link_label: `${option.oc_name} · ${option.lot_label}`,
                          }
                        : d,
                    );
                    toast.success(`Linked to ${option.owner_name} · ${option.lot_label}`);
                  } else {
                    toast.error(res.error);
                  }
                }}
              />
              {openInProviderUrl && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="secondary"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() =>
                          window.open(openInProviderUrl, "_blank", "noopener,noreferrer")
                        }
                      />
                    }
                  >
                    <Image src="/logos/gmail.webp" alt="" width={18} height={18} className="size-4 object-contain" />
                    <span className="sr-only">Open in Gmail</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Open the original in Gmail.
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="secondary"
                      size="icon"
                      className="h-9 w-9 text-destructive hover:text-destructive"
                      onClick={() => onRemove()}
                    />
                  }
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Remove from inbox</span>
                </TooltipTrigger>
                <TooltipContent>
                  Removes from your StrataWise inbox only , the original stays in
                  {provider === "gmail" ? " Gmail" : " your mailbox"}.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Address fields , inline label-prefixed style */}
          <div className="space-y-1.5 text-sm">
            <p className="text-foreground">
              <span className="text-muted-foreground">From: </span>
              <span className="font-medium break-all">
                {detail.sender_email || ","}
              </span>
            </p>
            <p className="text-foreground">
              <span className="text-muted-foreground">To: </span>
              <span className="break-all">{detail.recipient_email}</span>
            </p>
            <p className="text-foreground flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground">Lot: </span>
              {detail.oc_short_code && detail.lot_id ? (
                <a
                  href={`/ocs/${detail.oc_short_code}/lots/${detail.lot_id}?tab=communications`}
                  className="inline-flex items-center gap-1 text-blue-600 underline-offset-4 hover:underline"
                >
                  {detail.lot_link_label ?? "View lot"}
                  <LinkIcon className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-muted-foreground">Not associated</span>
              )}
            </p>
          </div>

        {/* Body , markdown-rendered. Emails from Gmail composers
            usually arrive as plain text but commonly contain markdown
            (auto-quoted links, bullet lists, *bold*) that managers expect
            to read formatted. remark-gfm picks up tables, autolinks, and
            strikethrough. */}
        <div className="rounded-md border border-border bg-cool-muted p-4 max-h-[40rem] overflow-y-auto text-sm leading-relaxed text-foreground prose prose-sm max-w-none prose-headings:text-foreground prose-strong:text-foreground prose-a:text-blue-600">
          {detail.body ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {detail.body}
            </ReactMarkdown>
          ) : (
            <p className="text-muted-foreground">(empty)</p>
          )}
        </div>

        {/* Original outbound thread, if matched */}
        {detail.outbound && (
          <details className="rounded-md border border-border bg-card">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              In reply to ,{" "}
              {detail.outbound.subject ?? "(no subject)"}
              {detail.outbound.sent_at && (
                <> · {formatDateLong(detail.outbound.sent_at)}</>
              )}
            </summary>
            <div className="border-t border-border p-3 text-sm text-muted-foreground prose prose-sm max-w-none prose-headings:text-foreground prose-a:text-blue-600">
              {detail.outbound.body ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {detail.outbound.body}
                </ReactMarkdown>
              ) : (
                "(no body)"
              )}
            </div>
          </details>
        )}

        {detail.attachments.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Attachments
            </p>
            <ul className="space-y-1">
              {detail.attachments.map((att) => (
                <li key={att.id}>
                  <a
                    href={`/api/inbox-attachments/${att.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={att.filename}
                    className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-muted/40 cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-foreground">{att.filename}</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatBytes(att.size_bytes)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        </CardContent>

        <ReplyDrawer
          open={replyOpen}
          onClose={() => setReplyOpen(false)}
          detail={detail}
          onSent={() => setReplyOpen(false)}
        />
      </Card>
    </TooltipProvider>
  );
}

function BackBar({ onBack, compact = false }: { onBack: () => void; compact?: boolean }) {
  return (
    <div className={cn(compact ? "lg:hidden" : "")}>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to inbox
      </button>
    </div>
  );
}

// ─── Reply drawer ────────────────────────────────────────────────────────

function ReplyDrawer({
  open,
  onClose,
  detail,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  detail: InboxEmailDetail;
  onSent: () => void;
}) {
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open) setBody("");
  }, [open]);

  if (!open) return null;
  return (
    <EditSheet
      label={`Reply to ${detail.sender_email || "owner"}`}
      description={
        detail.subject.toLowerCase().startsWith("re:")
          ? detail.subject
          : `Re: ${detail.subject}`
      }
      headerKicker={null}
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      renderTrigger={() => <span />}
      saveLabel="Send reply"
      successToast="Reply sent"
      onSave={async () => {
        if (!body.trim())
          return { ok: false as const, error: "Reply body is required." };
        const res = await replyToInboxEmail({
          communicationLogId: detail.id,
          body,
        });
        if (res.ok) onSent();
        return res.ok
          ? { ok: true as const }
          : { ok: false as const, error: res.error };
      }}
    >
      <div className="space-y-1.5">
        <Label>To</Label>
        <p className="rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground break-all">
          {detail.sender_email}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>Reply</Label>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your reply…"
          rows={10}
          className="max-h-80 resize-none overflow-y-auto"
        />
      </div>
    </EditSheet>
  );
}

// ─── Associate drawer (people search) ───────────────────────────────────
//
// Combobox of OWNERSHIPS , searchable by owner name, OC name, lot label,
// or email. Multi-lot owners surface as multiple rows. Selection writes
// (oc_id, lot_id) onto the inbound row so it appears on the lot's
// Communications tab; we don't store anything about the OWNER because
// documents/comms are lot-keyed in this codebase.

// LinkToLotPopover , inline combobox button. The popover sits anchored to
// the trigger (no overlay / page grey-out: Base UI's Popover doesn't
// render a backdrop by default, which is what we want). Vertical
// rectangle layout , narrow + tall , with a chevron arrow on the button.
//
// All ownerships for the firm are eager-loaded server-side and passed in
// via `ownerships`, so search filters client-side with no network hit.
// We still show a tiny spinner during a typed search to acknowledge the
// keystroke; the underlying filter is synchronous but the spinner gives
// the input some life.
//
// When already linked, the button shows the linked lot's label
// (e.g. "Joe Smith · Lot 12") instead of "Change lot" , so the manager
// reads the current state without having to open the popover.
function LinkToLotPopover({
  ownerships,
  linkedKey,
  onPick,
}: {
  ownerships: PersonOwnershipOption[];
  linkedKey: string | null;
  onPick: (option: PersonOwnershipOption) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Synthetic spinner , pulses for ~200ms after each keystroke so the
  // search feels alive even though filtering is local.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!query) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => setSearching(false), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  // Local case-insensitive substring filter across owner / lot / oc / PS.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ownerships;
    return ownerships.filter((p) => {
      const haystack = `${p.owner_name} ${p.lot_label} ${p.oc_name} ${p.oc_short_code} ${p.owner_email ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, ownerships]);

  const linked = linkedKey
    ? ownerships.find((p) => p.key === linkedKey) ?? null
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            size="sm"
            className="max-w-64 justify-between gap-2"
          />
        }
      >
        <span className="inline-flex items-center gap-1.5 truncate min-w-0">
          <LinkIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {linked
              ? `${linked.owner_name} · ${linked.lot_label}`
              : "Link to lot"}
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        showBackdrop={false}
        className="w-72 p-0 flex flex-col max-h-[28rem]"
      >
        <Command shouldFilter={false} className="flex-1 min-h-0">
          <div className="relative">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search owner, lot, PS…"
            />
            {searching && (
              <Loader2 className="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
          <CommandList className="max-h-[24rem]">
            {filtered.length === 0 ? (
              <CommandEmpty>No matching owners.</CommandEmpty>
            ) : (
              <CommandGroup>
                {filtered.map((p) => (
                  <CommandItem
                    key={p.key}
                    value={p.key}
                    onSelect={async () => {
                      setOpen(false);
                      await onPick(p);
                    }}
                    className={cn(
                      // Compact one-line row , owner / lot / PS on a single
                      // line so the popover fits more without scrolling.
                      "flex items-center gap-1.5 py-1 text-sm",
                      linkedKey === p.key && "bg-primary/10",
                    )}
                  >
                    <span className="font-medium text-foreground truncate min-w-0 flex-1">
                      {p.owner_name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate">
                      {p.lot_label}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">
                      {p.oc_short_code}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
