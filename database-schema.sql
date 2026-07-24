-- ============================================================================
-- STRATA WISE — CONSOLIDATED DATABASE SCHEMA
-- ============================================================================
-- SINGLE SOURCE OF TRUTH. Auto-generated from consolidation in Prompt 0.
-- All prior `database-migration-*.sql` files have been merged into this file
-- and deleted. Do not re-introduce drift: future schema changes go here.
--
-- Run top-to-bottom in Supabase SQL Editor against a fresh database to
-- produce the exact schema the application expects.
--
-- Roles:     super_admin, strata_manager, lot_owner
-- Funds:     administrative, capital_works
-- State:     VIC only for MVP (multi-state via state_compliance_rules)
-- Ownership: Canonical ownership = oc_members + profiles.
--            Pre-acceptance identity = invitations (email/name/phone).
--            The lots table is deliberately owner-field-free.
-- ============================================================================

-- ============================================================================
-- EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- CUSTOM TYPES
-- ============================================================================
CREATE TYPE profile_role AS ENUM ('super_admin', 'strata_manager', 'lot_owner');
CREATE TYPE profile_status AS ENUM ('active', 'deactivated', 'anonymised');
CREATE TYPE company_role AS ENUM ('admin', 'manager', 'viewer');
CREATE TYPE oc_status AS ENUM ('active', 'archived', 'suspended');
CREATE TYPE subscription_status AS ENUM ('active', 'suspended', 'cancelled');
CREATE TYPE fund_type AS ENUM ('administrative', 'capital_works');
CREATE TYPE member_role AS ENUM ('strata_manager', 'lot_owner');
CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE budget_status AS ENUM ('draft', 'approved');
CREATE TYPE levy_status AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'written_off');
CREATE TYPE levy_type AS ENUM ('regular', 'special', 'penalty_interest');
CREATE TYPE levy_batch_status AS ENUM ('draft', 'ledger_written', 'sent', 'partially_sent');
CREATE TYPE payment_method AS ENUM ('bpay', 'eft', 'cash', 'cheque', 'direct_debit', 'stripe_card', 'other');
CREATE TYPE match_confidence AS ENUM ('exact_reference', 'amount_match', 'name_match', 'manual', 'auto_portal', 'system_created');
CREATE TYPE transaction_source AS ENUM ('manual', 'csv');
CREATE TYPE bank_txn_source AS ENUM ('macquarie_txn', 'macquarie_pay', 'csv_import', 'manual');
CREATE TYPE bank_provider AS ENUM ('macquarie_deft', 'other_csv');
CREATE TYPE meeting_type AS ENUM ('agm', 'sgm', 'committee');
CREATE TYPE meeting_status AS ENUM ('draft', 'notice_sent', 'in_progress', 'completed', 'cancelled');
CREATE TYPE resolution_type AS ENUM ('ordinary', 'special', 'unanimous', 'information');
CREATE TYPE vote_choice AS ENUM ('for', 'against', 'abstain');
CREATE TYPE maintenance_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE maintenance_status AS ENUM ('submitted', 'under_review', 'approved', 'in_progress', 'completed', 'rejected');
CREATE TYPE complaint_status AS ENUM ('open', 'under_review', 'resolved', 'escalated', 'closed');
CREATE TYPE communication_channel AS ENUM ('email', 'sms', 'voice', 'letter', 'in_app');
CREATE TYPE communication_status AS ENUM ('queued', 'sent', 'delivered', 'opened', 'bounced', 'failed');
CREATE TYPE escalation_status AS ENUM ('active', 'paused', 'completed', 'resolved', 'escalated_manual');
CREATE TYPE payment_plan_status AS ENUM ('active', 'completed', 'defaulted', 'cancelled');
CREATE TYPE reserve_priority AS ENUM ('critical', 'high', 'medium', 'low');
CREATE TYPE reserve_status AS ENUM ('planned', 'in_progress', 'completed');
CREATE TYPE contractor_status AS ENUM ('active', 'inactive');
CREATE TYPE recurring_frequency AS ENUM ('weekly', 'fortnightly', 'monthly', 'quarterly', 'half_yearly', 'annually');
CREATE TYPE recurring_job_status AS ENUM ('active', 'paused');

-- Lot ledger (Prompt 1)
CREATE TYPE ledger_entry_type AS ENUM ('debit', 'credit');
CREATE TYPE ledger_entry_category AS ENUM (
  'levy',
  'special_levy',
  'interest',
  'payment',
  'writeoff',
  'adjustment_debit',
  'adjustment_credit',
  'refund',
  'void_offset'
);
CREATE TYPE ledger_entry_status AS ENUM ('active', 'voided');
CREATE TYPE reconciliation_match_method AS ENUM (
  'manual',
  'auto_reference',
  'auto_bpay_crn',
  'auto_sender',
  'auto_amount',
  'system'
);

-- ============================================================================
-- REFERENCE NUMBER SEQUENCES
-- ----------------------------------------------------------------------------
-- Two reference-number schemes coexist:
--   1. Operational prefixes (MTG, MIN, SLEV, INV, POL, CLM, MNT, CMP, ESC)
--      use global Postgres sequences declared below. Format:
--      "SW-{PREFIX}-{YYYY}-{NNNNNN}". next_reference_number(prefix) — the
--      p_oc_id arg is accepted but ignored.
--   2. Financial prefixes (LEV, RCP, PAY) use per-OC integer counters on
--      owners_corporations.next_{levy,receipt,payment}_number. Format: "{PREFIX}-{n}".
--      next_reference_number(prefix, oc_id) — oc_id required.
-- Two OCs can each have LEV-1; downstream matching is always oc-
-- scoped so collisions are not possible.
-- ============================================================================
CREATE SEQUENCE sw_slev_seq START 1;   -- SLEV — Special levies
CREATE SEQUENCE sw_mtg_seq  START 1;   -- MTG  — Meetings
CREATE SEQUENCE sw_min_seq  START 1;   -- MIN  — Meeting minutes
CREATE SEQUENCE sw_pol_seq  START 1;   -- POL  — Insurance policies
CREATE SEQUENCE sw_clm_seq  START 1;   -- CLM  — Insurance claims
CREATE SEQUENCE sw_mnt_seq  START 1;   -- MNT  — Maintenance requests
CREATE SEQUENCE sw_rjb_seq  START 1;   -- RJB - Recurring jobs
CREATE SEQUENCE sw_inv_seq  START 1;   -- INV  — Invitations
CREATE SEQUENCE sw_cmp_seq  START 1;   -- CMP  — Complaints
CREATE SEQUENCE sw_esc_seq  START 1;   -- ESC  — Escalation instances

-- Prefix-aware reference number generator.
-- Usage:
--   SELECT next_reference_number('LEV', '<oc-uuid>');  →  'LEV-1'
--   SELECT next_reference_number('RCP', '<oc-uuid>');  →  'RCP-1'
--   SELECT next_reference_number('MTG');                        →  'SW-MTG-2026-000001'
-- Financial prefixes (LEV, RCP, PAY) atomically bump the OC's counter column
-- and return '{PREFIX}-{n}'. Operational prefixes use the global sequence and
-- return the long 'SW-{PREFIX}-{YYYY}-{NNNNNN}' form. Input prefix is
-- normalised to uppercase — callers may pass either case.
CREATE FUNCTION next_reference_number(
  p_prefix         TEXT,
  p_oc_id UUID DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefix   TEXT := upper(p_prefix);
  v_n        INTEGER;
  v_seq_name TEXT;
  v_seq_val  BIGINT;
  v_year     TEXT;
BEGIN
  IF v_prefix IN ('LEV', 'RCP', 'PAY') THEN
    IF p_oc_id IS NULL THEN
      RAISE EXCEPTION 'next_reference_number: oc_id is required for financial prefix %', v_prefix;
    END IF;

    -- Atomic increment-and-return on the per-OC counter.
    -- RETURNING (column - 1) gives the value consumed by THIS call;
    -- concurrent callers get consecutive values by row-lock semantics.
    IF v_prefix = 'LEV' THEN
      UPDATE owners_corporations
         SET next_levy_number = next_levy_number + 1
       WHERE id = p_oc_id
      RETURNING next_levy_number - 1 INTO v_n;
    ELSIF v_prefix = 'RCP' THEN
      UPDATE owners_corporations
         SET next_receipt_number = next_receipt_number + 1
       WHERE id = p_oc_id
      RETURNING next_receipt_number - 1 INTO v_n;
    ELSE -- PAY
      UPDATE owners_corporations
         SET next_payment_number = next_payment_number + 1
       WHERE id = p_oc_id
      RETURNING next_payment_number - 1 INTO v_n;
    END IF;

    IF v_n IS NULL THEN
      RAISE EXCEPTION 'next_reference_number: oc % not found', p_oc_id;
    END IF;

    RETURN v_prefix || '-' || v_n::TEXT;

  ELSE
    -- Operational prefix: global sequence, format SW-{PREFIX}-{YYYY}-{NNNNNN}.
    -- p_oc_id is accepted but ignored for these prefixes.
    v_seq_name := 'sw_' || lower(v_prefix) || '_seq';
    EXECUTE format('SELECT nextval(%L)', v_seq_name) INTO v_seq_val;
    v_year := extract(year FROM now())::TEXT;
    RETURN 'SW-' || v_prefix || '-' || v_year || '-' || lpad(v_seq_val::TEXT, 6, '0');
  END IF;
END;
$$;

-- ============================================================================
-- 1. MANAGEMENT COMPANIES
-- ============================================================================
CREATE TABLE management_companies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,                               -- legal company name
  trading_as TEXT,                                  -- optional "trading as" (e.g. legal: ACN Pty Ltd, trading: "Strata Group")
  registered_name TEXT,
  abn TEXT,
  address TEXT,                                     -- company address (single line; Google Places autocomplete supplies it)
  phone TEXT,                                       -- company phone (separate from each user's personal profile.phone)
  email TEXT,
  logo_url TEXT,
  signature_url TEXT,
  brand_color TEXT,                                 -- #RRGGBB; used by levy PDFs etc, not app UI
  -- Operating account — where the management company receives its fees
  -- from each OC's trust account. Filled in during step 2 of onboarding.
  operating_account_name TEXT,
  operating_bsb TEXT,
  operating_account_number TEXT,
  operating_bank_name TEXT,
  subscription_status subscription_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 2. PROFILES (linked to Supabase Auth via auth_user_id)
-- ============================================================================
-- Each profile is keyed by the auth.users.id UUID Supabase Auth assigns on
-- signup. On signup, the handle_new_user() trigger (defined below) inserts
-- a matching profile row with role='lot_owner' by default. Onboarding flow
-- promotes role + populates management_company_id once the user picks a path.
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,                              -- login identity (Clerk-mirrored), separate from lot-contact emails
  email_verified BOOLEAN NOT NULL DEFAULT false,    -- our own 6-digit OTP gate
  -- Item 15: outbound email is sent FROM `<email_username>@<brand-domain>`. Auto-derived
  -- from first_name + last_name at first onboarding; editable once per 30 days via
  -- /settings. Old usernames are retained in profile_username_aliases so inbound mail
  -- to an old address still routes to the same manager.
  email_username TEXT,
  email_username_changed_at TIMESTAMPTZ,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  postal_address TEXT,
  avatar_url TEXT,
  role profile_role NOT NULL DEFAULT 'lot_owner',
  company_role company_role,                        -- null for lot_owner
  management_company_id UUID REFERENCES management_companies(id),
  status profile_status NOT NULL DEFAULT 'active',
  deactivated_at TIMESTAMPTZ,
  anonymised_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_username_unique
  ON profiles(lower(email_username))
  WHERE email_username IS NOT NULL;

-- Item 15 — username alias forwarding. Every rename writes the previous username here
-- so legacy inbound mail still reaches the manager until they explicitly retire it.
CREATE TABLE profile_username_aliases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username TEXT NOT NULL,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_username_aliases_username_unique
  ON profile_username_aliases(lower(username));
CREATE INDEX IF NOT EXISTS idx_profile_username_aliases_profile
  ON profile_username_aliases(profile_id);
ALTER TABLE profile_username_aliases ENABLE ROW LEVEL SECURITY;

-- Our own email verification — we send a 6-digit code via Resend (not Supabase's
-- built-in magic link). The OTP is stored here until verified, then marked used.
-- profiles.email_verified is the gate the app checks; getOnboardingRedirect
-- routes to /verify-email until this flips to true.
CREATE TABLE email_verification_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code TEXT NOT NULL,                               -- 6-digit numeric, plain
  expires_at TIMESTAMPTZ NOT NULL,                  -- typically NOW() + 10 min
  used_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,              -- rate limit: code is marked used after 5 wrong attempts
  purpose TEXT NOT NULL DEFAULT 'email_verify',     -- 'email_verify' | 'password_reset'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sliding-window rate-limit counters. Keyed by "rule:identifier" pairs,
-- e.g. "invite_lookup:1.2.3.4" or "otp_resend:<profile_id>". Service-role
-- bypasses RLS so server actions can read/write; anon/authenticated have
-- no policies → deny-all.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_email_verification_codes_profile_id ON email_verification_codes(profile_id) WHERE used_at IS NULL;
CREATE INDEX idx_email_verification_codes_email ON email_verification_codes(email) WHERE used_at IS NULL;

-- Lock down to service-role only. All app flows go through createServerClient()
-- (admin) so RLS bypass is fine; anon/authenticated clients can no longer
-- read or insert codes via the public REST surface.
ALTER TABLE email_verification_codes ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_profiles_auth_user_id ON profiles(auth_user_id);
CREATE INDEX idx_profiles_management_company ON profiles(management_company_id);
CREATE INDEX idx_profiles_role ON profiles(role);

-- Auto-create a profile row when a user signs up via Supabase Auth.
-- Reads the user's email + raw_user_meta_data (intended_role, names) and
-- inserts a stub profile. Onboarding then completes the record.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    auth_user_id,
    email,
    first_name,
    last_name,
    role
  ) VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'first_name',
    NEW.raw_user_meta_data->>'last_name',
    COALESCE((NEW.raw_user_meta_data->>'intended_role')::profile_role, 'lot_owner')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================================
-- 3. USER CONSENTS
-- ============================================================================
CREATE TABLE user_consents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  consent_type TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_user_consents_profile ON user_consents(profile_id);

-- Per-OC lot-owner digital-communication consent. Consent is per (owner, OC),
-- NOT per account — an owner with an existing login who accepts an invite to a
-- new OC still completes the consent step for that OC. Written by
-- recordOcConsent; gated by getOnboardingRedirect.
CREATE TABLE oc_member_consents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  categories TEXT[] NOT NULL DEFAULT '{}',
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  CONSTRAINT oc_member_consents_unique UNIQUE (profile_id, oc_id)
);

CREATE INDEX idx_oc_member_consents_profile ON oc_member_consents(profile_id);

-- ============================================================================
-- 4. NOTIFICATION PREFERENCES
-- ============================================================================
CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  notification_type TEXT NOT NULL,
  channel communication_channel NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(profile_id, notification_type, channel)
);

CREATE INDEX idx_notification_prefs_profile ON notification_preferences(profile_id);

