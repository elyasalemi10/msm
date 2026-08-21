"use client";

import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Bell, Check, FileText, Shield, CalendarDays, Mail, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getNotifications, getUnreadCount, markAsRead, markAllAsRead, type Notification } from "@/lib/actions/notifications";
import { resolveInboxRowProviders } from "@/lib/actions/inbox-email";

const TYPE_ICONS: Record<string, typeof FileText> = {
  levy_issued: FileText,
  insurance_expiry: Shield,
  meeting_notice: CalendarDays,
  invitation: Mail,
  email_reply: Mail,
  system: Info,
};

const TYPE_COLORS: Record<string, string> = {
  levy_issued: "text-blue-600",
  insurance_expiry: "text-amber-600",
  meeting_notice: "text-purple-600",
  invitation: "text-green-600",
  payment_received: "text-emerald-600",
  email_reply: "text-[color:var(--brand-gold)]",
  system: "text-muted-foreground",
};

// Renders the provider glyph (Gmail) for email_reply rows, falling
// back to the type icon for everything else.
function NotifIcon({
  type,
  provider,
}: {
  type: string;
  provider: "gmail" | null | undefined;
}) {
  if (type === "email_reply") {
    if (provider === "gmail") {
      return <Image src="/logos/gmail.webp" alt="Gmail" width={16} height={16} className="size-4 object-contain" />;
    }
  }
  const Icon = TYPE_ICONS[type] ?? Info;
  const tint = TYPE_COLORS[type] ?? "text-muted-foreground";
  return <Icon className={cn("size-4", tint)} />;
}

// Strip obvious markdown noise (** __ [text](url) > # `) from preview
// strings so a Gmail-bounce snippet doesn't render as `**Message not
// delivered**`. Detail panes still render the full body via
// ReactMarkdown , this is for tiny inline previews only.
function stripMarkdownForPreview(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*#{1,6}\s?/gm, "")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  return new Date(dateStr).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [providers, setProviders] = useState<Record<string, "gmail">>({});
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch BOTH the unread count AND the most-recent notifications on
  // mount so the dropdown shows real content the first time it's opened
  // instead of an "empty" flash that gets replaced 200ms later. Then
  // refresh both every 60 seconds while the tab is visible. Pauses on
  // tab-hidden, resumes immediately on visibility-change.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      Promise.all([getUnreadCount(), getNotifications(15)]).then(
        async ([count, rows]) => {
          if (cancelled) return;
          setUnreadCount(count);
          setNotifications(rows);
          setLoaded(true);
          // Resolve the Gmail provider for any email_reply rows so the
          // dropdown shows the right glyph instead of the generic Mail icon.
          if (rows.some((r) => r.type === "email_reply")) {
            try {
              const p = await resolveInboxRowProviders(rows);
              if (!cancelled) setProviders(p);
            } catch {
              // non-fatal
            }
          }
        },
      );
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Re-fetch when the dropdown opens so stale rows are replaced fast.
  useEffect(() => {
    if (open) {
      getNotifications(15).then(setNotifications);
    }
  }, [open]);

  // Click outside to close
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  async function handleClick(notification: Notification) {
    if (!notification.read_at) {
      await markAsRead(notification.id);
      setNotifications((prev) =>
        prev.map((n) => n.id === notification.id ? { ...n, read_at: new Date().toISOString() } : n)
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    // email_reply notifications ALWAYS go to /inbox?n=<id>, ignoring any
    // legacy `link` stored on the row (older rows pointed at the lot's
    // communications tab, which double-navigated and bounced to /dashboard).
    const target =
      notification.type === "email_reply"
        ? `/inbox?n=${notification.id}`
        : notification.link;
    if (target) {
      router.push(target);
      setOpen(false);
    }
  }

  async function handleMarkAllRead() {
    await markAllAsRead();
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnreadCount(0);
  }

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="size-5" />
        {loaded && unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
        <span className="sr-only">Notifications</span>
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-80 rounded-lg border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95 duration-100">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <p className="text-sm font-semibold text-foreground">Notifications</p>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 cursor-pointer"
              >
                <Check className="h-3 w-3" />
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-3 py-8 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/30 mx-auto" />
                <p className="mt-2 text-sm text-muted-foreground">No notifications yet</p>
              </div>
            ) : (
              notifications.map((n) => {
                const provider = providers[n.id] ?? null;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleClick(n)}
                    className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors cursor-pointer border-b border-border/50 last:border-b-0 ${
                      !n.read_at
                        ? "bg-primary/5 hover:bg-primary/10"
                        : "bg-muted/40 hover:bg-muted/60"
                    }`}
                  >
                    <div className="flex h-7 w-7 items-center justify-center shrink-0 mt-0.5">
                      <NotifIcon type={n.type} provider={provider} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${
                        !n.read_at ? "font-medium text-foreground" : "text-muted-foreground"
                      }`}>
                        {n.title}
                      </p>
                      <p className={`text-xs mt-0.5 line-clamp-2 ${
                        !n.read_at ? "text-muted-foreground" : "text-muted-foreground/70"
                      }`}>{stripMarkdownForPreview(n.message)}</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">{timeAgo(n.created_at)}</p>
                    </div>
                    {!n.read_at && (
                      <div className="h-2 w-2 rounded-full bg-primary shrink-0 mt-2" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {notifications.length > 0 && (
            <div className="border-t border-border px-3 py-2">
              <button
                type="button"
                onClick={() => { router.push("/inbox"); setOpen(false); }}
                className="text-xs text-primary hover:text-primary/80 cursor-pointer w-full text-center"
              >
                View all notifications
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
