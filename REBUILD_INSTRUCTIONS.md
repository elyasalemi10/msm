# Rebuild Instructions — Fresh Database After Consolidation

The schema has been consolidated into a single authoritative file:
[database-schema.sql](database-schema.sql). The old `database-migration-*.sql`
files have been removed. To bring the live Supabase database in line:

> **Preserve data?** Use the incremental migration file
> [database-schema-prompt1-additions.sql](database-schema-prompt1-additions.sql)
> instead — it adds the ledger tables/functions on top of the Prompt 0
> schema without dropping anything. Skip to §7 for the apply steps.

## 1. Drop the existing schema

Run this in the Supabase SQL editor (project → SQL → New query). It nukes
the `public` schema and recreates it empty. **All data is destroyed** — the
plan confirmed there is nothing worth preserving.

```sql
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;

GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Restore default privileges on tables/sequences/routines created later.
-- Without these, tables created by the schema script below aren't
-- accessible to the service_role client used by server actions — the
-- DROP SCHEMA above wipes the ALTER DEFAULT PRIVILEGES set up by Supabase
-- at project creation.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES  TO anon, authenticated, service_role;
```

> If you have Supabase-managed policies, functions, or extensions outside
> `public` (e.g. `auth`, `storage`), they are untouched by the drop.

## 2. Apply the consolidated schema

Paste the entire contents of [database-schema.sql](database-schema.sql) into
a new SQL editor tab and run it. It creates, in order:

- Extensions (`uuid-ossp`, `pgcrypto`)
- 33 enum types (29 pre-Prompt-1 + 4 ledger-related:
  `ledger_entry_type`, `ledger_entry_category`, `ledger_entry_status`,
  `reconciliation_match_method`; plus `levy_batch_status` extended with
  `ledger_written`)
- 11 global sequences + `next_reference_number()` (sequence names are
  short-form: `sw_lev_seq`, `sw_slev_seq`, `sw_pay_seq`, `sw_mtg_seq`,
  `sw_min_seq`, `sw_pol_seq`, `sw_clm_seq`, `sw_mnt_seq`, `sw_inv_seq`,
  `sw_cmp_seq`, `sw_esc_seq` — matching the prefixes accepted by the
  reference-number function, which returns `SW-<PREFIX>-YYYY-NNNNNN`)
- 48 tables (45 pre-Prompt-1 + `lot_ledger_entries`, `lot_ledger_state`,
  `reconciliation_matches`)
- 4 trigger functions + 16 triggers (adds `trg_lot_ledger_state_create`
  on `lots`)
- 8 ledger functions: `_walk_oldest_unpaid`, `recompute_lot_ledger_state`,
  `rpc_levy_debit`, `rpc_payment_credit`, `rpc_ledger_adjustment`,
  `rpc_ledger_void`, `rpc_levy_batch_debit`, `create_lot_trigger_ledger_state`
- 1 view: `v_levy_notice_status` (effective status derived from ledger)
- 45 `ENABLE ROW LEVEL SECURITY` statements + audit_log immutability policies
- Seed data: 14 VIC compliance rules, 23 budget categories, 1 default
  escalation workflow with 3 steps

Running the file should produce zero errors on a fresh, empty public schema.

## 3. Verification checklist

After the rebuild, run each query in the SQL editor and confirm the result:

