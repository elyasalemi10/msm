/**
 * Notification preferences verification (PP6-D-B).
 *
 * Exercises updateNotificationPreferences against a live test profile
 * with the auth-resolver shim swapped for deterministic identity.
 *
 * Usage:
 *   npx tsx src/lib/actions/notification-preferences.verification.ts
 *   npx tsx src/lib/actions/notification-preferences.verification.ts --no-cleanup
 *   npx tsx src/lib/actions/notification-preferences.verification.ts --cleanup
 */

import { config } from "dotenv";
config({ path: ".env.local" });

// next/cache stub , updateNotificationPreferences calls revalidatePath.
import { createRequire } from "node:module";
const scriptRequire = createRequire(import.meta.url);
const nextCachePath = scriptRequire.resolve("next/cache");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(scriptRequire.cache as any)[nextCachePath] = {
  id: nextCachePath,
  filename: nextCachePath,
  loaded: true,
  exports: {
    revalidatePath: () => {},
    revalidateTag: () => {},
    updateTag: () => {},
    unstable_cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  },
  paths: [],
  children: [],
};

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  __setUserIdResolverForVerification,
} from "@/lib/auth-resolver";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const VERIFY_MARKER = "__VERIFY_NP__";
const supabase = createClient(supabaseUrl, serviceRoleKey);

let activeUserId: string | null = null;
__setUserIdResolverForVerification(async () => activeUserId);