-- ============================================================================
-- 5. SUBDIVISIONS
-- ============================================================================
CREATE TABLE owners_corporations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- 8-char Crockford-32 code (alphabet: ABCDEFGHJKLMNPQRSTUVWXYZ23456789;
  -- drops 0/O/1/I for transcription safety). URL-facing identifier
  -- (/owners_corporations/<short_code>/...); internal queries still use `id`.
  -- Generated app-side via src/lib/oc-code.ts on insert with
  -- 23505-retry on collision.
  short_code TEXT NOT NULL,
  management_company_id UUID NOT NULL REFERENCES management_companies(id),
  name TEXT NOT NULL,                               -- legal name (typically "Owners Corporation PS<plan_no>")
  trading_name TEXT,                                -- optional friendly name shown alongside the legal name
  plan_number TEXT NOT NULL,                        -- e.g. PS812345X
  oc_number INTEGER,                                -- ordinal when a plan creates multiple OCs (1, 2, 3, …)
  services_only BOOLEAN NOT NULL DEFAULT false,     -- if true, forces Tier 5 regardless of lot count
  notice_address TEXT,                              -- address for service of notices when not same as OC
  notice_address_same_as_oc BOOLEAN NOT NULL DEFAULT true,
  address TEXT NOT NULL,
  street_number TEXT,
  street_name TEXT,
  suburb TEXT,
  state TEXT NOT NULL DEFAULT 'VIC',
  postcode TEXT,
  total_lots INTEGER NOT NULL DEFAULT 0,
  common_property_description TEXT,
  oc_tier INTEGER,                                  -- auto-calculated 1–5
  abn TEXT,
  tfn TEXT,
  bank_bsb TEXT,
  bank_account_number TEXT,
  bank_account_name TEXT,
  financial_year_start_month INTEGER NOT NULL DEFAULT 7,
  levy_year_start_month INTEGER NOT NULL DEFAULT 7,
  levies_per_year INTEGER NOT NULL DEFAULT 4,
  -- Banking ingest path. macquarie_deft → DRN-tagged TXN/PAY files;
  -- other_csv → manual CSV upload only. Legacy `bank_connection_type` retained
  -- below for back-compat, to be dropped after reconciliation rewrite.
  bank_provider bank_provider,
  bank_connection_type TEXT NOT NULL DEFAULT 'manual',   -- LEGACY — use bank_provider
  uses_shared_trust_account BOOLEAN NOT NULL DEFAULT false,
  -- Per-fund opening balances (anchored at opening_balance_date).
  opening_balance_date DATE,
  opening_admin_balance NUMERIC(12,2),
  opening_capital_works_balance NUMERIC(12,2),
  opening_maintenance_plan_balance NUMERIC(12,2),        -- Tier 1/2 mandatory; optional higher
  management_start_date DATE,
  is_developer_period BOOLEAN NOT NULL DEFAULT false,
  developer_period_end_date DATE,
  rules_type TEXT NOT NULL DEFAULT 'model',         -- model | custom
  custom_rules_registration_date DATE,
  custom_rules_reference TEXT,
  billing_cycle TEXT NOT NULL DEFAULT 'quarterly',  -- monthly | quarterly | half_yearly | annually
  last_agm_date DATE,
  next_agm_due DATE,                                -- auto: last_agm_date + 15 months
  -- Interest settings (VIC cap 2.5% / month)
  interest_enabled BOOLEAN NOT NULL DEFAULT true,
  interest_rate_monthly DECIMAL(5,2) NOT NULL DEFAULT 2.0,
  interest_accrual_day INTEGER NOT NULL DEFAULT 1,  -- 1, 15, or 0 (last day)
  interest_grace_period_days INTEGER NOT NULL DEFAULT 0,
  -- Per-OC reference counters (LEV/RCP/PAY). Financial references are
  -- oc-scoped, not globally unique — see §REFERENCE NUMBER
  -- SEQUENCES at file top. Counter column is the NEXT value to hand out;
  -- next_reference_number increments atomically and returns (value - 1).
  next_levy_number    INTEGER NOT NULL DEFAULT 1,
  next_receipt_number INTEGER NOT NULL DEFAULT 1,
  next_payment_number INTEGER NOT NULL DEFAULT 1,
  -- OC Certificate fields
  common_seal_text TEXT,
  inspection_address TEXT,
  manager_appointed BOOLEAN DEFAULT true,
  administrator_appointed BOOLEAN DEFAULT false,
  -- Wizard state
  setup_step INTEGER NOT NULL DEFAULT 1,
  status oc_status NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  archived_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES profiles(id),
  CONSTRAINT chk_levy_year_start_month CHECK (levy_year_start_month BETWEEN 1 AND 12),
  CONSTRAINT chk_levies_per_year CHECK (levies_per_year IN (1, 2, 4, 6, 12))
);

CREATE INDEX idx_owners_corporations_company ON owners_corporations(management_company_id);
CREATE INDEX idx_owners_corporations_status ON owners_corporations(status);
CREATE UNIQUE INDEX idx_owners_corporations_short_code ON owners_corporations(short_code);

-- ============================================================================
-- 5b. OC DRAFTS — wizard state (resumable Plan-of-Subdivision creation).
-- Promoted to owners_corporations + lots + lot_owners on completion.
-- ============================================================================
CREATE TABLE oc_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  management_company_id UUID NOT NULL REFERENCES management_companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  current_step INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 5),
  plan_storage_key TEXT,                            -- plans/{draft_id}/original.pdf
  plan_filename TEXT,
  plan_size_bytes BIGINT,
  parse_status TEXT NOT NULL DEFAULT 'none'
    CHECK (parse_status IN ('none','pending','complete','failed','skipped')),
  parse_started_at TIMESTAMPTZ,
  parse_completed_at TIMESTAMPTZ,
  parse_error TEXT,
  parsed_json JSONB,                                -- raw Gemini output (immutable)
  draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,    -- user's editable state across all 5 pages
  promoted_oc_id UUID REFERENCES owners_corporations(id) ON DELETE SET NULL,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oc_drafts_company ON oc_drafts(management_company_id);
CREATE INDEX idx_oc_drafts_creator_open ON oc_drafts(created_by) WHERE promoted_at IS NULL;

-- ============================================================================
-- 6. LOTS
-- Ownership is modelled via oc_members + profiles. This table is
-- deliberately owner-field-free — pre-acceptance identity lives on invitations.
-- ============================================================================
CREATE TABLE lots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  lot_number INTEGER NOT NULL,
  unit_number TEXT,
  lot_entitlement DECIMAL(10,4) NOT NULL DEFAULT 0,
  lot_liability DECIMAL(10,4) NOT NULL DEFAULT 0,
  -- Opening arrears at OC setup (positive = arrears, negative = credit).
  -- Anchored to owners_corporations.opening_balance_date.
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  UNIQUE(oc_id, lot_number)
);

CREATE INDEX idx_lots_oc ON lots(oc_id);

-- ============================================================================
-- 6b. LOT OWNERS — per-lot owner contact records. Joint owners get multiple
-- rows; one owner across multiple lots = duplicated rows. invitation_id links
-- to the pending invite that turns this contact into a portal user.
-- ============================================================================
-- Occupancy status (Item 14/18). Three-state enum is the canonical source of truth.
-- is_occupied_by_owner is retained for back-compat with older readers but should be
-- kept in sync at the application layer with occupancy_status.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lot_occupancy_status') THEN
    CREATE TYPE lot_occupancy_status AS ENUM ('owner_occupied','tenanted','vacant');
  END IF;
END $$;

CREATE TABLE lot_owners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  postal_address TEXT,
  delivery_preference TEXT NOT NULL DEFAULT 'email', -- email | post; post-only owners are excluded from email notify lists
  share_fraction NUMERIC NOT NULL DEFAULT 1.0 CHECK (share_fraction > 0 AND share_fraction <= 1),
  is_occupied_by_owner BOOLEAN NOT NULL DEFAULT true,
  occupancy_status lot_occupancy_status NOT NULL DEFAULT 'owner_occupied',
  ownership_since DATE,  -- when this owner took ownership; nullable for pre-existing rows
  tenant_name TEXT,
  tenant_email TEXT,
  tenant_phone TEXT,
  invitation_id UUID REFERENCES invitations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lot_owners_lot ON lot_owners(lot_id);
CREATE INDEX idx_lot_owners_email ON lot_owners(email) WHERE email IS NOT NULL;

-- ============================================================================
-- 7. OC MEMBERS
-- ============================================================================
CREATE TABLE oc_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id),
  lot_id UUID REFERENCES lots(id),
  role member_role NOT NULL DEFAULT 'lot_owner',
  is_primary_contact BOOLEAN NOT NULL DEFAULT false,
  is_financial BOOLEAN NOT NULL DEFAULT true,
  absent_owner_address TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ
);

CREATE INDEX idx_members_oc ON oc_members(oc_id);
CREATE INDEX idx_members_profile ON oc_members(profile_id);
CREATE INDEX idx_members_lot ON oc_members(lot_id);

-- ============================================================================
-- 8. STATE COMPLIANCE RULES
-- ============================================================================
CREATE TABLE state_compliance_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  state TEXT NOT NULL DEFAULT 'VIC',
  rule_key TEXT NOT NULL,
  rule_value TEXT NOT NULL,
  description TEXT,
  UNIQUE(state, rule_key)
);

-- ============================================================================
-- 9. INVITATIONS
-- Also the pre-acceptance identity for lot owners populated via the wizard.
-- ============================================================================
CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id),
  email TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  role member_role NOT NULL DEFAULT 'lot_owner',
  -- Application-generated 10-char Crockford-32 code (no 0/O/1/I). Used in
  -- the invite URL AND as a typeable code the recipient can enter manually
  -- on /sign-up. 32^10 ≈ 1.1×10^15 combinations; combined with the
  -- rate_limits table this is unbruteforceable.
  code TEXT UNIQUE NOT NULL,
  reference_number TEXT,
  status invitation_status NOT NULL DEFAULT 'pending',
  invited_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX idx_invitations_code ON invitations(code);
CREATE INDEX idx_invitations_oc ON invitations(oc_id);
CREATE INDEX idx_invitations_email ON invitations(email);
CREATE INDEX idx_invitations_lot_status ON invitations(lot_id, status) WHERE lot_id IS NOT NULL;

-- ============================================================================
-- 10. BUDGET CATEGORIES (seed data — COA mapping)
-- ============================================================================
CREATE TABLE budget_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  fund_type fund_type NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- 11. BUDGETS
-- ============================================================================
CREATE TABLE budgets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  financial_year TEXT NOT NULL,
  fund_type fund_type NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status budget_status NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(oc_id, financial_year, fund_type)
);

CREATE INDEX idx_budgets_oc ON budgets(oc_id);

-- ============================================================================
-- 12. BUDGET ITEMS
-- ============================================================================
CREATE TABLE budget_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  budget_id UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES budget_categories(id),
  description TEXT,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  charge_group_id UUID,                             -- FK added after charge_groups
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_budget_items_budget ON budget_items(budget_id);

-- ============================================================================
-- 13. LEVY BATCHES
-- ============================================================================
CREATE TABLE levy_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  budget_id UUID NOT NULL REFERENCES budgets(id),
  financial_year TEXT NOT NULL,
  fund_type fund_type NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  period_label TEXT NOT NULL,                       -- e.g. "Q1 2025-2026"
  due_date DATE NOT NULL,
  -- Date printed as "Issue date" on every notice in the batch. Picked by
  -- the manager in the generate flow (defaults to today client-side), so a
  -- batch raised late can still be dated correctly. NULL only on legacy
  -- rows written before the column existed, those fall back to render day.
  issue_date DATE,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  levy_count INTEGER NOT NULL DEFAULT 0,
  status levy_batch_status NOT NULL DEFAULT 'draft',
  generated_by UUID NOT NULL REFERENCES profiles(id),
  sent_at TIMESTAMPTZ,
  -- Prompt 4 Strategy 4 (keyword + amount): per-batch substring keywords
  -- (e.g. ARRAY['gardening','landscaping']). Empty array = no keyword
  -- matching. Strategy implementation lands in PP4-B.
  match_keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_levy_batches_oc ON levy_batches(oc_id);

-- ============================================================================
-- 14. LEVY NOTICES
-- ============================================================================
CREATE TABLE levy_notices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id),
  lot_id UUID NOT NULL REFERENCES lots(id),
  budget_id UUID REFERENCES budgets(id),
  batch_id UUID REFERENCES levy_batches(id),
  reference_number TEXT NOT NULL,                   -- "LEV-{n}"; per-OC via next_reference_number('LEV', oc_id)
  -- BPAY CRN (Prompt 4): 7-digit zero-padded levy number + MOD10V01 check
  -- digit (8 chars total), generated at notice creation in TS via
  -- generateCrn() in src/lib/reconciliation/bpay-crn.ts. Always populated
  -- regardless of whether the OC has a registered biller code — opt-in BPAY
  -- later requires no backfill. Composite UNIQUE (oc_id, bpay_crn)
  -- below ensures intra-OC uniqueness.
  bpay_crn TEXT,
  fund_type fund_type NOT NULL,
  levy_type levy_type NOT NULL DEFAULT 'regular',
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
  due_date DATE NOT NULL,
  -- Copied from levy_batches.issue_date at creation so a notice can be
  -- re-rendered on its own (escalation senders, /api/levies/{id}/pdf)
  -- without joining the batch. NULL = fall back to the render date.
  issue_date DATE,
  status levy_status NOT NULL DEFAULT 'draft',
  issued_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  pdf_url TEXT,
  linked_levy_id UUID REFERENCES levy_notices(id),  -- penalty_interest → original
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT levy_notices_oc_reference_key UNIQUE (oc_id, reference_number)
);

CREATE INDEX idx_levy_notices_oc ON levy_notices(oc_id);
CREATE INDEX idx_levy_notices_lot ON levy_notices(lot_id);
CREATE INDEX idx_levy_notices_reference ON levy_notices(reference_number);
CREATE INDEX idx_levy_notices_status ON levy_notices(status);
CREATE INDEX idx_levy_notices_due_date ON levy_notices(due_date);
CREATE INDEX idx_levy_notices_batch ON levy_notices(batch_id);
CREATE UNIQUE INDEX idx_levy_notices_bpay_crn
  ON levy_notices (oc_id, bpay_crn)
  WHERE bpay_crn IS NOT NULL;

-- ============================================================================
-- 15. LEVY NOTICE ITEMS
-- ============================================================================
CREATE TABLE levy_notice_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  levy_notice_id UUID NOT NULL REFERENCES levy_notices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_adjustment BOOLEAN NOT NULL DEFAULT false,
  budget_item_id UUID REFERENCES budget_items(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_levy_notice_items_levy ON levy_notice_items(levy_notice_id);

-- ============================================================================
-- 16. PAYMENTS
-- ============================================================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id),
  lot_id UUID NOT NULL REFERENCES lots(id),
  levy_notice_id UUID REFERENCES levy_notices(id),
  reference_number TEXT UNIQUE,                     -- SW-PAY-YYYY-NNNNNN
  fund_type fund_type NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_date DATE NOT NULL,
  payment_method payment_method NOT NULL,
  payment_reference TEXT,
  match_confidence match_confidence,
  bank_transaction_id UUID,                         -- FK added after bank_transactions
  notes TEXT,
  recorded_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_oc ON payments(oc_id);
CREATE INDEX idx_payments_lot ON payments(lot_id);
CREATE INDEX idx_payments_levy ON payments(levy_notice_id);

-- ============================================================================
-- 17. BANK ACCOUNTS
-- ============================================================================
CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  account_name TEXT NOT NULL,
  bsb TEXT NOT NULL,
  account_number TEXT NOT NULL,
  fund_type fund_type NOT NULL,
  bank_name TEXT,                                   -- Macquarie, CBA, NAB, Westpac, ANZ, Bendigo, Other
  opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  opening_balance_date DATE,
  -- BPAY config (Prompt 4): null = BPAY not enabled for this account.
  bpay_biller_code TEXT,                            -- e.g. "1234567"
  bpay_crn_prefix  TEXT,                            -- optional static prefix on per-notice CRNs
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bank_accounts_oc ON bank_accounts(oc_id);

-- ============================================================================
-- 18. BANK TRANSACTIONS
-- ============================================================================
CREATE TABLE bank_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  source bank_txn_source NOT NULL DEFAULT 'manual',
  -- DEFT Reference Number attached to this transaction by Macquarie's TXN/PAY
  -- file. Matched against lot_drns (date-aware) to attribute to a lot.
  deft_reference_number TEXT,
  transaction_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,                    -- positive = credit, negative = debit
  description TEXT,
  balance DECIMAL(12,2),
  category TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched',   -- unmatched | auto_matched | manually_matched | excluded
  matched_payment_id UUID REFERENCES payments(id), -- LEGACY (Prompt 7 cleanup): unused after Prompt 2; see PRE_LAUNCH_CLEANUP.md
  matched_total DECIMAL(12,2) NOT NULL DEFAULT 0,   -- sum of reconciliation_matches.amount_matched; app guard: matched_total <= amount
  excluded_reason TEXT,                             -- required when match_status = 'excluded'
  is_voided BOOLEAN NOT NULL DEFAULT false,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES profiles(id),
  void_reason TEXT,
  notes TEXT,
  -- Fuzzy sender hint (Prompt 4 Strategy 6): stores
  -- { lot_id, canonical_name, similarity } when the orchestrator detects
  -- a Jaro-Winkler similarity ≥ 0.75 against an active payer mapping but
  -- no exact match. Rendered on the unmatched queue row; never auto-matched.
  fuzzy_hint_metadata JSONB,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_bt_excluded_reason
    CHECK ((match_status = 'excluded') = (excluded_reason IS NOT NULL)),
  CONSTRAINT chk_bt_void_fields
    CHECK ((is_voided = true)
           = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);

CREATE INDEX idx_bank_transactions_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bank_transactions_date ON bank_transactions(transaction_date);
CREATE INDEX idx_bank_transactions_deft ON bank_transactions(deft_reference_number)
  WHERE deft_reference_number IS NOT NULL;
CREATE INDEX idx_bank_transactions_match ON bank_transactions(match_status);
CREATE INDEX idx_bank_transactions_active ON bank_transactions(bank_account_id, transaction_date DESC) WHERE is_voided = false;

