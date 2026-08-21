import { NextResponse, type NextRequest } from "next/server";
import { createServerClient as ssrCreateServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

// Public routes , no auth required.
const PUBLIC_PATHS = [
  "/",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/legal",
  "/api/webhooks",
  // Vercel Cron endpoints. They authenticate themselves with the
  // CRON_SECRET bearer token Vercel sends; there is no user session on a
  // cron invocation, so the session gate would 307 them to sign-in.
  "/api/cron",
  "/logout",
  "/sign-out",
  "/signout",
  "/log-out",
  "/dev",
  "/invite",
  "/test",
];

// Auth-flow pages that signed-in users should bounce *out* of , e.g. an
// authenticated user landing on /sign-in is sent to /dashboard so they
// don't see the form they don't need. /reset-password and /verify-email
// are NOT in this list because they require an active session.
const SIGNED_IN_REDIRECT_AWAY = ["/sign-in", "/sign-up", "/forgot-password", "/"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function shouldRedirectSignedIn(pathname: string): boolean {
  return SIGNED_IN_REDIRECT_AWAY.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export async function middleware(request: NextRequest) {
  // Two jobs: refresh the auth cookie (so server components see fresh state)
  // and gate non-public routes.
  let response = NextResponse.next({ request });

  const supabase = ssrCreateServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() must be called for cookie refresh. Do NOT remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  // Unauthenticated user on a protected route → /?next=<path>
  // (Canonical login is now "/"; /sign-in still works via the legacy route.)
  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Already-signed-in user on /sign-in /sign-up /forgot-password / →
  // bounce to /dashboard so they don't see the form they no longer need.
  // /reset-password is excluded because it requires a session (the magic
  // link sets one). /verify-email is excluded because verification still
  // needs to happen.
  if (user && shouldRedirectSignedIn(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Super admin route gating , ROLE ONLY.
  //
  // We deliberately do NOT check MFA / AAL here. The Supabase MFA APIs
  // (getAuthenticatorAssuranceLevel / listFactors) are unreliable in the
  // edge middleware runtime , they tend to read aal1 even for a verified
  // aal2 session. That caused an infinite redirect loop: middleware
  // (edge, sees aal1) bounced /admin → /admin/mfa-challenge, while the
  // page server component (node, correctly sees aal2) bounced it back to
  // /admin. AAL enforcement now lives entirely in the /admin server
  // components (evaluateSuperAdminGate), which run in the node runtime
  // where those APIs work. Middleware just keeps non-admins out of /admin.
  if (user) {
    const isAdminRoute = pathname === "/admin" || pathname.startsWith("/admin/");
    if (isAdminRoute) {
      // Read the role with the SERVICE-ROLE client, NOT the cookie-bound
      // anon client above. profiles has RLS enabled with no SELECT policy,
      // so the anon client reads NOTHING → role comes back null → every
      // super_admin gets bounced /admin → /dashboard, while the dashboard
      // (service role) bounces them back → infinite redirect loop. The
      // service client bypasses RLS so middleware agrees with the page gate.
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      );
      const { data: profileRow } = await admin
        .from("profiles")
        .select("role")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      const role = (profileRow as { role?: string } | null)?.role ?? null;
      if (role !== "super_admin") {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.search = "";
        return NextResponse.redirect(url);
      }
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
