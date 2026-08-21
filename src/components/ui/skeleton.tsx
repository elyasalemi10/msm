"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Skeleton renders nothing for the first 200ms after mount, then shows
// the shimmer. This makes fast navigations (data lands < 200ms) skip the
// skeleton entirely , no flash. Slow loads still get the skeleton, just
// 200ms later. The delay applies everywhere Skeleton is used: loading.tsx
// files, inline placeholders, tab content, etc.
//
// Initial state must be `false` so the server-rendered HTML matches the
// pre-effect client render , no hydration mismatch.
//
// The look is a sweep, not a pulse: a pulsing opacity reads as "something
// is broken and flashing", a highlight travelling left to right reads as
// loading. See .skeleton-shimmer in globals.css. bg-muted underneath is
// what shows when prefers-reduced-motion drops the gradient.
const SKELETON_DELAY_MS = 200;

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShow(true), SKELETON_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  if (!show) return null;

  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton-shimmer rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
