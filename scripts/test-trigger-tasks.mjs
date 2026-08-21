#!/usr/bin/env node
// One-shot test runner for the deployed Trigger.dev tasks.
//
// Usage:
//   TRIGGER_SECRET_KEY=tr_prod_XXXX node scripts/test-trigger-tasks.mjs
//
// or (target only one task):
//   TRIGGER_SECRET_KEY=tr_prod_XXXX node scripts/test-trigger-tasks.mjs gmail-watch-refresh
//
// The key MUST be the environment-scoped secret key from the Trigger.dev
// dashboard (Settings → API keys → Production → Secret key, format
// `tr_prod_…`). Personal access tokens (`tr_pat_…`) can deploy but
// cannot trigger runs — the API rejects them with `Invalid API Key`.
//
// Each task is triggered once. The run id is printed; visit
// https://cloud.trigger.dev/projects/v3/proj_ezvanpighvrfczyvvrin/runs?environment=prod
// to inspect logs and output.

import { configure, tasks } from "@trigger.dev/sdk";

const ALL_TASKS = [
  "daily-check-escalation-steps",
  "daily-accrue-interest",
  "daily-check-overdue-levies",
  "gmail-watch-refresh",
  "sweep-pending-ocr",
];

const secret = process.env.TRIGGER_SECRET_KEY;
if (!secret) {
  console.error("ERROR: TRIGGER_SECRET_KEY env var is not set.");
  console.error("Get it from Trigger.dev dashboard → Settings → API keys → Production → Secret key.");
  process.exit(1);
}
if (!secret.startsWith("tr_prod_") && !secret.startsWith("tr_dev_")) {
  console.error(
    `ERROR: secret key has unexpected prefix. Got "${secret.slice(0, 8)}…", expected "tr_prod_…" or "tr_dev_…".`,
  );
  process.exit(1);
}

configure({ secretKey: secret });

const arg = process.argv[2];
const targets = arg ? [arg] : ALL_TASKS;

let okCount = 0;
let failCount = 0;
for (const id of targets) {
  process.stdout.write(`${id.padEnd(36)} `);
  try {
    const handle = await tasks.trigger(id, {});
    console.log(`OK  run=${handle?.id ?? "?"}`);
    okCount += 1;
  } catch (err) {
    console.log(`FAIL  ${err?.message ?? err}`);
    failCount += 1;
  }
}

console.log("");
console.log(`Done — ${okCount} triggered, ${failCount} failed.`);
console.log(
  "Inspect runs at https://cloud.trigger.dev/projects/v3/proj_ezvanpighvrfczyvvrin/runs?environment=prod",
);
process.exit(failCount > 0 ? 1 : 0);
