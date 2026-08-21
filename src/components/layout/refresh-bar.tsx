"use client";

// ============================================================================
// Refresh bar + stale-while-revalidate.
// ----------------------------------------------------------------------------
// Every data page here works the same way: arriving at a page you have been
// to before renders the last data instantly out of the client router cache
// (see experimental.staleTimes in next.config.ts), then quietly fetches the
// current version behind it.
//
// That leaves one honest question unanswered: is what I'm looking at current?
// Without an answer you get one of two bad outcomes, a blank loading wall on
// every revisit, or silently stale numbers with no hint they're being checked.
//
// The bar is the answer. It means "this is your last data, and I'm fetching
// the latest right now."
//
// THE BAR DOES NOT TRACK NAVIGATION. An earlier version hooked link clicks
// and history.pushState and ran the bar from navigation start to finish,
// which made the bar look like a thing you had to wait out before the page
// arrived. Navigation is instant and shows cached data; the bar is only ever
// a caveat on data already on screen.
//
// Three states a page can be in, and only one gets the bar:
//
//   1. Nothing cached      first ever visit. No bar , loading.tsx skeletons
//                          instead, because there is nothing on screen to
//                          caveat. Bar and skeletons are mutually exclusive:
//                          a page shimmering AND claiming to refresh
//                          describes nothing.
//   2. Arriving with cache bar shows until the fetch lands. THE ONLY CASE.
//   3. Background poll     no bar. Pages re-fetch every 30s, and again when
//                          the tab regains focus. A light flashing across
//                          the screen twice a minute while you work reads as
//                          an alarm, and you would learn to ignore it , at
//                          which point it is worth nothing when it matters.
//
// The rule is that the bar answers a question you are actually asking. You
// ask it on arrival. You don't ask it every thirty seconds while typing.
//
// Mounted once in the root layout , don't render it per-page.
// ============================================================================

import { Suspense, useCallback, useEffect, useRef, useSyncExternalStore, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// ─── Ref-counted store ────────────────────────────────────────────────
// Ref-counted rather than a boolean so overlapping refreshes can't have the
// first one to finish switch the bar off underneath the second.

let activeCount = 0;
const listeners = new Set<() => void>();
let notifyQueued = false;

// Notification is deferred to a microtask so a caller can start the
// indicator from anywhere, including inside a React commit, without
// scheduling an update in a phase React rejects. The counter still moves
// synchronously, so getSnapshot is correct immediately and there's no
// tearing; only the re-render waits.
function emit() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of listeners) listener();
  });
}

/**
 * Show the refresh bar until the returned function is called. Safe to call
 * from anywhere, and safe to call the finisher twice (the second is a
 * no-op), so it can live in a `finally`.
 *
 *   const done = startRefreshing();
 *   try { await somethingSlow(); } finally { done(); }
 */
export function startRefreshing(): () => void {
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
const getSnapshot = () => activeCount > 0;
const getServerSnapshot = () => false;

// ─── The bar ──────────────────────────────────────────────────────────

function Bar() {
  const active = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!active) return null;

  // Fixed and pointer-events-none so it sits above everything and never
  // blocks a click; aria-hidden because it is decoration, not status.
  // Critically it takes up no space: it can't push the page down when it
  // appears or let it snap back when it goes. That is the difference
  // between an indicator and a layout bug.
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-1 overflow-hidden bg-transparent"
    >
      {/* The track clips and the segment has capsule ends, so the segment
          is progressively revealed on the way in and progressively cut on
          the way out. That's a fade at both edges without touching
          opacity, and what meets the clipping edge is a taper rather than
          a blunt edge. */}
      <div className="h-full w-1/3 rounded-full bg-[color:var(--brand-gold)] animate-[refreshbar_1.1s_ease-in-out_infinite]" />
    </div>
  );
}

// ─── Stale-while-revalidate ───────────────────────────────────────────

/** Last time each URL was known-fresh, keyed by pathname + query. Module
 *  scope so it survives the component remounting on every navigation.
 *  A URL absent from here has never been rendered, which is exactly the
 *  "nothing cached, show skeletons instead" case. */
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
/** How often a page open in front of someone re-fetches itself, and the
 *  minimum age before a refocus is worth a round trip. Polling only runs
 *  while the tab is visible , a backgrounded tab catches up on focus. */
const REVALIDATE_INTERVAL_MS = 30_000;
/** Backstop on a refresh that never reports finishing. */
const REFRESH_FAILSAFE_MS = 15_000;

/** Routes where a background refresh is pointless or unwelcome: multi-step
 *  wizards and long-form editors own their state client-side, and the auth
 *  screens have nothing to re-fetch. */
