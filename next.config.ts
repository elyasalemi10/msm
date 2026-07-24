import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // OC creation wizard accepts Plan-of-Subdivision PDFs up to 50MB.
      bodySizeLimit: "50mb",
    },
    // Client router cache. Out of the box `dynamic` is 0, so every page in
    // this app (all of them are dynamic) refetches from the server on every
    // visit and the user waits on a skeleton each time. Holding entries for
    // a couple of minutes means a revisit or a Back paints instantly from
    // cache; RouteProgress then re-fetches in the background so the stale
    // copy catches up. Mutations still call revalidatePath / router.refresh,
    // which drop the cached entry outright, so a save is never stale.
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
    // Hovering a link prefetches the real page rather than just its
    // loading.tsx boundary, so a deliberate click usually lands on content
    // that's already downloaded.
    dynamicOnHover: true,
  },
  async redirects() {
    return [
      // Common alternative paths → canonical /sign-in and /sign-up
      { source: "/login", destination: "/sign-in", permanent: false },
      { source: "/signin", destination: "/sign-in", permanent: false },
      { source: "/log-in", destination: "/sign-in", permanent: false },
      { source: "/signup", destination: "/sign-up", permanent: false },
      { source: "/register", destination: "/sign-up", permanent: false },
      { source: "/forgot", destination: "/forgot-password", permanent: false },
      // Sign-out URL aliases, all route to /logout which clears the session
      // and bounces to /. Useful when a user gets into a weird stale state.
      { source: "/sign-out", destination: "/logout", permanent: false },
      { source: "/signout", destination: "/logout", permanent: false },
      { source: "/log-out", destination: "/logout", permanent: false },
    ];
  },
};

export default nextConfig;
