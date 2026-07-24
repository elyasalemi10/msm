"use client";

// ============================================================================
// Global route progress bar + stale-while-revalidate refresher.
// ----------------------------------------------------------------------------
// Two halves of one idea: pages render instantly from the client router cache
// (see experimental.staleTimes in next.config.ts), then quietly re-fetch
// themselves in the background so what you're looking at catches up. The bar
// across the top is the only tell that the second half is happening.
//
// The bar is driven by a ref-counted module store rather than context, so any
// component anywhere can light it up for its own slow work:
//
//   const done = startRouteProgress();
//   try { await somethingSlow(); } finally { done(); }
//
// Mounted once in the root layout , don't render it per-page.
// ============================================================================

import { Suspense, useCallback, useEffect, useRef, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// ─── Ref-counted progress store ───────────────────────────────────────

let activeCount = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Show the top progress bar until the returned function is called. Safe to
 * call from anywhere, and safe to call the finisher twice (second is a
 * no-op), so it can live in a `finally`.
 */
export function startRouteProgress(): () => void {
  activeCount += 1;
  emit();
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    activeCount = Math.max(0, activeCount - 1);
    emit();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const getSnapshot = () => activeCount;
const getServerSnapshot = () => 0;

// ─── The bar ──────────────────────────────────────────────────────────

// Creeps toward CEILING while work is in flight , it can never predict a
// real percentage, so it eases toward "nearly there" and only hits 100 when
// the work actually finishes.
const CEILING = 92;
const TICK_MS = 160;
const EASE = 0.12;
const FINISH_MS = 280;

function ProgressBar() {
  const active = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const barRef = useRef<HTMLDivElement>(null);
  // Width lives in a ref and is written straight to the node. React never
  // sees a `style` prop for this element, so a re-render can't stomp the
  // animation mid-flight, and the 6-a-second ticks don't re-render anything.
  const widthRef = useRef(0);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;

    const paint = () => {
      el.style.width = `${widthRef.current}%`;
      el.style.opacity = widthRef.current > 0 ? "1" : "0";
    };

    if (active > 0) {
      // Resume from wherever the previous run left off so back-to-back work
      // doesn't visibly restart the bar.
      if (!(widthRef.current > 0 && widthRef.current < 100)) widthRef.current = 8;
      paint();
      const id = setInterval(() => {
        if (widthRef.current < CEILING) {
          widthRef.current += (CEILING - widthRef.current) * EASE;
          paint();
        }
      }, TICK_MS);
      return () => clearInterval(id);
    }

    // Nothing in flight. Snap to full then fade out, but only if a bar was
    // actually showing , otherwise this is just the idle state.
    if (widthRef.current === 0) return;
    widthRef.current = 100;
    paint();
    const id = setTimeout(() => {
      widthRef.current = 0;
      paint();
    }, FINISH_MS);
    return () => clearTimeout(id);
  }, [active]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5"
    >
      <div
        ref={barRef}
        className="h-full w-0 rounded-r-full bg-[color:var(--brand-gold)] opacity-0 shadow-[0_0_8px_color-mix(in_srgb,var(--brand-gold)_70%,transparent)] transition-[width,opacity] duration-200 ease-out"
      />
    </div>
  );
}

// ─── Navigation tracking ──────────────────────────────────────────────
// The App Router has no navigation events, so: start on the thing that
// begins a navigation (a link click, a popstate, a programmatic push) and
// finish when the URL actually settles.

// Nothing should keep the bar up this long. If a navigation is cancelled
// (guard redirect, blocked route) the bar would otherwise sit there forever.
const STUCK_MS = 10_000;

function NavigationWatcher() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pendingRef = useRef<(() => void) | null>(null);
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finish = useCallback(() => {
    if (stuckTimer.current) {
      clearTimeout(stuckTimer.current);
      stuckTimer.current = null;
    }
    pendingRef.current?.();
    pendingRef.current = null;
  }, []);

  const begin = useCallback(() => {
    if (pendingRef.current) return; // already following a navigation
    pendingRef.current = startRouteProgress();
    stuckTimer.current = setTimeout(finish, STUCK_MS);
  }, [finish]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented) return;
      // Let the browser handle modified clicks , they open new tabs/windows
      // and never navigate this document.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target as Element | null;
      const anchor = target?.closest?.("a");
      if (!anchor) return;
      if (anchor.hasAttribute("download") || (anchor.getAttribute("target") ?? "") === "_blank") return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same page (or a hash on it) never re-renders anything.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      begin();
    }

    // Back / forward. Next handles the navigation; we only need the cue.
    function onPopState() {
      begin();
    }

    // router.push() lands here rather than in a click. NOT replaceState ,
    // the tab strips across the app use it to sync ?tab= without navigating,
    // which would leave the bar running with no URL change to finish it.
    const originalPushState = window.history.pushState;
    window.history.pushState = (...args: Parameters<History["pushState"]>) => {
      begin();
      return originalPushState.apply(window.history, args);
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      window.history.pushState = originalPushState;
    };
  }, [begin]);

  // The URL settling is the only reliable "we got there" signal.
  useEffect(() => {
    finish();
  }, [pathname, searchParams, finish]);

  return null;
}