type Result = { scenario: string; passed: boolean; detail: string };
const results: Result[] = [];
function record(scenario: string, passed: boolean, detail: string) {
  results.push({ scenario, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${scenario}${detail ? " , " + detail : ""}`);
}

// ─── Fixture ───────────────────────────────────────────────────────

interface FixtureContext {
  profileAId: string;
  profileAUserId: string;
  profileBId: string;
  profileBUserId: string;
}

async function createFixture(): Promise<FixtureContext> {
  const runId = `${Date.now()}_${randomUUID().slice(0, 6)}`;

  const { data: a } = await supabase
    .from("profiles")
    .insert({
      auth_user_id: `${VERIFY_MARKER}_A_${runId}`,
      email: `${VERIFY_MARKER.toLowerCase()}${runId}_a@np.test`,
      first_name: "NP",
      last_name: "TestA",
      role: "lot_owner",
    })
    .select("id")
    .single();
  const { data: b } = await supabase
    .from("profiles")
    .insert({
      auth_user_id: `${VERIFY_MARKER}_B_${runId}`,
      email: `${VERIFY_MARKER.toLowerCase()}${runId}_b@np.test`,
      first_name: "NP",
      last_name: "TestB",
      role: "lot_owner",
    })
    .select("id")
    .single();

  return {
    profileAId: (a as { id: string }).id,
    profileAUserId: `${VERIFY_MARKER}_A_${runId}`,
    profileBId: (b as { id: string }).id,
    profileBUserId: `${VERIFY_MARKER}_B_${runId}`,
  };
}

// ─── Scenarios ─────────────────────────────────────────────────────

async function np1_validEmailOptOutUpserts(
  ctx: FixtureContext,
  np: typeof import("./notification-preferences"),
) {
  activeUserId = ctx.profileAUserId;
  const result = await np.updateNotificationPreferences({
    updates: [
      { type: "payment_received", channel: "email", enabled: false },
    ],
  });

  const { data: row } = await supabase
    .from("notification_preferences")
    .select("enabled")
    .eq("profile_id", ctx.profileAId)
    .eq("notification_type", "payment_received")
    .eq("channel", "email")
    .single();
  const r = row as { enabled: boolean } | null;

  const { data: audit } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("profile_id", ctx.profileAId)
    .eq("action", "communication.preferences_updated")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const a = audit as { metadata: { count: number; types_updated: string[] } } | null;

  const ok =
    "success" in result &&
    r?.enabled === false &&
    !!a &&
    a.metadata.count === 1 &&
    a.metadata.types_updated.includes("payment_received");
  record(
    "NP-1: valid email opt-out upserts row + audit entry",
    ok,
    `success=${"success" in result} row.enabled=${r?.enabled} audit=${a ? "yes" : "no"}`,
  );
}

async function np2_mandatoryDisableRejected(
  ctx: FixtureContext,
  np: typeof import("./notification-preferences"),
) {
  activeUserId = ctx.profileAUserId;
  const result = await np.updateNotificationPreferences({
    updates: [
      { type: "levy_final_notice", channel: "email", enabled: false },
    ],
  });
  // PP6.5: levy_final_notice was added to NOTIFICATION_TYPES so it passes
  // the Zod .enum() validation. The application-layer guard then rejects
  // with errorCode='MANDATORY_DISABLE' because the type is in
  // MANDATORY_NOTIFICATION_TYPES. This is the canonical rejection path
  // for any future MANDATORY type.

  const ok =
    "error" in result &&
    "errorCode" in result &&
    result.errorCode === "MANDATORY_DISABLE";

  // Confirm no row was created (defence-in-depth).
  const { count } = await supabase
    .from("notification_preferences")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", ctx.profileAId)
    .eq("notification_type", "levy_final_notice");

  record(
    "NP-2: levy_final_notice (MANDATORY) email disable rejected at app layer with errorCode='MANDATORY_DISABLE'; no row written",
    ok && (count ?? 0) === 0,
    `errorCode=${"errorCode" in result ? result.errorCode : "?"} rows=${count}`,
  );
}

async function np3_managerialInAppDisableRejected(
  ctx: FixtureContext,
  np: typeof import("./notification-preferences"),
) {
  activeUserId = ctx.profileAUserId;
  const result = await np.updateNotificationPreferences({
    updates: [
      { type: "new_claim_submitted", channel: "in_app", enabled: false },
    ],
  });

  const ok =
    "error" in result &&
    "errorCode" in result &&
    result.errorCode === "MANAGERIAL_INAPP_DISABLE";

  // No row written.
  const { count } = await supabase
    .from("notification_preferences")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", ctx.profileAId)
    .eq("notification_type", "new_claim_submitted")
    .eq("channel", "in_app");

  record(
    "NP-3: managerial type in-app disable rejected with errorCode='MANAGERIAL_INAPP_DISABLE'; no row written",
    ok && (count ?? 0) === 0,
    `errorCode=${"errorCode" in result ? result.errorCode : "?"} rows=${count}`,
  );
}

async function np4_crossProfileIsolation(
  ctx: FixtureContext,
  np: typeof import("./notification-preferences"),
) {
  // Profile A opts out of overdue_reminder email; profile B should be
  // unaffected (no row written for B).
  activeUserId = ctx.profileAUserId;
  await np.updateNotificationPreferences({
    updates: [{ type: "overdue_reminder", channel: "email", enabled: false }],
  });

  const { data: aRow } = await supabase
    .from("notification_preferences")
    .select("enabled")
    .eq("profile_id", ctx.profileAId)
    .eq("notification_type", "overdue_reminder")
    .eq("channel", "email")
    .single();
  const { count: bCount } = await supabase
    .from("notification_preferences")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", ctx.profileBId)
    .eq("notification_type", "overdue_reminder")
    .eq("channel", "email");

  const aEnabled = (aRow as { enabled: boolean } | null)?.enabled;
  record(
    "NP-4: cross-profile isolation , profile A's update doesn't affect profile B",
    aEnabled === false && (bCount ?? 0) === 0,
    `A.enabled=${aEnabled} B.rows=${bCount}`,
  );
}

// ─── Cleanup ───────────────────────────────────────────────────────

async function cleanupMarker() {
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id")
    .like("auth_user_id", `${VERIFY_MARKER}%`);
  const ids = (profiles ?? []).map((p) => (p as { id: string }).id);
  if (ids.length > 0) {
    await supabase.from("notification_preferences").delete().in("profile_id", ids);
    await supabase.from("audit_log").delete().in("profile_id", ids);
    await supabase.from("profiles").delete().in("id", ids);
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const cleanupOnly = process.argv.includes("--cleanup");
  const noCleanup = process.argv.includes("--no-cleanup");

  if (cleanupOnly) {
    await cleanupMarker();
    process.exit(0);
  }

  console.log("Notification preferences verification , PP6-D-B scenarios NP-1..NP-4\n");
  console.log("[1/3] Cleaning up stale verification data");
  await cleanupMarker();

  console.log("[2/3] Creating fixture");
  const ctx = await createFixture();

  console.log("[3/3] Running scenarios\n");
  const np = await import("./notification-preferences");
  await np1_validEmailOptOutUpserts(ctx, np);
  await np2_mandatoryDisableRejected(ctx, np);
  await np3_managerialInAppDisableRejected(ctx, np);
  await np4_crossProfileIsolation(ctx, np);

  if (!noCleanup) {
    console.log("\nCleaning up");
    await cleanupMarker();
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