-- FK: payments → bank_transactions (after both exist)
ALTER TABLE payments ADD CONSTRAINT fk_payments_bank_transaction
  FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id);

-- ============================================================================
-- 18b. FUND TRANSFERS  (inter-fund movement between an OC's funds)
-- Each transfer writes two excluded bank_transactions: a debit on the source
-- fund's account and a credit on the destination's, so per-fund balances
-- re-attribute. For a shared trust account the two legs net to zero on one
-- physical account while still shifting fund attribution. Created atomically
-- by rpc_create_fund_transfer (validates ownership, fund alignment, and that
-- the source fund holds enough — a trust fund must not go negative). Errors
-- are corrected by booking a reverse transfer, never by deleting a row.
-- ============================================================================
CREATE TABLE fund_transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  from_bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  to_bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  from_fund fund_type NOT NULL,
  to_fund fund_type NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  transfer_date DATE NOT NULL,
  reason TEXT,
  from_bank_transaction_id UUID REFERENCES bank_transactions(id),
  to_bank_transaction_id UUID REFERENCES bank_transactions(id),
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES profiles(id),
  CONSTRAINT chk_ft_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_ft_distinct_funds CHECK (from_fund <> to_fund)
);

CREATE INDEX idx_fund_transfers_oc ON fund_transfers(oc_id);

-- ============================================================================
-- 19. MEETINGS
-- ============================================================================
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  reference_number TEXT UNIQUE,                     -- SW-MTG-YYYY-NNNNNN
  meeting_type meeting_type NOT NULL,
  title TEXT NOT NULL,
  date_time TIMESTAMPTZ NOT NULL,
  location TEXT,
  virtual_meeting_link TEXT,
  status meeting_status NOT NULL DEFAULT 'draft',
  notice_sent_at TIMESTAMPTZ,
  notice_pdf_url TEXT,                              -- generated meeting-notice PDF (R2)
  meeting_format TEXT,                              -- in_person | online
  online_platform TEXT,                            -- google_meet | zoom | teams | other
  quorum_met BOOLEAN,
  quorum_percentage DECIMAL(5,2),
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meetings_oc ON meetings(oc_id);
CREATE INDEX idx_meetings_date ON meetings(date_time);

-- ============================================================================
-- 20. AGENDA ITEMS
-- ============================================================================
CREATE TABLE agenda_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  item_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  resolution_type resolution_type NOT NULL DEFAULT 'information',
  motion_text TEXT,
  moved_by UUID REFERENCES profiles(id),
  seconded_by UUID REFERENCES profiles(id),
  result TEXT,
  vote_for_count DECIMAL(10,4) DEFAULT 0,
  vote_against_count DECIMAL(10,4) DEFAULT 0,
  vote_abstain_count DECIMAL(10,4) DEFAULT 0,
  secret_ballot BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agenda_items_meeting ON agenda_items(meeting_id);

-- ============================================================================
-- 21. VOTES
-- ============================================================================
CREATE TABLE votes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agenda_item_id UUID NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id),
  profile_id UUID NOT NULL REFERENCES profiles(id),
  choice vote_choice NOT NULL,
  vote_weight DECIMAL(10,4) NOT NULL,
  is_proxy BOOLEAN NOT NULL DEFAULT false,
  proxy_holder_id UUID REFERENCES profiles(id),
  conflict_of_interest BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agenda_item_id, lot_id)
);

CREATE INDEX idx_votes_agenda ON votes(agenda_item_id);

-- ============================================================================
-- 22. MEETING MINUTES
-- ============================================================================
CREATE TABLE meeting_minutes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) UNIQUE,
  reference_number TEXT UNIQUE,                     -- SW-MIN-YYYY-NNNNNN
  content TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  approved_by UUID REFERENCES profiles(id),
  approved_at TIMESTAMPTZ,
  distributed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 23. PROXIES
-- ============================================================================
CREATE TABLE proxies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id),
  grantor_id UUID NOT NULL REFERENCES profiles(id),
  holder_id UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(meeting_id, lot_id)
);

-- ============================================================================
-- 24. PROXY DIRECTIONS
-- ============================================================================
CREATE TABLE proxy_directions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  proxy_id UUID NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  agenda_item_id UUID NOT NULL REFERENCES agenda_items(id),
  direction vote_choice,
  UNIQUE(proxy_id, agenda_item_id)
);

-- ============================================================================
-- 25. COMMITTEE NOMINATIONS
-- ============================================================================
CREATE TABLE committee_nominations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_item_id UUID NOT NULL REFERENCES agenda_items(id),
  nominee_id UUID NOT NULL REFERENCES profiles(id),
  nominated_by UUID REFERENCES profiles(id),
  position TEXT,
  accepted BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 26. INSURANCE POLICIES
-- ============================================================================
CREATE TABLE insurance_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  reference_number TEXT UNIQUE,                     -- SW-POL-YYYY-NNNNNN
  policy_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  policy_number TEXT,
  sum_insured DECIMAL(14,2),
  premium DECIMAL(12,2),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  document_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_insurance_oc ON insurance_policies(oc_id);

-- ============================================================================
-- 27. INSURANCE CLAIMS
-- ============================================================================
CREATE TABLE insurance_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_id UUID NOT NULL REFERENCES insurance_policies(id),
  reference_number TEXT UNIQUE,                     -- SW-CLM-YYYY-NNNNNN
  description TEXT NOT NULL,
  amount_claimed DECIMAL(12,2),
  amount_received DECIMAL(12,2),
  status TEXT NOT NULL DEFAULT 'lodged',
  lodged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 28. MAINTENANCE REQUESTS
-- ============================================================================
CREATE TABLE maintenance_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  reference_number TEXT UNIQUE,                     -- SW-MNT-YYYY-NNNNNN
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  priority maintenance_priority NOT NULL DEFAULT 'medium',
  status maintenance_status NOT NULL DEFAULT 'submitted',
  fund_type fund_type,
  estimated_cost DECIMAL(12,2),
  actual_cost DECIMAL(12,2),
  contractor_id UUID,                               -- FK added after contractors
  submitted_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_maintenance_oc ON maintenance_requests(oc_id);

-- ============================================================================
-- 29. ANNOUNCEMENTS
-- ============================================================================
CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_announcements_oc ON announcements(oc_id);

-- ============================================================================
-- 30. DOCUMENTS (oc-scoped or lot-scoped)
-- ============================================================================
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE, -- null = oc-level
  category TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  is_confidential BOOLEAN NOT NULL DEFAULT false,
  uploaded_by UUID REFERENCES profiles(id),
  recurring_job_id UUID REFERENCES recurring_jobs(id) ON DELETE SET NULL, -- doc linked to a recurring job
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_oc ON documents(oc_id);
CREATE INDEX idx_documents_category ON documents(category);
CREATE INDEX idx_documents_lot_id ON documents(lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX idx_documents_oc_no_lot ON documents(oc_id) WHERE lot_id IS NULL;

-- ============================================================================
-- 31. COMMUNICATION LOG (evidence trail — ALL outbound comms)
-- ============================================================================
CREATE TABLE communication_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID REFERENCES owners_corporations(id),
  recipient_id UUID REFERENCES profiles(id),
  recipient_email TEXT,
  channel communication_channel NOT NULL,
  type TEXT NOT NULL,
  subject TEXT,
  body_preview TEXT,
  status communication_status NOT NULL DEFAULT 'queued',
  external_id TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  related_entity_type TEXT,
  related_entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comms_oc ON communication_log(oc_id);
CREATE INDEX idx_comms_recipient ON communication_log(recipient_id);
CREATE INDEX idx_comms_type ON communication_log(type);
CREATE INDEX idx_comms_status ON communication_log(status);

-- ============================================================================
-- 32. COMPLAINTS
-- ============================================================================
CREATE TABLE complaints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  reference_number TEXT UNIQUE,                     -- SW-CMP-YYYY-NNNNNN
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  against_member_id UUID REFERENCES profiles(id),
  status complaint_status NOT NULL DEFAULT 'open',
  resolution_notes TEXT,
  submitted_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_complaints_oc ON complaints(oc_id);

-- ============================================================================
-- 33. NOTIFICATIONS (in-app)
-- read_at is the single source of truth (null = unread, timestamp = read).
-- ============================================================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  oc_id UUID REFERENCES owners_corporations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_profile_id ON notifications(profile_id);
CREATE INDEX idx_notifications_profile_unread ON notifications(profile_id) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_oc_id ON notifications(oc_id);
CREATE INDEX idx_notifications_inbox ON notifications(profile_id, created_at DESC);

-- ============================================================================
-- 34. AUDIT LOG (immutable — INSERT only)
-- ============================================================================
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID REFERENCES profiles(id),
  oc_id UUID REFERENCES owners_corporations(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_oc ON audit_log(oc_id);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ============================================================================
-- 35. ESCALATION WORKFLOWS
-- ============================================================================
-- Levy follow-up workflow. Company default = (management_company_id set,
-- oc_id NULL, is_default true). Per-OC override = (oc_id set). OCs follow the
-- company default unless they have their own override (linked-unless-overridden).
CREATE TABLE escalation_workflows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id UUID REFERENCES management_companies(id) ON DELETE CASCADE,
  oc_id UUID REFERENCES owners_corporations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_escalation_wf_company ON escalation_workflows(management_company_id);
CREATE INDEX idx_escalation_wf_oc ON escalation_workflows(oc_id);

-- ============================================================================
-- 36. ESCALATION WORKFLOW STEPS  (editable subject/body with merge fields)
-- ============================================================================
CREATE TABLE escalation_workflow_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_id UUID NOT NULL REFERENCES escalation_workflows(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_type TEXT NOT NULL DEFAULT 'email',          -- email | vcat
  label TEXT,
  days_after_overdue INTEGER NOT NULL,
  subject TEXT,
  body TEXT,                                         -- merge-field template
  attachment_url TEXT,                               -- optional per-step attachment (R2 key)
  attachment_name TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(workflow_id, step_number)
);
CREATE INDEX idx_escalation_steps_wf ON escalation_workflow_steps(workflow_id);

-- ============================================================================
-- 37. ESCALATION INSTANCES  (one active per overdue levy notice)
-- ============================================================================
CREATE TABLE escalation_instances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  levy_notice_id UUID NOT NULL REFERENCES levy_notices(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES escalation_workflows(id),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE CASCADE,
  reference_number TEXT,                            -- SW-ESC-YYYY-NNNNNN
  current_step INTEGER NOT NULL DEFAULT 1,
  status escalation_status NOT NULL DEFAULT 'active',
  next_action_at DATE,
  final_notice_pdf_url TEXT,                        -- R2 key of the s.32 final notice
  final_notice_served_at TIMESTAMPTZ,
  vcat_ready_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_escalation_inst_notice_active ON escalation_instances(levy_notice_id) WHERE status = 'active';
CREATE INDEX idx_escalation_inst_next ON escalation_instances(next_action_at) WHERE status = 'active';
CREATE INDEX idx_escalation_inst_oc ON escalation_instances(oc_id);

-- ============================================================================
-- 37b. VCAT APPLICATION PACKS
-- ============================================================================
CREATE TABLE vcat_packs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  lot_id UUID REFERENCES lots(id) ON DELETE SET NULL,
  levy_notice_id UUID REFERENCES levy_notices(id) ON DELETE SET NULL,
  escalation_instance_id UUID REFERENCES escalation_instances(id) ON DELETE SET NULL,
  zip_key TEXT,                                     -- R2 key (vcat-packs/{ocId}/{packId}.zip)
  status TEXT NOT NULL DEFAULT 'ready',             -- ready | failed
  error TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_vcat_packs_oc ON vcat_packs(oc_id);
CREATE INDEX idx_vcat_packs_lot ON vcat_packs(lot_id);

-- ============================================================================
-- 38. CHARGE GROUPS
-- ============================================================================
CREATE TABLE charge_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE budget_items ADD CONSTRAINT fk_budget_items_charge_group
  FOREIGN KEY (charge_group_id) REFERENCES charge_groups(id);

-- ============================================================================
-- 39. CHARGE GROUP LOTS
-- ============================================================================
CREATE TABLE charge_group_lots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  charge_group_id UUID NOT NULL REFERENCES charge_groups(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  UNIQUE(charge_group_id, lot_id)
);

-- ============================================================================
-- 40. CONTRACTORS  (management-company-wide contact book, reused across OCs)
-- ============================================================================
-- Contractors belong to a management company and are reusable across every OC
-- it manages. oc_id is kept nullable for any legacy OC-specific contractor but
-- is null for company-wide entries. name/phone/email are the PRIMARY CONTACT
-- (app enforces at least one of phone/email). Public-liability cover is
-- mandatory at the app layer (insurer, policy number, coverage limit, expiry).
CREATE TABLE contractors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id UUID REFERENCES management_companies(id) ON DELETE CASCADE,
  oc_id UUID REFERENCES owners_corporations(id) ON DELETE CASCADE, -- legacy/optional OC scope
  business_name TEXT,
  name TEXT NOT NULL,                               -- primary contact name
  company TEXT,
  phone TEXT,                                       -- primary contact phone
  email TEXT,                                       -- primary contact email
  trade TEXT,
  abn TEXT,
  gst_registered BOOLEAN NOT NULL DEFAULT false,
  bank_name TEXT,
  bsb TEXT,
  account_number TEXT,
  pl_insurer TEXT,                                  -- public liability insurer
  pl_policy_number TEXT,
  pl_coverage_limit DECIMAL(16,2),
  pl_document_url TEXT,                             -- optional COC upload (R2)
  insurance_expiry DATE,                            -- public liability expiry
  notes TEXT,
  status contractor_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contractors_company ON contractors(management_company_id);
ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_updated_at_contractors
  BEFORE UPDATE ON contractors FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE maintenance_requests ADD CONSTRAINT fk_maintenance_contractor
  FOREIGN KEY (contractor_id) REFERENCES contractors(id);

-- ============================================================================
-- 40b. RECURRING JOBS  (company-wide maintenance schedule, each tied to one OC)
-- ============================================================================
CREATE TABLE recurring_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  management_company_id UUID NOT NULL REFERENCES management_companies(id) ON DELETE CASCADE,
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  reference_number TEXT UNIQUE,                     -- SW-RJB-YYYY-NNNNNN
  title TEXT NOT NULL,
  trade TEXT,
  contractor_id UUID REFERENCES contractors(id) ON DELETE SET NULL,
  frequency recurring_frequency NOT NULL,
  start_date DATE NOT NULL,
  anchor_day INT,                                   -- day-of-month (1-31) or weekday (0-6)
  end_date DATE,                                    -- null = ongoing
  lead_time_days INT NOT NULL DEFAULT 0,
  notify_scope TEXT NOT NULL DEFAULT 'none',        -- all_owners | specific | none
  scope TEXT,                                       -- work description
  cost_per_visit DECIMAL(12,2),
  fund_type fund_type,                              -- administrative | capital_works
  approval_reference TEXT,                          -- e.g. a meeting motion (wired later)
  status recurring_job_status NOT NULL DEFAULT 'active',
  next_occurrence_date DATE,                        -- cached by cron
  last_notified_occurrence DATE,                    -- idempotency for owner reminders
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurring_jobs_company ON recurring_jobs(management_company_id);
CREATE INDEX idx_recurring_jobs_oc ON recurring_jobs(oc_id);
CREATE INDEX idx_recurring_jobs_next ON recurring_jobs(next_occurrence_date) WHERE status = 'active';
ALTER TABLE recurring_jobs ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_updated_at_recurring_jobs
  BEFORE UPDATE ON recurring_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Editable service schedule + attendance log for a recurring job. The
-- recurrence rule drives suggested upcoming dates; these rows are the
-- explicitly-managed visits (manager-added dates + logged attendance).
CREATE TABLE recurring_job_occurrences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recurring_job_id UUID NOT NULL REFERENCES recurring_jobs(id) ON DELETE CASCADE,
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled | attended | skipped
  notes TEXT,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rjo_job ON recurring_job_occurrences(recurring_job_id);
CREATE INDEX idx_rjo_date ON recurring_job_occurrences(scheduled_date);
ALTER TABLE recurring_job_occurrences ENABLE ROW LEVEL SECURITY;

-- Specific lot-owner recipients for a recurring job (notify_scope='specific').
CREATE TABLE recurring_job_notify_targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recurring_job_id UUID NOT NULL REFERENCES recurring_jobs(id) ON DELETE CASCADE,
  lot_owner_id UUID NOT NULL REFERENCES lot_owners(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (recurring_job_id, lot_owner_id)
);
CREATE INDEX idx_rjnt_job ON recurring_job_notify_targets(recurring_job_id);
ALTER TABLE recurring_job_notify_targets ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 41. PAYMENT PLANS
-- ============================================================================
CREATE TABLE payment_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  levy_notice_id UUID NOT NULL REFERENCES levy_notices(id),
  lot_id UUID NOT NULL REFERENCES lots(id),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id),
  total_amount DECIMAL(12,2) NOT NULL,
  installment_amount DECIMAL(12,2) NOT NULL,
  installment_frequency TEXT NOT NULL,              -- weekly | fortnightly | monthly
  start_date DATE NOT NULL,
  end_date DATE,
  status payment_plan_status NOT NULL DEFAULT 'active',
  approved_by UUID REFERENCES profiles(id),
  approved_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 42. RESERVE FUND ITEMS (10-year capital works plan)
-- ============================================================================
CREATE TABLE reserve_fund_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  estimated_cost DECIMAL(12,2) NOT NULL,
  estimated_year INTEGER NOT NULL,
  priority reserve_priority NOT NULL DEFAULT 'medium',
  status reserve_status NOT NULL DEFAULT 'planned',
  actual_cost DECIMAL(12,2),
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 43. CHAT MESSAGES
-- ============================================================================
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_chat_messages_oc ON chat_messages(oc_id);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);

-- ============================================================================
-- 44. CHAT ATTACHMENTS
-- ============================================================================
CREATE TABLE chat_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 45. CHAT READ STATUS
-- ============================================================================
CREATE TABLE chat_read_status (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(oc_id, profile_id)
);

-- ============================================================================
-- 46. LOT LEDGER ENTRIES  (Prompt 1 — running per-lot debit/credit log)
-- Balance = SUM(active credits) - SUM(active debits).
-- No hard deletes on financial data: voids create an offsetting entry.
-- All writes go through RPCs (rpc_levy_debit, rpc_payment_credit,
-- rpc_ledger_adjustment, rpc_ledger_void, rpc_levy_batch_debit).
-- ============================================================================
CREATE TABLE lot_ledger_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id),
  lot_id UUID NOT NULL REFERENCES lots(id),
  fund_type fund_type NOT NULL,
  entry_type ledger_entry_type NOT NULL,
  category ledger_entry_category NOT NULL,
  amount DECIMAL(12,2) NOT NULL,                              -- always positive; sign from entry_type
  entry_date DATE NOT NULL,                                   -- accounting date (not created_at)
  description TEXT,
  reference TEXT,                                             -- levy ref for levy debits; explicitly-referenced levy for targeted payments
  levy_notice_id UUID REFERENCES levy_notices(id),
  status ledger_entry_status NOT NULL DEFAULT 'active',
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES profiles(id),
  void_reason TEXT,
  voided_by_entry_id UUID REFERENCES lot_ledger_entries(id),  -- offset that voided this entry
  voids_entry_id UUID REFERENCES lot_ledger_entries(id),      -- set on offset entries, points back
  -- Duplicate-payment detection (PP5-D). Set by detectLedgerDuplicate / markLedgerDuplicate
  -- when an incoming payment hashes equal to an existing one within the 7-day window. The
  -- self-FK on duplicate_of is required so PostgREST can resolve the embed used by
  -- loadLotLedger (parent:lot_ledger_entries!duplicate_of(status)).
  duplicate_of UUID REFERENCES lot_ledger_entries(id),
  duplicate_status TEXT CHECK (duplicate_status IN ('suspected','confirmed','rejected')),
  duplicate_metadata JSONB,
  -- Allocation priority (Prompt 4 PP4-A): walker iterates DEBITS in
  -- (allocation_priority ASC, entry_date ASC, created_at ASC) order.
  -- Lower number = walker visits first. Map: interest=1, levy=2,
  -- special_levy=3, adjustment_debit=4, writeoff=4, default 2 for
  -- payment / refund / adjustment_credit / void_offset / future.
  -- Set automatically by the BEFORE INSERT trigger
  -- set_ledger_allocation_priority — callers do NOT need to pass this
  -- field. Credit allocation_priority is currently unread by the walker
  -- (debit-only sort key); reserved for Prompt 6/7 waterfall use.
  allocation_priority INTEGER NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES profiles(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_ledger_type_category CHECK (
    (entry_type = 'debit'  AND category IN ('levy', 'special_levy', 'interest', 'adjustment_debit', 'refund', 'void_offset'))
    OR
    (entry_type = 'credit' AND category IN ('payment', 'writeoff', 'adjustment_credit', 'void_offset'))
  ),
  CONSTRAINT chk_ledger_voided_consistency CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CONSTRAINT chk_ledger_voids_requires_offset CHECK (voids_entry_id IS NULL OR category = 'void_offset')
);

