#!/usr/bin/env node
// Push the env vars the deployed trigger.dev tasks need into the prod
// environment via the management API. Idempotent: existing values are
// overwritten with the local .env.local snapshot.
//
// Usage:
//   TRIGGER_ACCESS_TOKEN=tr_pat_XXXX node scripts/sync-trigger-env.mjs
//
// (PAT — `tr_pat_…`. The environment-scoped secret key `tr_prod_…` can
// trigger tasks but cannot manage env vars.)

import { configure, envvars } from "@trigger.dev/sdk";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env.local");

const NEEDED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_PUBLIC",
  "R2_BUCKET_CONFIDENTIAL",
  "R2_PUBLIC_URL",
  "GMAIL_SERVICE_ACCOUNT_JSON",
  "GMAIL_PUBSUB_TOPIC",
  "RESEND_API_KEY",
  "NEXT_PUBLIC_APP_URL",
  "APP_URL",
];

const pat = process.env.TRIGGER_ACCESS_TOKEN;
if (!pat || !pat.startsWith("tr_pat_")) {
  console.error("ERROR: TRIGGER_ACCESS_TOKEN must be a PAT (tr_pat_…).");
  process.exit(1);
}

// Tiny .env parser — we don't want to depend on dotenv just for this.
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const local = parseEnv(readFileSync(envPath, "utf8"));
configure({ accessToken: pat });

const projectRef = "proj_ezvanpighvrfczyvvrin";

let pushed = 0;
let missing = 0;
for (const name of NEEDED) {
  const value = local[name];
  if (!value) {
    console.log(`SKIP   ${name.padEnd(36)} (not in .env.local)`);
    missing += 1;
    continue;
  }
  try {
    // SDK doesn't ship an upsert helper; try create first, fall back to
    // update on conflict (already-exists) so re-runs are idempotent.
    try {
      await envvars.create(projectRef, "prod", { name, value });
    } catch (createErr) {
      const msg = String(createErr?.message ?? createErr);
      if (msg.toLowerCase().includes("already")) {
        await envvars.update(projectRef, "prod", name, { value });
      } else {
        throw createErr;
      }
    }
    console.log(`OK     ${name.padEnd(36)} (${value.length} bytes)`);
    pushed += 1;
  } catch (err) {
    console.log(`FAIL   ${name.padEnd(36)} ${err?.message ?? err}`);
  }
}

console.log("");
console.log(`Done — ${pushed} pushed, ${missing} skipped (not in .env.local).`);
console.log(
  "Trigger another test run after this completes — env vars apply on the next invocation.",
);