// ─── Stale-while-revalidate ───────────────────────────────────────────
// staleTimes lets the router re-show a page from cache with no server round
// trip, which is what makes navigation feel instant. The trade is that the
// content can be a couple of minutes old, so on arrival we re-fetch it in a
// transition: React keeps the stale page on screen and swaps in the fresh
// one when it lands. Same deal when the tab regains focus.

/** Last time each URL was known-fresh, keyed by pathname + query. Module
 *  scope so it survives the component remounting on every navigation. */
const lastLoadedAt = new Map<string, number>();
/** A long session shouldn't accumulate a key per URL visited. Map iterates
 *  in insertion order, so dropping from the front sheds the oldest. */
const MAX_TRACKED_URLS = 100;

function markLoaded(key: string, at: number) {
  lastLoadedAt.set(key, at);
  while (lastLoadedAt.size > MAX_TRACKED_URLS) {
    const oldest = lastLoadedAt.keys().next().value;
    if (oldest === undefined) break;
    lastLoadedAt.delete(oldest);
  }
}

/** Arriving back within this window means the cached copy is new enough. */
const ARRIVAL_MIN_AGE_MS = 10_000;
/** Refocusing a tab left open for longer than this re-fetches it. */
const FOCUS_MIN_AGE_MS = 30_000;

/** Routes where a background refresh is pointless or unwelcome: multi-step
 *  wizards and long-form editors own their state client-side, and the auth
 *  screens have nothing to re-fetch. */
const SKIP_REVALIDATE = ["/ocs/new", "/admin/blog/", "/onboarding", "/sign-in", "/sign-up", "/invite/"];

function StaleWhileRevalidate() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const doneRef = useRef<(() => void) | null>(null);

  const key = `${pathname}?${searchParams}`;
  const skip = SKIP_REVALIDATE.some((prefix) => pathname.startsWith(prefix));

  const revalidate = useCallback(() => {
    if (doneRef.current) return; // one in flight is enough
    doneRef.current = startRouteProgress();
    markLoaded(key, Date.now());
    startTransition(() => {
      router.refresh();
    });
  }, [key, router]);

  // On arrival: anything we've rendered before came from the router cache,
  // so it's stale by definition. A first visit was just fetched , leave it.
  useEffect(() => {
    if (skip) return;
    const previous = lastLoadedAt.get(key);
    const now = Date.now();
    if (previous === undefined) {
      markLoaded(key, now);
      return;
    }
    if (now - previous < ARRIVAL_MIN_AGE_MS) {
      markLoaded(key, now);
      return;
    }
    revalidate();
  }, [key, skip, revalidate]);

  // Coming back to a tab that's been sitting open.
  useEffect(() => {
    if (skip) return;
    function onFocus() {
      if (document.visibilityState !== "visible") return;
      const previous = lastLoadedAt.get(key);
      if (previous !== undefined && Date.now() - previous < FOCUS_MIN_AGE_MS) return;
      revalidate();
    }
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, skip, revalidate]);

  // The transition going idle is how we know the fresh payload has been
  // applied , that's when the bar can complete.
  useEffect(() => {
    if (!isPending && doneRef.current) {
      markLoaded(key, Date.now());
      doneRef.current();
      doneRef.current = null;
    }
  }, [isPending, key]);

  return null;
}

// ─── Public component ─────────────────────────────────────────────────

export function RouteProgress() {
  return (
    <>
      <ProgressBar />
      {/* useSearchParams needs a boundary so it can't drag a whole route
          into client rendering. Nothing here renders UI, so `null`. */}
      <Suspense fallback={null}>
        <NavigationWatcher />
        <StaleWhileRevalidate />
      </Suspense>
    </>
  );
}