| # | Query | Expected |
|---|-------|----------|
| 1 | `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';` | **48** |
| 2 | `SELECT COUNT(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e';` | **33** |
| 3 | `SELECT COUNT(*) FROM information_schema.sequences WHERE sequence_schema = 'public';` | **11** |
| 3a | `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' ORDER BY sequence_name;` | `sw_clm_seq, sw_cmp_seq, sw_esc_seq, sw_inv_seq, sw_lev_seq, sw_min_seq, sw_mnt_seq, sw_mtg_seq, sw_pay_seq, sw_pol_seq, sw_slev_seq` |
| 3b | `SELECT next_reference_number('LEV');` | `SW-LEV-2026-000001` (the `StrataWise-` prefix is now applied inside the function) |
| 4 | `SELECT COUNT(*) FROM state_compliance_rules WHERE state = 'VIC';` | **14** |
| 5 | `SELECT COUNT(*) FROM budget_categories;` | **23** |
| 6 | `SELECT COUNT(*) FROM escalation_workflows WHERE is_default;` | **1** |
| 7 | `SELECT COUNT(*) FROM escalation_workflow_steps;` | **3** |
| 8 | `SELECT column_name FROM information_schema.columns WHERE table_name = 'lots' ORDER BY ordinal_position;` | Exactly: `id, subdivision_id, lot_number, unit_number, lot_entitlement, lot_liability` — **no `owner_*` columns** |
| 9 | `SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications' ORDER BY ordinal_position;` | `id, profile_id, subdivision_id, type, title, body, link, read_at, created_at` — **no `read` boolean, no `recipient_id`, no `message`** |
| 10 | `SELECT tgname FROM pg_trigger WHERE tgrelid IN ('bank_accounts'::regclass, 'insurance_policies'::regclass) AND tgname LIKE 'trg_updated_at_%';` | 2 rows |
| 11 | Lot-count sanity: `SELECT CASE WHEN (SELECT 1) <= 2 THEN 5 WHEN (SELECT 1) <= 12 THEN 4 ELSE 1 END;` / `INSERT INTO management_companies(name) VALUES ('TC') RETURNING id;` then `INSERT INTO subdivisions(management_company_id, name, plan_number, address, total_lots) VALUES (..., 'T', 'T', 'T', 12) RETURNING oc_tier;` | **4** (12 lots → tier 4 per VIC thresholds) |
| 12 | `SELECT NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name IN ('bank_reconciliation_sessions', 'lot_financial_summary'));` | **true** |
| 13 | `SELECT COUNT(*) FROM lot_ledger_entries;` | **0** |
| 14 | `SELECT COUNT(*) FROM reconciliation_matches;` | **0** |
| 15 | `SELECT COUNT(*) FROM lot_ledger_state;` | **0** (populated on first lot insert via trigger) |
| 16 | `SELECT proname FROM pg_proc WHERE proname IN ('recompute_lot_ledger_state', 'rpc_levy_debit', 'rpc_payment_credit', 'rpc_ledger_adjustment', 'rpc_ledger_void', 'rpc_levy_batch_debit', '_walk_oldest_unpaid', 'create_lot_trigger_ledger_state') ORDER BY proname;` | **8 rows** |
| 17 | `SELECT enumlabel FROM pg_enum WHERE enumtypid = 'levy_batch_status'::regtype ORDER BY enumsortorder;` | `draft, ledger_written, sent, partially_sent` |
| 18 | `SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = 'v_levy_notice_status';` | 1 row |
| 19 | `SELECT column_name FROM information_schema.columns WHERE table_name = 'bank_transactions' AND column_name = 'matched_total';` | 1 row (the scaffold column added for Prompt 2+ reconciliation) |
| 20 | lot_ledger_state trigger: insert a lot into the sandbox subdivision from #11, then `SELECT lot_id, admin_balance, capital_balance, total_balance FROM lot_ledger_state WHERE lot_id = <newly inserted lot id>;` | 1 row with all balances **0.00** |

If any row differs from the expected value, stop and diff against
`database-schema.sql`.

## 4. Reset the reference-number sequences

The schema creates all sequences starting at 1, so no further action is
needed. (Previously `database-migration-reference-numbers.sql` restarted
`sw_lev_seq` — that behaviour is now baked in.)

## 5. Seed development profiles (optional)

Profiles are created on demand by `ensureProfile()` on first sign-in. No
manual seeding is required. If you want a super_admin for testing, run:

```sql
UPDATE profiles
SET role = 'super_admin', company_role = 'admin'
WHERE email = 'your-test-email@example.com';
```

## 6. Confirm the app runs

```bash
npx tsc --noEmit
npm run dev
```

Open http://localhost:3000, sign in, and walk through:
- Subdivision setup wizard (steps 1–5) — step 4 creates pending invitations,
  step 5 dispatches the emails.
- Manage page → lots tab — owners display from `subdivision_members` or
  pending invitations. Owner name/email/phone are read-only.
- Lot detail page — owner card shows status + contact info from the helper.
- Levy generation + batch detail — preview and batch lists pull owner info
  via the shared helper rather than denormalised lot columns.

## 7. Incremental upgrade (Prompt 1 ledger foundation)

If the DB is already on the Prompt 0 schema and you want to preserve data:

1. Open Supabase SQL editor and paste the full contents of
   [database-schema-prompt1-additions.sql](database-schema-prompt1-additions.sql).
   It adds the 4 new enums, extends `levy_batch_status` with
   `ledger_written`, adds `bank_transactions.matched_total`, creates
   `lot_ledger_entries`, `lot_ledger_state`, `reconciliation_matches`,
   backfills `lot_ledger_state` for existing lots, creates the 8 ledger
   functions + view + trigger, enables RLS on the new tables, and
   re-applies the `ALTER DEFAULT PRIVILEGES` grants (which Supabase's
   project-creation step originally set up but `DROP SCHEMA CASCADE`
   wipes).
2. Re-run verification queries #13–#20 from §3 to confirm.
3. Run the CLI verification:
   ```bash
   npx tsx src/lib/actions/ledger.verification.ts
   ```
   Expect: `9 passed, 0 failed`.

## 8. Troubleshooting: "permission denied for table ..."

If server-role queries hit `permission denied for table ...`, the
Supabase-managed `ALTER DEFAULT PRIVILEGES` were wiped by a prior
`DROP SCHEMA public CASCADE` and existing tables now lack grants. Fix:

```sql
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES  TO anon, authenticated, service_role;
```

(These statements are idempotent and are also included in the Prompt 1
additions migration file.)