const SKIP_REVALIDATE = ["/ocs/new", "/admin/blog/", "/onboarding", "/sign-in", "/sign-up", "/invite/"];

function StaleWhileRevalidate() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const inFlightRef = useRef(false);
  // Whether this refresh has actually been observed pending yet. Without
  // it the settle effect below runs in the SAME commit as the arrival
  // effect, while isPending is still the false from the previous render,
  // and stops the bar before it has ever been painted.
  const sawPendingRef = useRef(false);
  const doneRef = useRef<(() => void) | null>(null);
  const failsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const key = `${pathname}?${searchParams}`;
  const skip = SKIP_REVALIDATE.some((prefix) => pathname.startsWith(prefix));

  const settle = useCallback(() => {
    inFlightRef.current = false;
    sawPendingRef.current = false;
    if (failsafeRef.current) {
      clearTimeout(failsafeRef.current);
      failsafeRef.current = null;
    }
    doneRef.current?.();
    doneRef.current = null;
  }, []);

  /**
   * Re-fetch the current route. `showBar` is the arrival case and nothing
   * else , see the three states at the top of the file.
   *
   * A failed refresh leaves whatever is on screen alone: the bar stops, the
   * data stays. Blanking a page because one background poll timed out is a
   * worse outcome than showing data that's thirty seconds old.
   */
  const revalidate = useCallback(
    (showBar: boolean) => {
      if (inFlightRef.current) return; // one in flight is enough
      inFlightRef.current = true;
      if (showBar) doneRef.current = startRefreshing();
      markLoaded(key, Date.now());
      // If a transition somehow never reports back, don't wedge the in-flight
      // flag shut and silently stop refreshing for the rest of the session.
      failsafeRef.current = setTimeout(settle, REFRESH_FAILSAFE_MS);
      startTransition(() => {
        router.refresh();
      });
    },
    [key, router, settle],
  );

  // Arrival. A URL we've rendered before came out of the router cache, so
  // it's stale by definition and this is the one fetch that gets the bar.
  // A first visit was just fetched from the server , nothing to caveat, and
  // loading.tsx already showed skeletons for it.
  useEffect(() => {
    if (skip) return;
    const previous = lastLoadedAt.get(key);
    const now = Date.now();
    if (previous === undefined) {
      markLoaded(key, now); // first visit: no cache, no bar
      return;
    }
    if (now - previous < ARRIVAL_MIN_AGE_MS) {
      markLoaded(key, now); // came straight back: cached copy is fine
      return;
    }
    revalidate(true);
  }, [key, skip, revalidate]);

  // While the page sits open in front of someone, keep it current. Silent:
  // nobody asked for this one.
  useEffect(() => {
    if (skip) return;
    const id = setInterval(() => {
      // A backgrounded tab isn't being read , don't spend a render on it.
      if (document.visibilityState !== "visible") return;
      const previous = lastLoadedAt.get(key);
      if (previous !== undefined && Date.now() - previous < REVALIDATE_INTERVAL_MS) return;
      revalidate(false);
    }, REVALIDATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [key, skip, revalidate]);

  // Coming back to a tab that's been sitting open. Also silent , this is
  // the same poll as above, just triggered by attention rather than a timer.
  useEffect(() => {
    if (skip) return;
    function onFocus() {
      if (document.visibilityState !== "visible") return;
      const previous = lastLoadedAt.get(key);
      if (previous !== undefined && Date.now() - previous < REVALIDATE_INTERVAL_MS) return;
      revalidate(false);
    }
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, skip, revalidate]);

  // The transition going idle is how we know the fresh payload has been
  // applied , that's when the bar can stop. It has to have gone BUSY first:
  // this effect and the arrival effect above run in the same commit, and at
  // that point isPending is still the false from the render that produced
  // the commit. Settling on that would switch the bar off in the same tick
  // it was switched on, and since emit coalesces notifications into one
  // microtask the net change is zero and the bar never paints.
  useEffect(() => {
    if (isPending) {
      sawPendingRef.current = true;
      return;
    }
    if (!sawPendingRef.current || !inFlightRef.current) return;
    markLoaded(key, Date.now());
    settle();
  }, [isPending, key, settle]);

  return null;
}

// ─── Public component ─────────────────────────────────────────────────

export function RefreshBar() {
  return (
    <>
      <Bar />
      {/* useSearchParams needs a boundary so it can't drag a whole route
          into client rendering. Nothing here renders UI, so `null`. */}
      <Suspense fallback={null}>
        <StaleWhileRevalidate />
      </Suspense>
    </>
  );
}