CREATE INDEX idx_ledger_entries_oc ON lot_ledger_entries(oc_id);
CREATE INDEX idx_ledger_entries_lot         ON lot_ledger_entries(lot_id);
CREATE INDEX idx_ledger_entries_lot_date    ON lot_ledger_entries(lot_id, entry_date);
CREATE INDEX idx_ledger_entries_active_lot  ON lot_ledger_entries(lot_id) WHERE status = 'active';
CREATE INDEX idx_ledger_entries_reference   ON lot_ledger_entries(reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_ledger_entries_levy_notice ON lot_ledger_entries(levy_notice_id) WHERE levy_notice_id IS NOT NULL;
CREATE INDEX idx_ledger_entries_duplicate_of ON lot_ledger_entries(duplicate_of) WHERE duplicate_of IS NOT NULL;

-- ============================================================================
-- 47. LOT LEDGER STATE  (Prompt 1 — per-lot materialised balance summary)
-- Maintained by RPC writes calling recompute_lot_ledger_state(lot_id).
-- Convention: negative balance = lot owes money; positive = credit on account.
-- ============================================================================
CREATE TABLE lot_ledger_state (
  lot_id UUID PRIMARY KEY REFERENCES lots(id) ON DELETE CASCADE,
  oc_id UUID NOT NULL REFERENCES owners_corporations(id),
  admin_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  capital_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_balance DECIMAL(12,2) NOT NULL DEFAULT 0,
  oldest_unpaid_date_admin DATE,
  oldest_unpaid_date_capital DATE,
  last_entry_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_state_oc ON lot_ledger_state(oc_id);

-- ============================================================================
-- 48. RECONCILIATION MATCHES  (Prompt 1 scaffold — writes arrive in Prompt 2+)
-- Links bank transactions to ledger credits. Sum of amount_matched for a
-- given bank_transaction_id must not exceed bank_transactions.amount
-- (enforced by RPCs; no DB-level trigger in this prompt).
-- ============================================================================
CREATE TABLE reconciliation_matches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id),
  ledger_entry_id UUID NOT NULL REFERENCES lot_ledger_entries(id),
  amount_matched DECIMAL(12,2) NOT NULL,
  match_method reconciliation_match_method NOT NULL,
  match_confidence match_confidence NOT NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_by UUID REFERENCES profiles(id),                    -- null for system-matched
  notes TEXT,
  -- review_required (Prompt 4 PP4-A): UI-only derived flag. Set true by
  -- the orchestrator for matches whose confidence is amount-based or weak
  -- name-based; queue renders an amber "review suggested" badge and the
  -- queue exposes a "Review suggested auto-matches" filter chip.
  -- match_confidence enum is unchanged — no new value needed.
  review_required BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT chk_recon_amount_positive CHECK (amount_matched > 0),
  UNIQUE (bank_transaction_id, ledger_entry_id)
);

CREATE INDEX idx_recon_matches_bank_txn ON reconciliation_matches(bank_transaction_id);
CREATE INDEX idx_recon_matches_ledger   ON reconciliation_matches(ledger_entry_id);

-- ============================================================================
-- 49. UNDEPOSITED FUNDS ENTRIES  (Prompt 2)
-- Per-oc clearing account for cash/cheque receipts recorded against
-- a lot but not yet deposited to the bank. Receipt entry credits the lot's
-- ledger AND creates a pending_deposit row here. When the real bank deposit
-- arrives, depositUndepositedFunds links the existing credit to the bank
-- transaction via reconciliation_matches — it does NOT create a second credit.
-- ============================================================================
CREATE TABLE undeposited_funds_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id),
  lot_id UUID NOT NULL REFERENCES lots(id),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),       -- where this will be deposited
  fund_type fund_type NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  received_date DATE NOT NULL,
  payment_method payment_method NOT NULL,                           -- constrained to cash|cheque below
  cheque_number TEXT,                                               -- required iff payment_method='cheque'
  receipt_number TEXT NOT NULL,                                     -- "RCP-{n}" via next_reference_number('RCP', oc_id)
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending_deposit',                   -- pending_deposit | deposited | voided
  deposited_at TIMESTAMPTZ,
  deposited_by_bank_transaction_id UUID REFERENCES bank_transactions(id),
  linked_ledger_credit_id UUID NOT NULL REFERENCES lot_ledger_entries(id),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES profiles(id),
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES profiles(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_uf_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_uf_method CHECK (payment_method IN ('cash','cheque')),
  CONSTRAINT chk_uf_cheque_number
    CHECK ((payment_method = 'cheque') = (cheque_number IS NOT NULL)),
  CONSTRAINT chk_uf_status_values
    CHECK (status IN ('pending_deposit','deposited','voided')),
  CONSTRAINT chk_uf_deposited_fields
    CHECK ((status = 'deposited')
           = (deposited_at IS NOT NULL AND deposited_by_bank_transaction_id IS NOT NULL)),
  CONSTRAINT chk_uf_voided_fields
    CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CONSTRAINT undeposited_funds_entries_oc_receipt_key
    UNIQUE (oc_id, receipt_number)
);

CREATE INDEX idx_uf_oc  ON undeposited_funds_entries(oc_id);
CREATE INDEX idx_uf_bank_account ON undeposited_funds_entries(bank_account_id);
CREATE INDEX idx_uf_lot          ON undeposited_funds_entries(lot_id);
CREATE INDEX idx_uf_pending      ON undeposited_funds_entries(bank_account_id, status)
  WHERE status = 'pending_deposit';

-- ============================================================================
-- 50. BASIQ CONNECTIONS  (Prompt 3 — one row per CDR consent per OC)
-- ----------------------------------------------------------------------------
-- Tracks the lifecycle of a Basiq consent from first grant through
-- expiry / reauth / revocation. An OC typically has one active connection
-- at a time; expired/revoked rows are retained for audit.
--
-- LOT DRNs — time-bounded DEFT Reference Number → lot mappings.
-- Macquarie assigns DRNs; one DRN per payer per OC (≈ one per lot). DRNs can
-- be reassigned across owner changes, so we keep historical rows. Live row
-- has active_to IS NULL. Lookups for a transaction date use date-aware joins.
-- ============================================================================
CREATE TABLE lot_drns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  drn TEXT NOT NULL,
  primary_id TEXT,                                  -- usually the payer name from the Macquarie export
  secondary_id TEXT,                                -- usually the lot number reference
  active_from DATE NOT NULL DEFAULT CURRENT_DATE,
  active_to DATE,                                   -- NULL = current
  source TEXT NOT NULL DEFAULT 'macquarie_csv' CHECK (source IN ('macquarie_csv','manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lot_drns_drn ON lot_drns(drn);
CREATE INDEX idx_lot_drns_lot ON lot_drns(lot_id);
CREATE UNIQUE INDEX uq_lot_drns_drn_current ON lot_drns(drn) WHERE active_to IS NULL;

-- ============================================================================
-- 51. LEVY OVERDUE BATCHES — draft + 24h-manager-approval workflow.
-- ----------------------------------------------------------------------------
-- Daily cron generates a DRAFT batch per OC of newly-overdue notices. Manager
-- has 24h to Send or upload a fresh bank import that auto-cancels reconciled
-- rows. After 24h with no action, batch auto-sends.
-- ============================================================================
CREATE TABLE levy_overdue_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','cancelled','expired')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  auto_send_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  notice_count INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  approved_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_overdue_batches_oc_status ON levy_overdue_batches(oc_id, status);

CREATE TABLE levy_overdue_batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES levy_overdue_batches(id) ON DELETE CASCADE,
  levy_notice_id UUID NOT NULL REFERENCES levy_notices(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  amount_due NUMERIC(12,2) NOT NULL,
  days_overdue INTEGER NOT NULL,
  excluded BOOLEAN NOT NULL DEFAULT false,
  exclude_reason TEXT,
  UNIQUE (batch_id, levy_notice_id)
);
CREATE INDEX idx_overdue_items_batch ON levy_overdue_batch_items(batch_id);
CREATE INDEX idx_overdue_items_notice ON levy_overdue_batch_items(levy_notice_id);

-- ============================================================================
-- 53. SUBDIVISION NOTIFICATION SUPPRESSIONS  (Prompt 3 — 48h arrears pause etc.)
-- ----------------------------------------------------------------------------
-- Queried by arrears-email flows (Prompt 6 consumers) before sending.
-- Multiple active rows per oc are legitimate (overlapping
-- suppressions); readers filter WHERE suppressed_until > NOW().
-- ============================================================================
CREATE TABLE oc_notification_suppressions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  suppression_type TEXT NOT NULL CHECK (suppression_type IN (
    'arrears_post_gap_reauth',
    'other_placeholder'
  )),
  suppressed_until TIMESTAMPTZ NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Full index (not partial): Postgres forbids volatile functions like NOW()
-- in index predicates (must be IMMUTABLE). Indexing every row is cheap for
-- this table and the planner still uses the index efficiently for the
-- query-time filter `WHERE suppressed_until > NOW()`.
CREATE INDEX idx_suppressions_oc_active
  ON oc_notification_suppressions(oc_id, suppressed_until);

-- ============================================================================
-- 54. BANK PAYER MAPPINGS  (Prompt 4 PP4-A — canonical sender → lot mapping)
-- ----------------------------------------------------------------------------
-- Used by Strategy 3 (known_payer) and Strategy 6 (fuzzy_hint).
-- Status lifecycle:
--   active     — used by Strategy 3 for auto-match
--   ambiguous  — collision detected (e.g. two lots with the same canonical
--                sender name); manager must resolve before auto-match
--   disabled   — soft-deleted; never auto-matches; doesn't occupy the
--                "active per canonical_name" slot
--
-- Constraint design (resolved Gap 1):
--   - Composite UNIQUE (oc_id, canonical_sender_name, lot_id):
--     one row per (sub, name, lot) tuple. Allows multiple lots to share
--     a canonical name (the ambiguous case) and multiple statuses across
--     time for a given (sub, name, lot).
--   - Partial UNIQUE INDEX on (oc_id, canonical_sender_name)
--     WHERE status = 'active': enforces at-most-one ACTIVE mapping per
--     canonical name per oc. Disabled / ambiguous rows don't
--     occupy this slot, so collision detection can flip both old and
--     new mappings to ambiguous and have all three rows coexist.
--
-- canonical_sender_name is uppercase by construction (canonicaliseSender
-- in TS uppercases). No explicit COLLATE — relying on the canonicaliser's
-- uppercase invariant for case-insensitive matching.
-- ============================================================================
CREATE TABLE bank_payer_mappings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  oc_id UUID NOT NULL REFERENCES owners_corporations(id) ON DELETE CASCADE,
  canonical_sender_name TEXT NOT NULL,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ambiguous', 'disabled')),
  status_reason TEXT,
  raw_examples JSONB NOT NULL DEFAULT '[]'::jsonb,            -- recent raw description samples
  created_by UUID NOT NULL REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bank_payer_mappings_oc_canonical_lot_key
    UNIQUE (oc_id, canonical_sender_name, lot_id)
);

CREATE UNIQUE INDEX idx_payer_mappings_oc_active
  ON bank_payer_mappings (oc_id, canonical_sender_name)
  WHERE status = 'active';

CREATE INDEX idx_payer_mappings_lot
  ON bank_payer_mappings (lot_id);                            -- ownership-change sweep

-- ============================================================================
-- WAITLIST SIGNUPS (pre-launch)
-- ----------------------------------------------------------------------------
-- Captures email addresses from the public landing page during the pre-launch
-- waitlist period (sign-up flow disabled). Writes go through the service-role
-- server action only — RLS is on with no policies, so anon/authenticated have
-- zero direct access. A copy of each submission is also emailed to the
-- operator (SEND_TO env var) at submit time.
-- ============================================================================
CREATE TABLE waitlist_signups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  name TEXT,
  company TEXT,
  role TEXT,
  source TEXT,
  ip_address TEXT,
  user_agent TEXT,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT waitlist_signups_email_lower_unique UNIQUE (email)
);

CREATE INDEX idx_waitlist_signups_created_at ON waitlist_signups (created_at DESC);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-calculate OC tier from total_lots (VIC-legal thresholds).
CREATE OR REPLACE FUNCTION calculate_oc_tier()
RETURNS TRIGGER AS $$
BEGIN
  NEW.oc_tier := CASE
    WHEN NEW.total_lots <= 2   THEN 5
    WHEN NEW.total_lots <= 12  THEN 4
    WHEN NEW.total_lots <= 50  THEN 3
    WHEN NEW.total_lots <= 100 THEN 2
    ELSE 1
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calculate_oc_tier
  BEFORE INSERT OR UPDATE OF total_lots ON owners_corporations
  FOR EACH ROW EXECUTE FUNCTION calculate_oc_tier();

-- Auto-calculate next AGM due.
CREATE OR REPLACE FUNCTION calculate_next_agm_due()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.last_agm_date IS NOT NULL THEN
    NEW.next_agm_due := NEW.last_agm_date + INTERVAL '15 months';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calculate_next_agm_due
  BEFORE INSERT OR UPDATE OF last_agm_date ON owners_corporations
  FOR EACH ROW EXECUTE FUNCTION calculate_next_agm_due();

-- Generic updated_at trigger.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_updated_at_management_companies BEFORE UPDATE ON management_companies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_profiles            BEFORE UPDATE ON profiles            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_owners_corporations        BEFORE UPDATE ON owners_corporations        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_budgets             BEFORE UPDATE ON budgets             FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_levy_notices        BEFORE UPDATE ON levy_notices        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_bank_accounts       BEFORE UPDATE ON bank_accounts       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_meetings            BEFORE UPDATE ON meetings            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_meeting_minutes     BEFORE UPDATE ON meeting_minutes     FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_insurance_policies  BEFORE UPDATE ON insurance_policies  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_maintenance_requests BEFORE UPDATE ON maintenance_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_complaints          BEFORE UPDATE ON complaints          FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_escalation_instances BEFORE UPDATE ON escalation_instances FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_charge_groups       BEFORE UPDATE ON charge_groups       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_updated_at_bank_payer_mappings BEFORE UPDATE ON bank_payer_mappings FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed a zero-balance lot_ledger_state row whenever a new lot is inserted.
CREATE OR REPLACE FUNCTION create_lot_trigger_ledger_state()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO lot_ledger_state (lot_id, oc_id, admin_balance, capital_balance, total_balance)
  VALUES (NEW.id, NEW.oc_id, 0, 0, 0)
  ON CONFLICT (lot_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lot_ledger_state_create
  AFTER INSERT ON lots
  FOR EACH ROW EXECUTE FUNCTION create_lot_trigger_ledger_state();

-- Auto-derive allocation_priority from category on lot_ledger_entries INSERT.
-- The walker reads allocation_priority on debits; the RPC bodies don't set
-- the column, so without this trigger every inserted row would land at the
-- column DEFAULT (2) regardless of category. Always overwrites — the
-- category-based map is the canonical source of truth.
CREATE OR REPLACE FUNCTION set_ledger_allocation_priority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.allocation_priority := CASE NEW.category
    WHEN 'interest'         THEN 1
    WHEN 'levy'             THEN 2
    WHEN 'special_levy'     THEN 3
    WHEN 'adjustment_debit' THEN 4
    WHEN 'writeoff'         THEN 4
    ELSE 2  -- payment, refund, adjustment_credit, void_offset.
            -- Credit allocation_priority is currently unread by the walker
            -- (debit-only sort key); reserved for Prompt 6/7 waterfall use.
            -- If Prompt 6/7 needs credit priority, REVISIT this default —
            -- a refund of interest probably wants priority=1, not 2.
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_set_ledger_allocation_priority
  BEFORE INSERT ON lot_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION set_ledger_allocation_priority();

-- ============================================================================
-- LEDGER FUNCTIONS  (Prompt 1, walker rewritten in Prompt 4 PP4-A)
-- ----------------------------------------------------------------------------
-- _walk_oldest_unpaid: per-fund walker. Returns the entry_date of the first
-- debit not fully covered by (explicitly-targeted credits for that debit) +
-- (free credit pool). Targeted = credit.levy_notice_id or credit.reference
-- matches the debit. Free = both NULL. Excess targeted credit does NOT spill
-- into the free pool (spec §4.4).
--
-- WALKER SEMANTICS (Prompt 4 PP4-A):
-- The walker iterates active debits in PRIORITY order, then date, then insert
-- order: ORDER BY (allocation_priority ASC, entry_date ASC, created_at ASC).
-- Categories map to priorities via set_ledger_allocation_priority trigger:
--   interest=1, levy=2, special_levy=3, adjustment_debit/writeoff=4.
-- Free credits absorb regular levies (priority 2) before special levies
-- (priority 3) and statutory interest (priority 1) before either. For lots
-- with only regular levies (the common case), date-priority and date-only
-- walks produce the same result.
--
-- Targeted-credit bypass (unchanged from Prompt 1): credits with
-- levy_notice_id set or with a `reference` string matching the debit's
-- reference are "pinned" to that debit. They do NOT spill into the free
-- pool when they exceed the debit's amount.
--
-- Pre-launch lock: this semantic is locked once we have customer data.
-- Future changes to allocation_priority logic require migrating stored
-- oldest_unpaid_date values across all mixed-debit lots. See
-- PRE_LAUNCH_CLEANUP.md.
-- ============================================================================
CREATE OR REPLACE FUNCTION _walk_oldest_unpaid(p_lot_id uuid, p_fund fund_type)
RETURNS date
LANGUAGE plpgsql
AS $$
DECLARE
  v_free_pool decimal(12,2) := 0;
  v_debit RECORD;
  v_targeted decimal(12,2);
  v_needed decimal(12,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0)
    INTO v_free_pool
    FROM lot_ledger_entries
   WHERE lot_id = p_lot_id
     AND fund_type = p_fund
     AND status = 'active'
     AND entry_type = 'credit'
     AND levy_notice_id IS NULL
     AND reference IS NULL;

  FOR v_debit IN
    SELECT id, amount, entry_date, levy_notice_id, reference
      FROM lot_ledger_entries
     WHERE lot_id = p_lot_id
       AND fund_type = p_fund
       AND status = 'active'
       AND entry_type = 'debit'
     ORDER BY allocation_priority ASC, entry_date ASC, created_at ASC
  LOOP
    SELECT COALESCE(SUM(c.amount), 0)
      INTO v_targeted
      FROM lot_ledger_entries c
     WHERE c.lot_id = p_lot_id
       AND c.fund_type = p_fund
       AND c.status = 'active'
       AND c.entry_type = 'credit'
       AND (
         (c.levy_notice_id IS NOT NULL AND c.levy_notice_id = v_debit.levy_notice_id)
         OR (c.reference IS NOT NULL AND v_debit.reference IS NOT NULL AND c.reference = v_debit.reference)
       );

    IF v_targeted >= v_debit.amount THEN
      CONTINUE;
    END IF;

    v_needed := v_debit.amount - v_targeted;
    IF v_free_pool >= v_needed THEN
      v_free_pool := v_free_pool - v_needed;
    ELSE
      RETURN v_debit.entry_date;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

-- ============================================================================
-- _walk_per_notice_status  (Prompt 4 PP4-A — snapshot-aware payment status)
-- ----------------------------------------------------------------------------
-- Returns one row per levy_notice on the lot, with the notice's effective
-- payment status AT p_as_of_date. Wrapped by computeLevyPaymentStatus in
-- src/lib/reconciliation/payment-status.ts. Prompt 7 certificate rendering
-- MUST call the TS wrapper rather than reading levy_notices.status directly
-- — the walker is the single source of truth for "is this notice paid as
-- of date X".
--
-- Visibility rules for ledger entries at the snapshot point:
--   - entry_date <= p_as_of_date            (date filter)
--   - status = 'active'                     OR
--     status = 'voided' AND voided_at::date > p_as_of_date  (snapshot rule:
--     entries voided AFTER the snapshot still appear active in it)
--   - void_offset entries follow the same rules; if entry_date is past the
--     snapshot they are excluded by the date filter, which is the intended
--     behaviour (the offset did not exist yet at the snapshot point).
--
-- voided_at is TIMESTAMPTZ. The cast voided_at::date evaluates the void's
-- wall-clock date in session timezone. For dev DB (UTC) and production
-- (Supabase UTC) this matches the day on which the manager pressed Void.
-- See PRE_LAUNCH_CLEANUP.md for the precision-upgrade note (explicit AT
-- TIME ZONE 'Australia/Melbourne' before high-stakes certificate use).
--
-- Per-notice algorithm (independent of _walk_oldest_unpaid by design —
-- different output shape, different filter, different consumers; see
-- Gap 4 resolution):
--   1. Iterate notices for the lot, ordered by due_date.
--   2. Sum visible credits that target the notice (levy_notice_id link
--      OR reference string match).
--   3. Status:
--        paid_amount >= notice.amount  → 'paid'
--        paid_amount > 0               → 'partially_paid' (paid_date = NULL)
--        else                          → 'outstanding'    (paid_date = NULL)
--   4. paid_date for 'paid' notices: walk qualifying credits in
--      chronological order (entry_date ASC, created_at ASC) and return
--      the entry_date of the credit whose cumulative sum first reaches
--      notice.amount. NOT MAX(entry_date) — that gives the latest credit
--      even when an earlier overpayment had already settled the notice.
--      Example: $500 notice, $600 credit on Day3 + $600 credit on Day5 →
--      paid_date = Day3 (Day3 alone covered the notice).
--   5. outstanding_amount = GREATEST(notice.amount - paid_amount, 0).
--      Excess targeted credits do NOT push outstanding negative.
--
-- LOCK-STEP-FILTER INVARIANT:
--   The two SELECT statements below (total-sum and settling-credit walk)
--   share an identical void-snapshot filter predicate. If either filter
--   is modified, the other MUST be modified in lockstep to maintain
--   consistent snapshot semantics. A divergence (e.g. tightening the
--   total-sum filter without tightening the walk) would produce notices
--   marked 'paid' whose settling-credit walk finds no qualifying credit,
--   silently returning paid_date=NULL on a paid notice.
--
-- DEPENDENCY ON rpc_ledger_void CONVENTION:
--   Snapshot semantics rely on rpc_ledger_void's invariant that
--   void_offset.entry_date = CURRENT_DATE (the void's wall-clock date),
--   NOT the original entry's date. If rpc_ledger_void changes this
--   convention, snapshot filter semantics break. The
--   entry_date <= p_as_of_date predicate is what excludes voids made
--   after asOfDate; if the offset inherited the original entry's date,
--   it would be visible at any snapshot in which the original was
--   visible, double-counting the credit's reversal at exactly the
--   wrong moment.
-- ============================================================================
-- PP4-C rewrite: single-CTE SQL replacing the per-notice plpgsql FOR loop.
-- The original implementation issued 1× SUM + 1× chronological FOR-loop per
-- notice (2× SQL round trips per notice → O(n) per call). With realistic
-- credit density (~3 credits per paid notice) this hit 546ms cold for a
-- 100-notice lot — past the 500ms ship gate. The CTE form folds all
-- aggregation + settling into one planner pass and runs in well under
-- 100ms on the same fixture.
--
-- Semantic invariants preserved exactly:
--   - Visibility: entry_date <= p_as_of_date AND
--     (status = 'active' OR (status = 'voided' AND voided_at::date > p_as_of_date))
--   - Credit-to-notice match: (levy_notice_id = n.id) OR
--                             (reference = n.reference_number AND fund_type = n.fund_type)
--   - Settling date = the entry_date of the FIRST credit whose chronological
--     running total reaches the notice amount (ordered entry_date ASC,
--     created_at ASC). MIN(entry_date) over rows WHERE running_total >= amount
--     yields the same date the original plpgsql EXIT branch returned.
CREATE OR REPLACE FUNCTION _walk_per_notice_status(
  p_lot_id     uuid,
  p_as_of_date date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  notice_id          uuid,
  reference_number   text,
  fund_type          fund_type,
  due_date           date,
  amount             numeric,
  status             text,
  paid_date          date,
  paid_amount        numeric,
  outstanding_amount numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH lot_notices AS (
    SELECT n.id, n.reference_number, n.fund_type, n.due_date, n.amount, n.created_at
      FROM levy_notices n
     WHERE n.lot_id = p_lot_id
  ),
  visible_credits AS (
    SELECT
      c.entry_date,
      c.created_at,
      c.amount,
      n.id     AS notice_id,
      n.amount AS notice_amount
      FROM lot_ledger_entries c
      JOIN lot_notices n
        ON n.fund_type = c.fund_type
       AND (
         (c.levy_notice_id IS NOT NULL AND c.levy_notice_id = n.id)
         OR (c.reference IS NOT NULL AND c.reference = n.reference_number)
       )
     WHERE c.lot_id     = p_lot_id
       AND c.entry_type = 'credit'
       AND c.entry_date <= p_as_of_date
       AND (
         (c.status = 'active')
         OR (c.status = 'voided' AND c.voided_at::date > p_as_of_date)
       )
  ),
  notice_paid AS (
    SELECT vc.notice_id, SUM(vc.amount) AS paid_amount
      FROM visible_credits vc
     GROUP BY vc.notice_id
  ),
  notice_running AS (
    SELECT
      vc.notice_id,
      vc.entry_date,
      vc.notice_amount,
      SUM(vc.amount) OVER (
        PARTITION BY vc.notice_id
        ORDER BY vc.entry_date ASC, vc.created_at ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS running_total
      FROM visible_credits vc
  ),
  notice_settled AS (
    SELECT notice_id, MIN(entry_date) AS settled_date
      FROM notice_running
     WHERE running_total >= notice_amount
     GROUP BY notice_id
  )
  SELECT
    n.id                                                     AS notice_id,
    n.reference_number,
    n.fund_type,
    n.due_date,
    n.amount,
    CASE
      WHEN COALESCE(np.paid_amount, 0) >= n.amount THEN 'paid'
      WHEN COALESCE(np.paid_amount, 0) > 0         THEN 'partially_paid'
      ELSE                                              'outstanding'
    END                                                      AS status,
    CASE
      WHEN COALESCE(np.paid_amount, 0) >= n.amount THEN ns.settled_date
      ELSE NULL
    END                                                      AS paid_date,
    COALESCE(np.paid_amount, 0)                              AS paid_amount,
    GREATEST(n.amount - COALESCE(np.paid_amount, 0), 0)      AS outstanding_amount
    FROM lot_notices n
    LEFT JOIN notice_paid    np ON np.notice_id = n.id
    LEFT JOIN notice_settled ns ON ns.notice_id = n.id
   ORDER BY n.due_date ASC, n.created_at ASC;
$$;

-- Recompute lot_ledger_state from scratch for one lot. Called by every
-- ledger RPC after its write, and intended for end-of-day sweeps.
CREATE OR REPLACE FUNCTION recompute_lot_ledger_state(p_lot_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_oc uuid;
  v_admin decimal(12,2);
  v_capital decimal(12,2);
  v_oldest_admin date;
  v_oldest_capital date;
  v_last_entry timestamptz;
BEGIN
  SELECT oc_id INTO v_oc FROM lots WHERE id = p_lot_id;
  IF v_oc IS NULL THEN
    RAISE EXCEPTION 'recompute_lot_ledger_state: lot % not found', p_lot_id;
  END IF;

  -- Balance = sum of ALL credits − sum of ALL debits (active + voided).
  -- When an entry is voided, an offsetting entry of opposite type is inserted;
  -- both remain in the ledger permanently and cancel in the sum. Filtering
  -- by status here would double-count every reversal (once by excluding the
  -- voided original and again by including the offset). See CONTEXT.md §4.2.
  SELECT COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END), 0)
    INTO v_admin
    FROM lot_ledger_entries
   WHERE lot_id = p_lot_id AND fund_type = 'administrative';

  SELECT COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END), 0)
    INTO v_capital
    FROM lot_ledger_entries
   WHERE lot_id = p_lot_id AND fund_type = 'capital_works';

  -- The walker filters to status='active' internally — voided debits aren't
  -- walked as arrears, and their offset credits stay out of the free pool.
  v_oldest_admin   := _walk_oldest_unpaid(p_lot_id, 'administrative');
  v_oldest_capital := _walk_oldest_unpaid(p_lot_id, 'capital_works');

  -- last_entry_at tracks the most recent insert-time activity on the lot,
  -- including voids (which are themselves meaningful manager activity).
  SELECT MAX(created_at) INTO v_last_entry
    FROM lot_ledger_entries
   WHERE lot_id = p_lot_id;

  INSERT INTO lot_ledger_state (
    lot_id, oc_id, admin_balance, capital_balance, total_balance,
    oldest_unpaid_date_admin, oldest_unpaid_date_capital, last_entry_at, updated_at
  ) VALUES (
    p_lot_id, v_oc, v_admin, v_capital, v_admin + v_capital,
    v_oldest_admin, v_oldest_capital, v_last_entry, NOW()
  )
  ON CONFLICT (lot_id) DO UPDATE SET
    oc_id             = EXCLUDED.oc_id,
    admin_balance              = EXCLUDED.admin_balance,
    capital_balance            = EXCLUDED.capital_balance,
    total_balance              = EXCLUDED.total_balance,
    oldest_unpaid_date_admin   = EXCLUDED.oldest_unpaid_date_admin,
    oldest_unpaid_date_capital = EXCLUDED.oldest_unpaid_date_capital,
    last_entry_at              = EXCLUDED.last_entry_at,
    updated_at                 = NOW();
END;
$$;

-- rpc_levy_debit: write a debit for a single levy notice. Idempotent by
-- (levy_notice_id, status='active'): if an active debit already exists,
-- returns that id without inserting.
CREATE OR REPLACE FUNCTION rpc_levy_debit(
  p_oc_id uuid,
  p_lot_id uuid,
  p_fund_type fund_type,
  p_amount decimal,
  p_entry_date date,
  p_description text,
  p_reference text,
  p_levy_notice_id uuid,
  p_category ledger_entry_category,
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing uuid;
  v_new_id uuid;
  v_notice_lot uuid;
  v_after jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'rpc_levy_debit: amount must be positive';
  END IF;
  IF p_category NOT IN ('levy', 'special_levy') THEN
    RAISE EXCEPTION 'rpc_levy_debit: category must be levy or special_levy, got %', p_category;
  END IF;
  IF p_levy_notice_id IS NULL THEN
    RAISE EXCEPTION 'rpc_levy_debit: p_levy_notice_id is required';
  END IF;

  SELECT lot_id INTO v_notice_lot FROM levy_notices WHERE id = p_levy_notice_id;
  IF v_notice_lot IS NULL THEN
    RAISE EXCEPTION 'rpc_levy_debit: levy_notice % not found', p_levy_notice_id;
  END IF;
  IF v_notice_lot <> p_lot_id THEN
    RAISE EXCEPTION 'rpc_levy_debit: levy_notice % does not belong to lot %', p_levy_notice_id, p_lot_id;
  END IF;

  SELECT id INTO v_existing
    FROM lot_ledger_entries
   WHERE levy_notice_id = p_levy_notice_id
     AND entry_type = 'debit'
     AND status = 'active'
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  INSERT INTO lot_ledger_entries (
    oc_id, lot_id, fund_type, entry_type, category,
    amount, entry_date, description, reference, levy_notice_id,
    status, created_by
  ) VALUES (
    p_oc_id, p_lot_id, p_fund_type, 'debit', p_category,
    p_amount, p_entry_date, p_description, p_reference, p_levy_notice_id,
    'active', p_created_by
  ) RETURNING id INTO v_new_id;

  PERFORM recompute_lot_ledger_state(p_lot_id);

  SELECT to_jsonb(e) INTO v_after FROM lot_ledger_entries e WHERE id = v_new_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, after_state)
  VALUES (p_created_by, p_oc_id, 'ledger.debit.created', 'lot_ledger_entry', v_new_id, v_after);

  RETURN v_new_id;
END;
$$;

-- rpc_payment_credit: write a payment credit. Does NOT create
-- reconciliation_matches rows (that is a separate concern owned by Prompt 2+).
CREATE OR REPLACE FUNCTION rpc_payment_credit(
  p_oc_id uuid,
  p_lot_id uuid,
  p_fund_type fund_type,
  p_amount decimal,
  p_entry_date date,
  p_description text,
  p_reference text,
  p_levy_notice_id uuid,
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_id uuid;
  v_after jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'rpc_payment_credit: amount must be positive';
  END IF;

  INSERT INTO lot_ledger_entries (
    oc_id, lot_id, fund_type, entry_type, category,
    amount, entry_date, description, reference, levy_notice_id,
    status, created_by
  ) VALUES (
    p_oc_id, p_lot_id, p_fund_type, 'credit', 'payment',
    p_amount, p_entry_date, p_description, p_reference, p_levy_notice_id,
    'active', p_created_by
  ) RETURNING id INTO v_new_id;

  PERFORM recompute_lot_ledger_state(p_lot_id);

  SELECT to_jsonb(e) INTO v_after FROM lot_ledger_entries e WHERE id = v_new_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, after_state)
  VALUES (p_created_by, p_oc_id, 'ledger.credit.created', 'lot_ledger_entry', v_new_id, v_after);

  RETURN v_new_id;
END;
$$;

-- rpc_ledger_adjustment: operator-entered debit or credit for
-- writeoff / refund / adjustment. Description is mandatory.
CREATE OR REPLACE FUNCTION rpc_ledger_adjustment(
  p_oc_id uuid,
  p_lot_id uuid,
  p_fund_type fund_type,
  p_entry_type ledger_entry_type,
  p_category ledger_entry_category,
  p_amount decimal,
  p_entry_date date,
  p_description text,
  p_created_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_id uuid;
  v_after jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'rpc_ledger_adjustment: amount must be positive';
  END IF;
  IF p_description IS NULL OR length(trim(p_description)) = 0 THEN
    RAISE EXCEPTION 'rpc_ledger_adjustment: description is required';
  END IF;
  IF p_category NOT IN ('adjustment_debit', 'writeoff', 'adjustment_credit', 'refund') THEN
    RAISE EXCEPTION 'rpc_ledger_adjustment: category must be adjustment_debit / writeoff / adjustment_credit / refund, got %', p_category;
  END IF;
  IF p_entry_type = 'debit' AND p_category NOT IN ('adjustment_debit', 'refund') THEN
    RAISE EXCEPTION 'rpc_ledger_adjustment: category % incompatible with debit entry_type', p_category;
  END IF;
  IF p_entry_type = 'credit' AND p_category NOT IN ('adjustment_credit', 'writeoff') THEN
    RAISE EXCEPTION 'rpc_ledger_adjustment: category % incompatible with credit entry_type', p_category;
  END IF;

  INSERT INTO lot_ledger_entries (
    oc_id, lot_id, fund_type, entry_type, category,
    amount, entry_date, description, status, created_by
  ) VALUES (
    p_oc_id, p_lot_id, p_fund_type, p_entry_type, p_category,
    p_amount, p_entry_date, p_description, 'active', p_created_by
  ) RETURNING id INTO v_new_id;

  PERFORM recompute_lot_ledger_state(p_lot_id);

  SELECT to_jsonb(e) INTO v_after FROM lot_ledger_entries e WHERE id = v_new_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, after_state)
  VALUES (p_created_by, p_oc_id, 'ledger.adjustment.created', 'lot_ledger_entry', v_new_id, v_after);

  RETURN v_new_id;
END;
$$;

-- rpc_ledger_void: soft-void an entry by creating an inverted 'void_offset'
-- entry. Locks FOR UPDATE. If the original was a levy/special_levy debit,
-- flips levy_notices.status → written_off. Surfaces any linked
-- reconciliation_matches ids via audit_log.metadata (unmatching happens in
-- Prompt 2+ reconciliation code, not here).
CREATE OR REPLACE FUNCTION rpc_ledger_void(
  p_entry_id uuid,
  p_reason text,
  p_voided_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_original lot_ledger_entries%ROWTYPE;
  v_offset_id uuid;
  v_offset_type ledger_entry_type;
  v_linked_match_ids uuid[];
  v_before jsonb;
  v_after jsonb;
  v_old_notice_status levy_status;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'rpc_ledger_void: reason is required';
  END IF;

  SELECT * INTO v_original
    FROM lot_ledger_entries
   WHERE id = p_entry_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_ledger_void: entry % not found', p_entry_id;
  END IF;
  IF v_original.status = 'voided' THEN
    RAISE EXCEPTION 'rpc_ledger_void: entry % is already voided', p_entry_id;
  END IF;
  IF v_original.category = 'void_offset' THEN
    RAISE EXCEPTION 'rpc_ledger_void: cannot void an offset entry %', p_entry_id;
  END IF;

  v_before := to_jsonb(v_original);
  v_offset_type := CASE WHEN v_original.entry_type = 'debit'
                        THEN 'credit'::ledger_entry_type
                        ELSE 'debit'::ledger_entry_type END;

  INSERT INTO lot_ledger_entries (
    oc_id, lot_id, fund_type, entry_type, category,
    amount, entry_date, description, reference, levy_notice_id,
    voids_entry_id, status, created_by
  ) VALUES (
    v_original.oc_id, v_original.lot_id, v_original.fund_type, v_offset_type, 'void_offset',
    v_original.amount, CURRENT_DATE,
    'Void of entry ' || p_entry_id::text || ': ' || p_reason,
    v_original.reference, v_original.levy_notice_id,
    p_entry_id, 'active', p_voided_by
  ) RETURNING id INTO v_offset_id;

  UPDATE lot_ledger_entries
     SET status             = 'voided',
         voided_at          = NOW(),
         voided_by          = p_voided_by,
         void_reason        = p_reason,
         voided_by_entry_id = v_offset_id
   WHERE id = p_entry_id;

  IF v_original.category IN ('levy', 'special_levy') AND v_original.levy_notice_id IS NOT NULL THEN
    SELECT status INTO v_old_notice_status FROM levy_notices WHERE id = v_original.levy_notice_id;
    UPDATE levy_notices SET status = 'written_off', updated_at = NOW() WHERE id = v_original.levy_notice_id;
    INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state, metadata)
    VALUES (p_voided_by, v_original.oc_id, 'levy_notice.written_off', 'levy_notice', v_original.levy_notice_id,
            jsonb_build_object('status', v_old_notice_status),
            jsonb_build_object('status', 'written_off'),
            jsonb_build_object('caused_by_ledger_void_id', p_entry_id, 'offset_entry_id', v_offset_id));
  END IF;

  PERFORM recompute_lot_ledger_state(v_original.lot_id);

  SELECT array_agg(id) INTO v_linked_match_ids
    FROM reconciliation_matches
   WHERE ledger_entry_id = p_entry_id;

  SELECT to_jsonb(e) INTO v_after FROM lot_ledger_entries e WHERE id = p_entry_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (p_voided_by, v_original.oc_id, 'ledger.entry.voided', 'lot_ledger_entry', p_entry_id,
          v_before, v_after,
          jsonb_build_object(
            'reason', p_reason,
            'offset_entry_id', v_offset_id,
            'linked_reconciliation_match_ids', COALESCE(to_jsonb(v_linked_match_ids), 'null'::jsonb)
          ));

  RETURN v_offset_id;
END;
$$;

-- rpc_levy_batch_debit: atomic per-batch debit writer. FOR UPDATE lock on the
-- batch row is non-negotiable. Idempotent: per-notice dedup means partial
-- retries after a failure simply pick up the remaining notices. Returns
-- { created, skipped_existing } as jsonb.
CREATE OR REPLACE FUNCTION rpc_levy_batch_debit(
  p_batch_id uuid,
  p_created_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch levy_batches%ROWTYPE;
  v_notice RECORD;
  v_existing uuid;
  v_new_id uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_lot_ids uuid[] := ARRAY[]::uuid[];
  v_lot uuid;
  v_category ledger_entry_category;
BEGIN
  SELECT * INTO v_batch
    FROM levy_batches
   WHERE id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_levy_batch_debit: batch % not found', p_batch_id;
  END IF;
  IF v_batch.status <> 'draft' THEN
    RAISE EXCEPTION 'rpc_levy_batch_debit: batch % has status %; expected draft', p_batch_id, v_batch.status;
  END IF;

  FOR v_notice IN
    SELECT id, oc_id, lot_id, fund_type, amount, period_start, reference_number, levy_type
      FROM levy_notices
     WHERE batch_id = p_batch_id
  LOOP
    SELECT id INTO v_existing
      FROM lot_ledger_entries
     WHERE levy_notice_id = v_notice.id
       AND entry_type = 'debit'
       AND status = 'active'
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_category := CASE WHEN v_notice.levy_type = 'special'
                       THEN 'special_levy'::ledger_entry_category
                       ELSE 'levy'::ledger_entry_category END;

    INSERT INTO lot_ledger_entries (
      oc_id, lot_id, fund_type, entry_type, category,
      amount, entry_date, description, reference, levy_notice_id,
      status, created_by
    ) VALUES (
      v_notice.oc_id, v_notice.lot_id, v_notice.fund_type, 'debit', v_category,
      v_notice.amount, v_notice.period_start,
      'Levy ' || v_notice.reference_number, v_notice.reference_number, v_notice.id,
      'active', p_created_by
    ) RETURNING id INTO v_new_id;

    v_created := v_created + 1;
    IF NOT (v_notice.lot_id = ANY(v_lot_ids)) THEN
      v_lot_ids := array_append(v_lot_ids, v_notice.lot_id);
    END IF;
  END LOOP;

  FOREACH v_lot IN ARRAY v_lot_ids LOOP
    PERFORM recompute_lot_ledger_state(v_lot);
  END LOOP;

  UPDATE levy_batches SET status = 'ledger_written' WHERE id = p_batch_id;

  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, metadata)
  VALUES (p_created_by, v_batch.oc_id, 'ledger.levy_batch.generated', 'levy_batch', p_batch_id,
          jsonb_build_object('created', v_created, 'skipped_existing', v_skipped));

  RETURN jsonb_build_object('created', v_created, 'skipped_existing', v_skipped);
END;
$$;

-- ============================================================================
-- RECONCILIATION RPCs  (Prompt 2)
-- ----------------------------------------------------------------------------
-- All six RPCs below operate on a locked bank_transactions row and write to
-- audit_log. They enforce the matching contract end-to-end — no code outside
-- these RPCs should ever insert into reconciliation_matches or mutate
-- bank_transactions.matched_total / match_status / is_voided / excluded_reason.
-- ============================================================================

-- rpc_reconcile_bank_transaction: the core matching primitive. Creates one
-- ledger credit per allocation AND one reconciliation_matches row per credit,
-- atomically. Partial matches are allowed (matched_total < amount stays
-- 'unmatched'); a transaction becomes 'manually_matched' / 'auto_matched'
-- (based on p_match_method) only when matched_total reaches amount — the
-- LATEST completing method wins (per-match provenance is preserved on the
-- reconciliation_matches row).
CREATE OR REPLACE FUNCTION rpc_reconcile_bank_transaction(
  p_bank_transaction_id uuid,
  p_allocations jsonb,
  p_match_method reconciliation_match_method,
  p_match_confidence match_confidence,
  p_notes text,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_bt                   bank_transactions%ROWTYPE;
  v_bt_oc_id    uuid;
  v_bt_bank_fund_type    fund_type;
  v_before               jsonb;
  v_after                jsonb;
  v_alloc                jsonb;
  v_alloc_sum            decimal(12,2) := 0;
  v_lot_id               uuid;
  v_fund_type            fund_type;
  v_amount               decimal(12,2);
  v_levy_notice_id       uuid;
  v_reference            text;
  v_lot_oc_id   uuid;
  v_ln_lot_id            uuid;
  v_ln_fund_type         fund_type;
  v_ln_reference         text;
  v_credit_id            uuid;
  v_match_id             uuid;
  v_description          text;
  v_created_credit_ids   uuid[] := ARRAY[]::uuid[];
  v_match_ids            uuid[] := ARRAY[]::uuid[];
  v_lot_ids              uuid[] := ARRAY[]::uuid[];
  v_new_matched_total    decimal(12,2);
  v_fund_types_used      fund_type[] := ARRAY[]::fund_type[];
  v_flags                text[] := ARRAY[]::text[];
  v_new_status           text;
BEGIN
  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'rpc_reconcile_bank_transaction: p_allocations must be a non-empty array';
  END IF;

  -- Lock the bank transaction and pull bank_account context.
  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_reconcile_bank_transaction: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.is_voided THEN
    RAISE EXCEPTION 'rpc_reconcile_bank_transaction: bank_transaction % is voided', p_bank_transaction_id;
  END IF;
  IF v_bt.match_status = 'excluded' THEN
    RAISE EXCEPTION 'rpc_reconcile_bank_transaction: bank_transaction % is excluded', p_bank_transaction_id;
  END IF;
  IF v_bt.amount <= 0 THEN
    RAISE EXCEPTION 'rpc_reconcile_bank_transaction: only credit-direction (amount > 0) transactions can be matched; got %', v_bt.amount;
  END IF;

  SELECT ba.oc_id, ba.fund_type
    INTO v_bt_oc_id, v_bt_bank_fund_type
    FROM bank_accounts ba WHERE ba.id = v_bt.bank_account_id;

  v_before := to_jsonb(v_bt);

  -- Pass 1: per-allocation validation + sum.
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_lot_id          := NULLIF(v_alloc->>'lot_id','')::uuid;
    v_fund_type       := (v_alloc->>'fund_type')::fund_type;
    v_amount          := (v_alloc->>'amount')::decimal(12,2);
    v_levy_notice_id  := NULLIF(v_alloc->>'levy_notice_id','')::uuid;
    v_reference       := NULLIF(v_alloc->>'reference','');

    IF v_lot_id IS NULL THEN
      RAISE EXCEPTION 'rpc_reconcile_bank_transaction: allocation missing lot_id';
    END IF;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'rpc_reconcile_bank_transaction: allocation amount must be positive (got %)', v_amount;
    END IF;

    SELECT l.oc_id INTO v_lot_oc_id FROM lots l WHERE l.id = v_lot_id;
    IF v_lot_oc_id IS NULL THEN
      RAISE EXCEPTION 'rpc_reconcile_bank_transaction: lot % not found', v_lot_id;
    END IF;
    IF v_lot_oc_id <> v_bt_oc_id THEN
      RAISE EXCEPTION 'rpc_reconcile_bank_transaction: lot % does not belong to bank transaction oc %', v_lot_id, v_bt_oc_id;
    END IF;

    IF v_levy_notice_id IS NOT NULL THEN
      SELECT ln.lot_id, ln.fund_type, ln.reference_number
        INTO v_ln_lot_id, v_ln_fund_type, v_ln_reference
        FROM levy_notices ln WHERE ln.id = v_levy_notice_id;
      IF v_ln_lot_id IS NULL THEN
        RAISE EXCEPTION 'rpc_reconcile_bank_transaction: levy_notice % not found', v_levy_notice_id;
      END IF;
      IF v_ln_lot_id <> v_lot_id THEN
        RAISE EXCEPTION 'rpc_reconcile_bank_transaction: levy_notice % does not belong to lot %', v_levy_notice_id, v_lot_id;
      END IF;
      IF v_ln_fund_type <> v_fund_type THEN
        RAISE EXCEPTION 'rpc_reconcile_bank_transaction: levy_notice fund_type % does not match allocation fund_type %', v_ln_fund_type, v_fund_type;
      END IF;
    END IF;

    IF NOT (v_fund_type = ANY (v_fund_types_used)) THEN
      v_fund_types_used := array_append(v_fund_types_used, v_fund_type);
    END IF;

    v_alloc_sum := v_alloc_sum + v_amount;
  END LOOP;

  IF (v_bt.matched_total + v_alloc_sum) > v_bt.amount THEN
    RAISE EXCEPTION 'rpc_reconcile_bank_transaction: over-allocation: matched_total(%) + new(%) > amount(%)',
      v_bt.matched_total, v_alloc_sum, v_bt.amount;
  END IF;

  -- Pragmatic allocation across fund_types is allowed on reconcile (per Prompt 2 open-Q1).
  -- Flag it flat in metadata for grep-ability.
  IF array_length(v_fund_types_used, 1) > 1 THEN
    v_flags := array_append(v_flags, 'cross_fund_allocation');
  END IF;

  -- Pass 2: writes.
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_lot_id          := (v_alloc->>'lot_id')::uuid;
    v_fund_type       := (v_alloc->>'fund_type')::fund_type;
    v_amount          := (v_alloc->>'amount')::decimal(12,2);
    v_levy_notice_id  := NULLIF(v_alloc->>'levy_notice_id','')::uuid;
    v_reference       := NULLIF(v_alloc->>'reference','');

    -- Auto-fill reference from the linked levy_notice if not explicitly provided.
    IF v_levy_notice_id IS NOT NULL AND v_reference IS NULL THEN
      SELECT reference_number INTO v_reference FROM levy_notices WHERE id = v_levy_notice_id;
    END IF;

    v_description := 'Reconciled from bank transaction ' || p_bank_transaction_id::text;

    -- Inline rpc_payment_credit logic (per Prompt 2 spec: don't cross-RPC — one transaction, one audit scope).
    INSERT INTO lot_ledger_entries (
      oc_id, lot_id, fund_type, entry_type, category,
      amount, entry_date, description, reference, levy_notice_id,
      status, created_by
    ) VALUES (
      v_bt_oc_id, v_lot_id, v_fund_type, 'credit', 'payment',
      v_amount, v_bt.transaction_date, v_description, v_reference, v_levy_notice_id,
      'active', p_performed_by
    ) RETURNING id INTO v_credit_id;

    v_created_credit_ids := array_append(v_created_credit_ids, v_credit_id);

    INSERT INTO reconciliation_matches (
      bank_transaction_id, ledger_entry_id, amount_matched,
      match_method, match_confidence, matched_by, notes
    ) VALUES (
      p_bank_transaction_id, v_credit_id, v_amount,
      p_match_method, p_match_confidence, p_performed_by, p_notes
    ) RETURNING id INTO v_match_id;

    v_match_ids := array_append(v_match_ids, v_match_id);

    IF NOT (v_lot_id = ANY (v_lot_ids)) THEN
      v_lot_ids := array_append(v_lot_ids, v_lot_id);
    END IF;
  END LOOP;

  -- Update bank_transaction.
  v_new_matched_total := v_bt.matched_total + v_alloc_sum;

  IF v_new_matched_total >= v_bt.amount THEN
    IF p_match_method = 'manual' THEN
      v_new_status := 'manually_matched';
    ELSE
      v_new_status := 'auto_matched';
    END IF;
  ELSE
    v_new_status := 'unmatched';   -- partial matches stay 'unmatched' per spec
  END IF;

  UPDATE bank_transactions
     SET matched_total = v_new_matched_total,
         match_status  = v_new_status
   WHERE id = p_bank_transaction_id;

  -- Recompute state per distinct lot.
  FOR v_lot_id IN SELECT unnest(v_lot_ids) LOOP
    PERFORM recompute_lot_ledger_state(v_lot_id);
  END LOOP;

  SELECT to_jsonb(bt) INTO v_after FROM bank_transactions bt WHERE bt.id = p_bank_transaction_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (p_performed_by, v_bt_oc_id, 'reconciliation.matched', 'bank_transaction', p_bank_transaction_id,
          v_before, v_after,
          jsonb_build_object(
            'allocations', p_allocations,
            'created_credit_ids', to_jsonb(v_created_credit_ids),
            'match_ids', to_jsonb(v_match_ids),
            'match_method', p_match_method,
            'match_confidence', p_match_confidence,
            'flags', to_jsonb(v_flags)
          ));

  RETURN jsonb_build_object(
    'created_credit_ids', to_jsonb(v_created_credit_ids),
    'match_ids', to_jsonb(v_match_ids),
    'remaining_unmatched', (v_bt.amount - v_new_matched_total),
    'flags', to_jsonb(v_flags)
  );
END;
$$;

-- rpc_unmatch_bank_transaction: removes matches and voids their linked credits.
-- Pass p_match_ids = NULL to unmatch every match on the bank transaction.
--
-- ORDERING NOTE (deliberate): we DELETE the reconciliation_matches row FIRST,
-- then call rpc_ledger_void on the (now-orphaned) credit. Two reasons:
--   1. Invariant: "an active ledger credit linked via reconciliation_matches
--      has not been voided". Deleting the match row first means at no point
--      does the DB hold a match row pointing to a voided credit (which would
--      be a confusing snapshot if a future query landed mid-RPC).
--   2. rpc_ledger_void audits linked_reconciliation_match_ids by querying
--      reconciliation_matches. If we voided first, the audit entry would
--      name a match id that we're about to delete — misleading for a future
--      reader grepping history. By deleting first, rpc_ledger_void's audit
--      correctly records 'no linked matches' for this specific void.
-- The whole RPC is one transaction, so external observers never see the
-- intermediate state either way.
--
-- UNDEPOSITED-RECEIPT BRANCH: if a match's ledger_entry_id is linked from an
-- undeposited_funds_entries row AND that row's deposited_by_bank_transaction_id
-- equals the bank_transaction being unmatched, we DO NOT void the credit —
-- the credit belongs to the original receipt entry, not to this deposit. We
-- only delete the match row and revert the receipt to 'pending_deposit'.
CREATE OR REPLACE FUNCTION rpc_unmatch_bank_transaction(
  p_bank_transaction_id uuid,
  p_match_ids uuid[],
  p_reason text,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_bt                   bank_transactions%ROWTYPE;
  v_bt_oc_id    uuid;
  v_before               jsonb;
  v_after                jsonb;
  v_match                reconciliation_matches%ROWTYPE;
  v_uf                   undeposited_funds_entries%ROWTYPE;
  v_voided_credit_ids    uuid[] := ARRAY[]::uuid[];
  v_deleted_match_ids    uuid[] := ARRAY[]::uuid[];
  v_reopened_receipt_ids uuid[] := ARRAY[]::uuid[];
  v_removed_sum          decimal(12,2) := 0;
  v_new_matched_total    decimal(12,2);
  v_new_status           text;
  v_is_receipt_deposit   boolean;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'rpc_unmatch_bank_transaction: reason is required';
  END IF;

  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_unmatch_bank_transaction: bank_transaction % not found', p_bank_transaction_id;
  END IF;

  SELECT ba.oc_id INTO v_bt_oc_id
    FROM bank_accounts ba WHERE ba.id = v_bt.bank_account_id;

  v_before := to_jsonb(v_bt);

  FOR v_match IN
    SELECT * FROM reconciliation_matches
     WHERE bank_transaction_id = p_bank_transaction_id
       AND (p_match_ids IS NULL OR id = ANY (p_match_ids))
     FOR UPDATE
  LOOP
    -- Is this an undeposited-receipt deposit match? (Stash FOUND before any
    -- other SQL runs — subsequent DML resets the FOUND flag.)
    SELECT * INTO v_uf
      FROM undeposited_funds_entries
     WHERE linked_ledger_credit_id = v_match.ledger_entry_id
       AND status = 'deposited'
       AND deposited_by_bank_transaction_id = p_bank_transaction_id
     FOR UPDATE;
    v_is_receipt_deposit := FOUND;

    DELETE FROM reconciliation_matches WHERE id = v_match.id;
    v_deleted_match_ids := array_append(v_deleted_match_ids, v_match.id);
    v_removed_sum := v_removed_sum + v_match.amount_matched;

    IF v_is_receipt_deposit THEN
      -- Reopen the receipt. Leave the original credit active — it belongs to
      -- the receipt, not to this bank transaction.
      UPDATE undeposited_funds_entries
         SET status = 'pending_deposit',
             deposited_at = NULL,
             deposited_by_bank_transaction_id = NULL
       WHERE id = v_uf.id;
      v_reopened_receipt_ids := array_append(v_reopened_receipt_ids, v_uf.id);
    ELSE
      -- Regular match: void the linked credit.
      PERFORM rpc_ledger_void(v_match.ledger_entry_id,
                              'Unmatch: ' || p_reason,
                              p_performed_by);
      v_voided_credit_ids := array_append(v_voided_credit_ids, v_match.ledger_entry_id);
    END IF;
  END LOOP;

  IF array_length(v_deleted_match_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'rpc_unmatch_bank_transaction: no matches removed (either no matches exist or none of the supplied ids matched)';
  END IF;

  -- Recompute matched_total from what remains.
  SELECT COALESCE(SUM(amount_matched), 0)
    INTO v_new_matched_total
    FROM reconciliation_matches
   WHERE bank_transaction_id = p_bank_transaction_id;

  IF v_new_matched_total = 0 THEN
    v_new_status := 'unmatched';
  ELSIF v_new_matched_total >= v_bt.amount THEN
    -- Should not happen because we only decrement, but keep current status intact if so.
    v_new_status := v_bt.match_status;
  ELSE
    v_new_status := 'unmatched';   -- partial remainder reverts to unmatched per spec
  END IF;

  UPDATE bank_transactions
     SET matched_total = v_new_matched_total,
         match_status  = v_new_status
   WHERE id = p_bank_transaction_id;

  SELECT to_jsonb(bt) INTO v_after FROM bank_transactions bt WHERE bt.id = p_bank_transaction_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (p_performed_by, v_bt_oc_id, 'reconciliation.unmatched', 'bank_transaction', p_bank_transaction_id,
          v_before, v_after,
          jsonb_build_object(
            'reason', p_reason,
            'deleted_match_ids', to_jsonb(v_deleted_match_ids),
            'voided_credit_ids', to_jsonb(v_voided_credit_ids),
            'reopened_receipt_ids', to_jsonb(v_reopened_receipt_ids),
            'removed_amount', v_removed_sum
          ));

  RETURN jsonb_build_object(
    'voided_credit_ids', to_jsonb(v_voided_credit_ids),
    'deleted_match_ids', to_jsonb(v_deleted_match_ids),
    'reopened_receipt_ids', to_jsonb(v_reopened_receipt_ids),
    'new_matched_total', v_new_matched_total
  );
END;
$$;

-- rpc_record_cash_receipt: records a cash/cheque receipt. Creates two rows
-- atomically: a lot_ledger_entries credit AND an undeposited_funds_entries
-- row with status='pending_deposit'. The matching bank-side deposit arrives
-- later and is cleared via rpc_deposit_undeposited_funds.
--
-- Strict fund-type rule: p_fund_type MUST equal bank_account.fund_type. Cash
-- is earmarked to the destination account's fund at receipt time.
CREATE OR REPLACE FUNCTION rpc_record_cash_receipt(
  p_oc_id uuid,
  p_lot_id uuid,
  p_bank_account_id uuid,
  p_fund_type fund_type,
  p_amount decimal,
  p_received_date date,
  p_payment_method text,
  p_cheque_number text,
  p_description text,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_lot_oc_id uuid;
  v_ba_oc_id  uuid;
  v_ba_fund_type       fund_type;
  v_receipt_number     text;
  v_credit_id          uuid;
  v_receipt_id         uuid;
  v_method_enum        payment_method;
  v_description        text;
  v_after              jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: amount must be positive (got %)', p_amount;
  END IF;
  IF p_payment_method NOT IN ('cash','cheque') THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: payment_method must be cash or cheque, got %', p_payment_method;
  END IF;
  IF p_payment_method = 'cheque' AND (p_cheque_number IS NULL OR length(trim(p_cheque_number)) = 0) THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: cheque_number is required when payment_method = cheque';
  END IF;
  IF p_payment_method = 'cash' AND p_cheque_number IS NOT NULL THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: cheque_number must be null when payment_method = cash';
  END IF;

  SELECT oc_id INTO v_lot_oc_id FROM lots WHERE id = p_lot_id;
  IF v_lot_oc_id IS NULL THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: lot % not found', p_lot_id;
  END IF;
  IF v_lot_oc_id <> p_oc_id THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: lot % does not belong to oc %', p_lot_id, p_oc_id;
  END IF;

  SELECT oc_id, fund_type
    INTO v_ba_oc_id, v_ba_fund_type
    FROM bank_accounts WHERE id = p_bank_account_id;
  IF v_ba_oc_id IS NULL THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: bank_account % not found', p_bank_account_id;
  END IF;
  IF v_ba_oc_id <> p_oc_id THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: bank_account % does not belong to oc %', p_bank_account_id, p_oc_id;
  END IF;
  IF v_ba_fund_type <> p_fund_type THEN
    RAISE EXCEPTION 'rpc_record_cash_receipt: fund_type mismatch — receipt %, bank account %', p_fund_type, v_ba_fund_type;
  END IF;

  -- Financial prefix: must pass oc_id. 'RCP' (was 'RCPT' pre-PP4-0).
  v_receipt_number := next_reference_number('RCP', p_oc_id);
  v_method_enum := p_payment_method::payment_method;

  IF p_payment_method = 'cheque' THEN
    v_description := 'Cheque receipt ' || v_receipt_number
      || ' (cheque #' || p_cheque_number || ')'
      || COALESCE(' — ' || p_description, '');
  ELSE
    v_description := 'Cash receipt ' || v_receipt_number
      || COALESCE(' — ' || p_description, '');
  END IF;

  -- Inline payment-credit insert (avoids cross-RPC audit duplication).
  INSERT INTO lot_ledger_entries (
    oc_id, lot_id, fund_type, entry_type, category,
    amount, entry_date, description, reference,
    status, created_by
  ) VALUES (
    p_oc_id, p_lot_id, p_fund_type, 'credit', 'payment',
    p_amount, p_received_date, v_description, v_receipt_number,
    'active', p_performed_by
  ) RETURNING id INTO v_credit_id;

  INSERT INTO undeposited_funds_entries (
    oc_id, lot_id, bank_account_id, fund_type, amount, received_date,
    payment_method, cheque_number, receipt_number, description,
    status, linked_ledger_credit_id, created_by
  ) VALUES (
    p_oc_id, p_lot_id, p_bank_account_id, p_fund_type, p_amount, p_received_date,
    v_method_enum, p_cheque_number, v_receipt_number, p_description,
    'pending_deposit', v_credit_id, p_performed_by
  ) RETURNING id INTO v_receipt_id;

  PERFORM recompute_lot_ledger_state(p_lot_id);

  SELECT to_jsonb(u) INTO v_after FROM undeposited_funds_entries u WHERE u.id = v_receipt_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (p_performed_by, p_oc_id, 'receipt.recorded', 'undeposited_funds_entry', v_receipt_id,
          v_after,
          jsonb_build_object(
            'receipt_number', v_receipt_number,
            'ledger_entry_id', v_credit_id,
            'lot_id', p_lot_id,
            'bank_account_id', p_bank_account_id
          ));

  RETURN jsonb_build_object(
    'receipt_id', v_receipt_id,
    'receipt_number', v_receipt_number,
    'ledger_entry_id', v_credit_id
  );
END;
$$;

-- rpc_deposit_undeposited_funds: clears pending undeposited receipts against
-- a real bank deposit. CRITICAL: does NOT create a ledger credit — the credit
-- already exists from rpc_record_cash_receipt. This RPC only links the
-- existing credit to the bank transaction via reconciliation_matches.
-- Exact-sum enforcement: sum(undeposited.amount) MUST equal bank_transaction.amount.
CREATE OR REPLACE FUNCTION rpc_deposit_undeposited_funds(
  p_bank_transaction_id uuid,
  p_undeposited_entry_ids uuid[],
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_bt                 bank_transactions%ROWTYPE;
  v_bt_oc_id  uuid;
  v_before             jsonb;
  v_after              jsonb;
  v_uf                 undeposited_funds_entries%ROWTYPE;
  v_sum                decimal(12,2) := 0;
  v_count              int := 0;
  v_match_id           uuid;
  v_match_ids          uuid[] := ARRAY[]::uuid[];
  v_cleared_numbers    text[] := ARRAY[]::text[];
  v_lot_ids            uuid[] := ARRAY[]::uuid[];
  v_lot_id             uuid;
BEGIN
  IF p_undeposited_entry_ids IS NULL OR array_length(p_undeposited_entry_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: p_undeposited_entry_ids must be non-empty';
  END IF;

  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.is_voided THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: bank_transaction % is voided', p_bank_transaction_id;
  END IF;
  IF v_bt.match_status <> 'unmatched' OR v_bt.matched_total <> 0 THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: bank_transaction % must be unmatched with matched_total=0', p_bank_transaction_id;
  END IF;
  IF v_bt.amount <= 0 THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: only credit-direction transactions can clear receipts';
  END IF;

  SELECT ba.oc_id INTO v_bt_oc_id
    FROM bank_accounts ba WHERE ba.id = v_bt.bank_account_id;

  v_before := to_jsonb(v_bt);

  -- Validate every undeposited entry up front AND sum.
  FOR v_uf IN
    SELECT * FROM undeposited_funds_entries
     WHERE id = ANY (p_undeposited_entry_ids)
     FOR UPDATE
  LOOP
    v_count := v_count + 1;
    IF v_uf.status <> 'pending_deposit' THEN
      RAISE EXCEPTION 'rpc_deposit_undeposited_funds: undeposited entry % is not pending_deposit (status=%)', v_uf.id, v_uf.status;
    END IF;
    IF v_uf.bank_account_id <> v_bt.bank_account_id THEN
      RAISE EXCEPTION 'rpc_deposit_undeposited_funds: undeposited entry % is for a different bank_account', v_uf.id;
    END IF;
    v_sum := v_sum + v_uf.amount;
  END LOOP;

  IF v_count <> array_length(p_undeposited_entry_ids, 1) THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: one or more undeposited_entry_ids not found (% of % resolved)',
      v_count, array_length(p_undeposited_entry_ids, 1);
  END IF;

  IF v_sum <> v_bt.amount THEN
    RAISE EXCEPTION 'rpc_deposit_undeposited_funds: sum of undeposited entries (%) does not equal bank transaction amount (%). Use regular matching instead.', v_sum, v_bt.amount;
  END IF;

  -- Clear each entry + create the matching row against its existing credit.
  FOR v_uf IN
    SELECT * FROM undeposited_funds_entries
     WHERE id = ANY (p_undeposited_entry_ids)
     FOR UPDATE
  LOOP
    UPDATE undeposited_funds_entries
       SET status = 'deposited',
           deposited_at = NOW(),
           deposited_by_bank_transaction_id = p_bank_transaction_id
     WHERE id = v_uf.id;

    INSERT INTO reconciliation_matches (
      bank_transaction_id, ledger_entry_id, amount_matched,
      match_method, match_confidence, matched_by, notes
    ) VALUES (
      p_bank_transaction_id, v_uf.linked_ledger_credit_id, v_uf.amount,
      'system', 'system_created', p_performed_by,
      'Cleared undeposited receipt ' || v_uf.receipt_number
    ) RETURNING id INTO v_match_id;

    v_match_ids       := array_append(v_match_ids, v_match_id);
    v_cleared_numbers := array_append(v_cleared_numbers, v_uf.receipt_number);

    IF NOT (v_uf.lot_id = ANY (v_lot_ids)) THEN
      v_lot_ids := array_append(v_lot_ids, v_uf.lot_id);
    END IF;
  END LOOP;

  UPDATE bank_transactions
     SET matched_total = v_bt.amount,
         match_status  = 'auto_matched'
   WHERE id = p_bank_transaction_id;

  -- Recompute state per distinct lot (credit amounts did not change, but
  -- oldest-unpaid walker is unaffected — still cheap to keep the invariant).
  FOR v_lot_id IN SELECT unnest(v_lot_ids) LOOP
    PERFORM recompute_lot_ledger_state(v_lot_id);
  END LOOP;

  SELECT to_jsonb(bt) INTO v_after FROM bank_transactions bt WHERE bt.id = p_bank_transaction_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (p_performed_by, v_bt_oc_id, 'reconciliation.deposited_receipts', 'bank_transaction', p_bank_transaction_id,
          v_before, v_after,
          jsonb_build_object(
            'cleared_receipt_numbers', to_jsonb(v_cleared_numbers),
            'match_ids', to_jsonb(v_match_ids),
            'cleared_entry_ids', to_jsonb(p_undeposited_entry_ids)
          ));

  RETURN jsonb_build_object(
    'cleared_receipt_numbers', to_jsonb(v_cleared_numbers),
    'match_ids', to_jsonb(v_match_ids)
  );
END;
$$;

-- rpc_exclude_bank_transaction: marks a transaction as excluded from
-- reconciliation (e.g. bank fee, interest credited by the bank, inter-account
-- transfer). Must be unmatched with matched_total=0 and not voided.
CREATE OR REPLACE FUNCTION rpc_exclude_bank_transaction(
  p_bank_transaction_id uuid,
  p_reason text,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_bt                bank_transactions%ROWTYPE;
  v_bt_oc_id uuid;
  v_before            jsonb;
  v_after             jsonb;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'rpc_exclude_bank_transaction: reason is required';
  END IF;

  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_exclude_bank_transaction: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.is_voided THEN
    RAISE EXCEPTION 'rpc_exclude_bank_transaction: bank_transaction % is voided', p_bank_transaction_id;
  END IF;
  IF v_bt.match_status <> 'unmatched' OR v_bt.matched_total <> 0 THEN
    RAISE EXCEPTION 'rpc_exclude_bank_transaction: can only exclude an unmatched transaction with matched_total=0';
  END IF;

  SELECT ba.oc_id INTO v_bt_oc_id FROM bank_accounts ba WHERE ba.id = v_bt.bank_account_id;
  v_before := to_jsonb(v_bt);

  UPDATE bank_transactions
     SET match_status    = 'excluded',
         excluded_reason = p_reason
   WHERE id = p_bank_transaction_id;

  SELECT to_jsonb(bt) INTO v_after FROM bank_transactions bt WHERE bt.id = p_bank_transaction_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (p_performed_by, v_bt_oc_id, 'reconciliation.excluded', 'bank_transaction', p_bank_transaction_id,
          v_before, v_after,
          jsonb_build_object('reason', p_reason));

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- rpc_unexclude_bank_transaction: reverses exclusion.
CREATE OR REPLACE FUNCTION rpc_unexclude_bank_transaction(
  p_bank_transaction_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_bt                bank_transactions%ROWTYPE;
  v_bt_oc_id uuid;
  v_before            jsonb;
  v_after             jsonb;
BEGIN
  SELECT * INTO v_bt FROM bank_transactions WHERE id = p_bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rpc_unexclude_bank_transaction: bank_transaction % not found', p_bank_transaction_id;
  END IF;
  IF v_bt.match_status <> 'excluded' THEN
    RAISE EXCEPTION 'rpc_unexclude_bank_transaction: transaction is not excluded (status=%)', v_bt.match_status;
  END IF;

  SELECT ba.oc_id INTO v_bt_oc_id FROM bank_accounts ba WHERE ba.id = v_bt.bank_account_id;
  v_before := to_jsonb(v_bt);

  UPDATE bank_transactions
     SET match_status    = 'unmatched',
         excluded_reason = NULL
   WHERE id = p_bank_transaction_id;

  SELECT to_jsonb(bt) INTO v_after FROM bank_transactions bt WHERE bt.id = p_bank_transaction_id;
  INSERT INTO audit_log (profile_id, oc_id, action, entity_type, entity_id, before_state, after_state)
  VALUES (p_performed_by, v_bt_oc_id, 'reconciliation.unexcluded', 'bank_transaction', p_bank_transaction_id,
          v_before, v_after);

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- VIEWS  (Prompt 1)
-- ----------------------------------------------------------------------------
-- v_levy_notice_status: derived effective status of a levy notice from the
-- ledger. Match-by-reference is an EXACT string match on
-- levy_notices.reference_number = lot_ledger_entries.reference. No fuzzy.
-- Precedence: written_off > paid > partially_paid > overdue > stored status.
-- ============================================================================
CREATE OR REPLACE VIEW v_levy_notice_status AS
WITH credits AS (
  SELECT
    n.id AS notice_id,
    COALESCE(SUM(e.amount), 0)::decimal(12,2) AS total_credit
  FROM levy_notices n
  LEFT JOIN lot_ledger_entries e
    ON e.status = 'active'
   AND e.entry_type = 'credit'
   AND (
         e.levy_notice_id = n.id
      OR (e.reference IS NOT NULL AND e.reference = n.reference_number)
       )
  GROUP BY n.id
),
voided_debits AS (
  SELECT DISTINCT levy_notice_id AS notice_id
  FROM lot_ledger_entries
  WHERE status = 'voided'
    AND entry_type = 'debit'
    AND category IN ('levy', 'special_levy')
    AND levy_notice_id IS NOT NULL
)
SELECT
  n.id,
  n.oc_id,
  n.lot_id,
  n.reference_number,
  n.amount,
  n.due_date,
  n.status AS stored_status,
  c.total_credit,
  CASE
    WHEN v.notice_id IS NOT NULL OR n.status = 'written_off' THEN 'written_off'::levy_status
    WHEN c.total_credit >= n.amount THEN 'paid'::levy_status
    WHEN c.total_credit > 0 THEN 'partially_paid'::levy_status
    WHEN n.due_date < CURRENT_DATE AND n.status NOT IN ('draft', 'written_off') THEN 'overdue'::levy_status
    ELSE n.status
  END AS effective_status
FROM levy_notices n
LEFT JOIN credits c       ON c.notice_id = n.id
LEFT JOIN voided_debits v ON v.notice_id = n.id;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- RLS is enabled on every table. Server actions use the Supabase service-role
-- client, which bypasses RLS. Per-user policies are intended for when we add
-- direct client-side queries and rely on helper functions (get_current_*)
-- which are created in the application layer.
-- ============================================================================
ALTER TABLE management_companies         ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_consents                ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences     ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners_corporations                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE oc_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_items                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE levy_batches                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE levy_notices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE levy_notice_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_items                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_minutes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE proxies                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_policies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_claims             ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements                ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications                ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_workflows         ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_workflow_steps    ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_instances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_groups                ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_group_lots            ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractors                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_plans                ENABLE ROW LEVEL SECURITY;
ALTER TABLE reserve_fund_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_read_status             ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_ledger_entries           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_ledger_state             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_matches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE undeposited_funds_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE basiq_connections                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE basiq_reauth_notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE basiq_gap_reports                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE oc_notification_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_payer_mappings                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_signups                      ENABLE ROW LEVEL SECURITY;

-- Audit log is immutable — INSERT only.
CREATE POLICY "audit_log_insert_only" ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY "audit_log_no_update"  ON audit_log FOR UPDATE USING (false);
CREATE POLICY "audit_log_no_delete"  ON audit_log FOR DELETE USING (false);

-- ============================================================================
-- SEED DATA — Victorian Compliance Rules
-- ============================================================================
INSERT INTO state_compliance_rules (state, rule_key, rule_value, description) VALUES
  ('VIC', 'agm_notice_days', '14', 'Minimum days notice before AGM'),
  ('VIC', 'agm_max_interval_months', '15', 'Maximum months between AGMs'),
  ('VIC', 'levy_notice_min_days', '28', 'Minimum days notice before levy due date'),
  ('VIC', 'levy_interest_cap_monthly', '2.5', 'Maximum simple interest rate per month on overdue levies'),
  ('VIC', 'proxy_limit_small_scheme', '1', 'Max proxies per holder for schemes with 20 or fewer lots'),
  ('VIC', 'proxy_limit_large_scheme_pct', '5', 'Max proxies as percentage for schemes with more than 20 lots'),
  ('VIC', 'committee_min', '3', 'Minimum committee members'),
  ('VIC', 'committee_max', '7', 'Maximum committee members'),
  ('VIC', 'committee_max_extended', '12', 'Maximum committee members by special resolution'),
  ('VIC', 'special_resolution_threshold', '75', 'Percentage required for special resolution'),
  ('VIC', 'ordinary_resolution_threshold', '50', 'Percentage required for ordinary resolution'),
  ('VIC', 'meeting_quorum_pct', '50', 'Quorum percentage of lot entitlements'),
  ('VIC', 'insurance_public_liability_min', '20000000', 'Minimum public liability insurance in dollars'),
  ('VIC', 'building_valuation_cycle_years', '5', 'Years between building valuations');

-- ============================================================================
-- SEED DATA — Budget Categories (COA codes)
-- ============================================================================
INSERT INTO budget_categories (code, name, fund_type, sort_order) VALUES
  -- Administrative Fund
  ('200100', 'Insurance', 'administrative', 1),
  ('200200', 'Utilities', 'administrative', 2),
  ('200300', 'Cleaning', 'administrative', 3),
  ('200400', 'Gardening', 'administrative', 4),
  ('200500', 'Repairs & Maintenance', 'administrative', 5),
  ('200600', 'Management Fee', 'administrative', 6),
  ('200650', 'Payment Processing Fees', 'administrative', 7),
  ('200700', 'Audit', 'administrative', 8),
  ('200800', 'Legal', 'administrative', 9),
  ('200900', 'Administration', 'administrative', 10),
  ('201000', 'Fire Safety', 'administrative', 11),
  ('201100', 'Pest Control', 'administrative', 12),
  ('201200', 'Lift Maintenance', 'administrative', 13),
  ('209900', 'Other', 'administrative', 99),
  -- Capital Works Fund
  ('300100', 'Building Works', 'capital_works', 1),
  ('300200', 'Painting', 'capital_works', 2),
  ('300300', 'Roofing', 'capital_works', 3),
  ('300400', 'Plumbing', 'capital_works', 4),
  ('300500', 'Electrical', 'capital_works', 5),
  ('300600', 'Fencing & Gates', 'capital_works', 6),
  ('300700', 'Paving & Driveways', 'capital_works', 7),
  ('300800', 'Pool/Gym Equipment', 'capital_works', 8),
  ('309900', 'Other Capital', 'capital_works', 99);

-- ============================================================================
-- SEED DATA , Default Levy Follow-up Workflow (per management company)
-- ----------------------------------------------------------------------------
-- The default workflow is seeded PER management company via the
-- seed_default_followup_workflow(p_company uuid) function (called at company
-- creation + as a backfill). Steps: day 7 friendly reminder, day 14 second
-- reminder, day 28 final notice (email), then a VCAT step at day 56. Bodies are
-- editable per company and overridable per OC. See the function definition in
-- the migration history.
-- ============================================================================

-- ============================================================================
-- PRIVILEGES
-- ----------------------------------------------------------------------------
-- `DROP SCHEMA public CASCADE` wipes the default privileges that Supabase
-- sets up at project creation. Restore them here so every object declared
-- above is accessible to the application roles (`service_role` in
-- particular — server actions use it and it must bypass RLS). These
-- statements are idempotent and also live in REBUILD_INSTRUCTIONS.md §1
-- for a belt-and-braces setup.
-- ============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES  TO anon, authenticated, service_role;
