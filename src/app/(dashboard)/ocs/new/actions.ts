"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requireCompanyRole } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { insertOCWithCode } from "@/lib/oc-code";
import { parsePlanPdf, type ParsedPlan } from "@/lib/parse-plan";
import { parseRulesPdf, type ParsedRulesDocument } from "@/lib/parse-rules";
import { parseInsurancePdf, type ParsedInsurancePolicy } from "@/lib/parse-insurance";
import { parseDrnCsv, matchDrnsToLots, type DrnMatchResult, type LotForMatch, type LotOwnerForMatch } from "@/lib/macquarie/drn-import";
import { uploadObject, fetchObject, deleteObject, publicUrlFor } from "@/lib/storage/r2";

// ─── Types stored on draft_json ─────────────────────────────────
//
// The wizard's editable state. Persisted on every page transition so the user
// can refresh / come back later. Promoted to real rows on completion.

export type DraftInsurancePolicy = {
  provider: string;
  policy_number?: string;
  policy_type: "building" | "public_liability" | "combined" | "fidelity" | "voluntary_workers" | "other";
  sum_insured?: number;
  premium?: number;
  start_date: string;     // ISO yyyy-mm-dd
  end_date: string;
  /** Free-text notes about this policy (broker, exclusions, endorsements,
   *  etc.). Optional; null when nothing extra to record. */
  notes?: string;
  /** R2 key of the CoC PDF this policy was extracted from. Used at
   *  completeWizard time to link the resulting insurance_policies row to its
   *  source document. Empty for hand-entered policies. */
  source_coc_storage_key?: string;
};

export type DraftLot = {
  lot_number: number;
  unit_number?: string;            // e.g. "3B" , apartment / unit label distinct from lot_number
  // Nullable to support the wizard's "empty until Continue" UX , both
  // fields can be undefined while the manager is typing, and validation
  // only fires on submit. Liability is allowed to be 0 (services lots);
  // entitlement must be > 0 under VIC OC Act.
  unit_entitlement?: number;
  lot_liability?: number;
  owner_name?: string;
  owner_email?: string;
  owner_phone?: string;
  owner_postal_address?: string;
  is_occupied_by_owner?: boolean;
  /** Item 18 - explicit 3-state occupancy. When set, supersedes the boolean.
   *  - owner_occupied: lives in the lot themselves (no tenant block)
   *  - tenanted: rented out (tenant fields required)
   *  - vacant: no current occupant (tenant fields skipped) */
  occupancy_status?: "owner_occupied" | "tenanted" | "vacant";
  tenant_name?: string;
  tenant_email?: string;
  tenant_phone?: string;
  /** Opening arrears as at setup date. Positive = arrears, negative = credit.
   *  Captured per-lot directly on page 4 (Lots) rather than on a separate
   *  final step , same lots, same owners, no need for the manager to scroll
   *  back and forth between two tables. */
  opening_balance?: number;
  /** Communications-consent state recorded by the manager during the OC
   *  setup wizard. The manager attests on the owner's behalf , VCAT cares
   *  more about the eventual signup-flow consent (which writes IP + UA), but
   *  this gives a starting position so day-one digital notices aren't
   *  blocked. Empty array = no consent yet, owner gets paper. */
  digital_consent_categories?: string[];
  /** Categories the manager wants the owner asked to consent to at portal
   *  signup. Per-lot (replaces the OC-wide consent_categories_offered). Empty
   *  array = no signup ask (manager already captured everything via
   *  digital_consent_categories above). */
  at_portal_signup_categories?: string[];
  /** Individual or Company , wizard Step 3 captures this in the lot schedule
   *  alongside the owner's name. Defaults to 'individual'. */
  owner_type?: "individual" | "company";
};

/** Per-role committee snapshot captured during the wizard. The wizard
 *  always asks for chairperson / secretary / treasurer; the OC settings
 *  page lets managers add other roles or record handovers later. */
export type DraftCommitteeMember = {
  role: "chairperson" | "secretary" | "treasurer";
  name: string;
  email?: string;
  phone?: string;
  /** Optional lot_number , when set, completeWizard joins to the
   *  inserted lot_owners row by lot_number → owner. */
  lot_number?: number;
};

export type DraftJson = {
  // Page 2 (review)
  plan_number?: string;
  oc_number?: number;
  oc_name?: string;
  address?: string;
  street_number?: string;
  street_name?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  total_lots?: number;
  lots?: DraftLot[];
  // Page 2 (review) , captured here because ABN + GST tend to be on
  // the same plan/registration documents the manager has open.
  abn?: string;
  gst_registered?: boolean;

  // Page 3 (basics)
  trading_name?: string;
  services_only?: boolean;
  financial_year_start_month?: number;       // 1–12
  financial_year_start_day?: number;         // 1–31
  /** monthly | quarterly | half_yearly | annually , drives the levy cron. */
  billing_cycle?: "monthly" | "quarterly" | "half_yearly" | "annually";
  /** Date the current management contract started. Different from
   *  opening_balance_date (financial anchor) , this drives contract
   *  anniversary + renewal reminders + fee billing. */
  manager_appointment_date?: string; // ISO yyyy-mm-dd
  /** 1–5 VIC OC compliance tier. Auto-derived from lot count + services-
   *  only flag, but the manager confirms on page 3 (especially the
   *  services-only edge case = Tier 5). */
  tier?: number;

  // New step 6 , Committee snapshot. has_active_committee=false skips
  // the role-assignment UI; small OCs without an elected committee are
  // valid. last_agm_date drives "AGM due within 15 months" reminders.
  has_active_committee?: boolean;
  committee_members?: DraftCommitteeMember[];
  last_agm_date?: string; // ISO yyyy-mm-dd
  // Page 5 (trust accounts) , per-fund bank arrangement.
  bank_provider?: "macquarie_deft" | "other_csv";
  // Macquarie DRN mappings the manager uploaded during the wizard. We stage
  // by lot_number rather than by lot_id because lots don't exist yet (they're
  // inserted by completeWizard). On completion we look up each row's real
  // lot_id and write the lot_drns table.
  lot_drns?: Array<{
    drn: string;
    lot_number: number;
    primary_id: string | null;
    secondary_id: string | null;
  }>;
  // Whether this OC holds a third "maintenance plan" reserve fund. Tier 1/2
  // is mandatory (the UI forces this on); higher tiers can opt in.
  has_maintenance_plan_fund?: boolean;
  // If set, the manager opted out of configuring bank accounts during the
  // wizard. completeWizard will skip the bank_accounts insert and the
  // post-creation Settings → Banking page will prompt to finish setup.
  banking_deferred?: boolean;
  // Operating account , always present. Draft JSON keys keep the legacy
  // `admin_*` prefix so in-flight drafts round-trip; UI labels it
  // "Operating account".
  admin_bank_id?: string;        // e.g. "macquarie"
  admin_account_name?: string;
  admin_bsb?: string;
  admin_account_number?: string;
  // Retained for back-compat with old draft JSON; ignored by the new wizard.
  capital_same_as_admin?: boolean;
  capital_bank_id?: string;
  capital_account_name?: string;
  capital_bsb?: string;
  capital_account_number?: string;
  // Maintenance plan fund , only relevant when has_maintenance_plan_fund.
  maintenance_same_as_admin?: boolean;
  maintenance_bank_id?: string;
  maintenance_account_name?: string;
  maintenance_bsb?: string;
  maintenance_account_number?: string;

  // Notice address , collected on page 4 (lots) since it informs per-lot
  // postal address defaults. Always present; defaults to the OC address
  // (set by the wizard if the user doesn't change it).
  notice_address?: string;

  // Page 5 (communications & consent) , OC-level policy. Per-lot consent
  // lives on each DraftLot. Designed to plumb through to the lot-owner
  // portal's signup flow without further schema work: when the owner ticks
  // the checkbox, we write digital_consent_given_at + ip + user_agent +
  // source='signup_flow' on their lot_owners row using the same
  // digital_consent_categories array.
  default_delivery_method?: "postal" | "email" | "mixed";
  collect_consent_on_signup?: boolean;
  consent_categories_offered?: string[];
  /** Postal transit buffers (days). Only meaningful when at least one
   *  lot owner receives notices of that category by post. Floor 7,
   *  default 14, no upper limit. Adds onto the statutory minimum to
   *  decide send-by date for each notice. */
  meetings_postal_buffer_days?: number;
  levies_postal_buffer_days?: number;
  financial_postal_buffer_days?: number;

  // Page 6 (rules)
  rules_source?: "model" | "custom";
  rules_status?: "none" | "uploaded" | "parsed" | "failed";
  rules_filename?: string;
  rules_rule_count?: number;

  // Page 7 (insurance) , captures one or more policies on cover at setup.
  has_insurance?: boolean;
  insurance_policies?: DraftInsurancePolicy[];
  // Certificates of Currency uploaded by the manager. Each entry archives the
  // file in R2 and (optionally) records what the AI parser pulled out, so the
  // user sees a list of uploaded certs even after navigating away.
  insurance_cocs?: Array<{
    storage_key: string;
    filename: string;
    size_bytes: number;
    plan_number: string | null;
    insured_name: string | null;
    ps_match: boolean;
  }>;
  // The single-policy fields below are legacy , kept so older drafts still
  // round-trip cleanly. New drafts write into insurance_policies[].
  insurance_provider?: string;
  insurance_policy_number?: string;
  insurance_policy_type?: string;
  insurance_sum_insured?: number;
  insurance_premium?: number;
  insurance_start_date?: string;
  insurance_end_date?: string;
  insurance_doc_filename?: string;

  // Page 8 (opening balances)
  opening_balance_date?: string;                 // ISO yyyy-mm-dd
  opening_operating_balance?: number;
  /** Legacy , kept for in-flight drafts; folded into operating at OC creation. */
  opening_capital_works_balance?: number;
  opening_maintenance_plan_balance?: number;     // only when has_maintenance_plan_fund

  // ─── New wizard (May 2026 redesign) ─────────────────────────────
  //
  // Step 1 , General. Several fields here overlap legacy ones above; the
  // new wizard writes ONLY into these new names. completeWizard prefers
  // the new value when both are present.
  /** Friendly building/development name. Replaces trading_name. */
  building_name?: string;
  /** TFN as plaintext on the draft; encrypted via pgcrypto on the OC row at
   *  completeWizard time. Never persisted plaintext beyond the draft JSONB
   *  (which is access-controlled to the management company). */
  tfn?: string;
  /** Manager attested in Step 3 that the auto-computed tier is correct. */
  tier_confirmed?: boolean;

  // Step 1.1 , Management fee captured during the wizard.
  management_fee?: {
    structure: "fixed_monthly" | "per_lot_monthly" | "hybrid" | "quarterly_retainer";
    fixed_amount_cents?: number;
    per_lot_amount_cents?: number;
    gst_applicable: boolean;
    billing_method: "invoice_direct" | "include_in_levies";
    contract_term: "rolling_12" | "term_24" | "custom";
    contract_start_date?: string;
    contract_end_date?: string;
  };

  // Step 2 , Financial settings.
  /** lot_liability (default) | equal_per_lot | custom_apportionment. The
   *  per-lot table editor + per-fund split dialog land in a follow-up PR ,
   *  for now picking Custom just stores the choice. */
  levy_calculation_basis?: "lot_liability" | "equal_per_lot" | "custom_apportionment";
  early_payment_incentive_percent?: number;
  interest_on_overdue_enabled?: boolean;
  annual_interest_rate_percent?: number;
  interest_free_period_days?: number;
  arrears_action_threshold_cents?: number;

  // Step 3 , Management start date (was manager_appointment_date) is captured
  // on Step 1; we just re-use the existing manager_appointment_date field.
};

// ─── Address title-casing ───────────────────────────────────────
//
// Plans of subdivision capitalise every line (street names, suburbs) in
// ALL CAPS or weird mixed-case. We Title-Case them for display in our UI so
// "10 PINCHAM ROAD" becomes "10 Pincham Road" , same string, just readable.
// Postcode is digits-only and street number can include letters (e.g. "10A")
// so those pass through unchanged.

function titleCase(s: string | null | undefined): string | undefined {
  if (!s) return s ?? undefined;
  // Don't transform mostly-mixed-case strings , Gemini sometimes returns
  // correctly cased data on the second try. We only act when 70%+ of the
  // alphabetic characters are upper-case (i.e. it's all-caps junk).
  const alpha = s.replace(/[^A-Za-z]/g, "");
  if (alpha.length === 0) return s;
  const upperCount = alpha.replace(/[^A-Z]/g, "").length;
  const allCaps = upperCount / alpha.length >= 0.7;
  if (!allCaps) return s;
  return s
    .toLowerCase()
    .split(/(\s+|[-/])/)
    .map((tok) => /^[a-z]/.test(tok) ? tok[0].toUpperCase() + tok.slice(1) : tok)
    .join("");
}

function titleCaseAddress<T extends { street_name?: string | null; suburb?: string | null; address?: string | null }>(o: T): T {
  return {
    ...o,
    street_name: titleCase(o.street_name ?? null) ?? null,
    suburb: titleCase(o.suburb ?? null) ?? null,
    address: titleCase(o.address ?? null) ?? null,
  };
}

// ─── Document naming ────────────────────────────────────────────
//
// Documents uploaded via the wizard get a system-generated display name
// (e.g. "Plan of Subdivision , PS812345X.pdf") that's stored on
// `documents.file_name`. The user's original filename is preserved on
// `documents.original_filename` so it's never thrown away , it shows up on
// the document detail view and is used as the suggested download filename
// when the user pulls the file back down.

type DocCategory = "plan_of_subdivision" | "oc_rules" | "insurance_policy";
function friendlyDocName(
  category: DocCategory,
  ctx: { planNumber?: string | null; ocName?: string | null; index?: number },
): string {
  const plan = (ctx.planNumber ?? "").trim().toUpperCase();
  const stamp = new Date().toISOString().slice(0, 10);
  switch (category) {
    case "plan_of_subdivision":
      return plan ? `Plan of Subdivision , ${plan}.pdf` : `Plan of Subdivision , ${stamp}.pdf`;
    case "oc_rules":
      return plan ? `Owners Corporation Rules , ${plan}.pdf` : `Owners Corporation Rules , ${stamp}.pdf`;
    case "insurance_policy": {
      const n = ctx.index != null ? ` ${ctx.index}` : "";
      return plan
        ? `Certificate of Currency${n} , ${plan}.pdf`
        : `Certificate of Currency${n} , ${stamp}.pdf`;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────

async function loadDraft(draftId: string) {
  const profile = await requireCompanyRole();
  if (!profile.management_company_id) throw new Error("No management company assigned");
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("oc_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("management_company_id", profile.management_company_id)
    .single();
  if (error || !data) throw new Error("Draft not found");
  return { draft: data, profile };
}

// ─── createDraft: row + return id ───────────────────────────────

export async function createDraft(): Promise<{ draftId?: string; error?: string }> {
  try {
    const profile = await requireCompanyRole();
    if (!profile.management_company_id) {
      return { error: "No management company assigned" };
    }
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("oc_drafts")
      .insert({
        management_company_id: profile.management_company_id,
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("createDraft error:", error);
      return { error: "Failed to start the wizard" };
    }
    return { draftId: data.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// Single round-trip variant: insert + return the full row so the wizard
// renders immediately without a second auth+select hop on first paint.
export async function createDraftAndLoad(): Promise<{ draft?: unknown; error?: string }> {
  try {
    const profile = await requireCompanyRole();
    if (!profile.management_company_id) {
      return { error: "No management company assigned" };
    }
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("oc_drafts")
      .insert({
        management_company_id: profile.management_company_id,
        created_by: profile.id,
      })
      .select("*")
      .single();
    if (error || !data) {
      console.error("createDraftAndLoad error:", error);
      return { error: "Failed to start the wizard" };
    }
    return { draft: data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── getDraft (for hydrating the wizard) ────────────────────────

export async function getDraft(draftId: string) {
  try {
    const { draft } = await loadDraft(draftId);
    // If this draft has already promoted to an OC, surface the OC's
    // short_code so the wizard page can redirect there instead of
    // re-rendering step 8 and tempting the user into duplicate creation.
    let promoted_short_code: string | null = null;
    if (draft.promoted_oc_id) {
      const supabase = createServerClient();
      const { data: oc } = await supabase
        .from("owners_corporations")
        .select("short_code")
        .eq("id", draft.promoted_oc_id)
        .maybeSingle();
      promoted_short_code = oc?.short_code ?? null;
    }
    return { draft: { ...draft, promoted_short_code } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to load draft" };
  }
}

// ─── savePlanUpload: persist storage key + file meta, mark pending ──

export async function savePlanUpload(
  draftId: string,
  meta: { storage_key: string; filename: string; size_bytes: number },
) {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const { error } = await supabase
      .from("oc_drafts")
      .update({
        plan_storage_key: meta.storage_key,
        plan_filename: meta.filename,
        plan_size_bytes: meta.size_bytes,
        parse_status: "pending",
        parse_started_at: new Date().toISOString(),
        parse_error: null,
      })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── uploadPlan: receive FormData with the PDF, push to R2 ──
//
// Server-action multipart upload. next.config.ts bumps the body-size limit to
// 50MB. Client calls this with FormData containing a single `file` field.
// Object goes to R2 under `plans/{draftId}/original.pdf`.

export async function uploadPlan(draftId: string, formData: FormData) {
  try {
    const { draft } = await loadDraft(draftId);
    const file = formData.get("file");
    if (!(file instanceof File)) return { error: "No file uploaded" };
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return { error: "Only PDF files are accepted" };
    }
    if (file.size > 50 * 1024 * 1024) return { error: "File exceeds 50MB" };

    const key = `plans/${draft.id}/original.pdf`;
    const buf = Buffer.from(await file.arrayBuffer());

    try {
      await uploadObject(key, buf, "application/pdf");
    } catch (err) {
      console.error("uploadPlan: R2 upload failed", err);
      return { error: "Couldn't save your file , please try again." };
    }

    const supabase = createServerClient();
    const { error: dbErr } = await supabase
      .from("oc_drafts")
      .update({
        plan_storage_key: key,
        plan_filename: file.name,
        plan_size_bytes: file.size,
        parse_status: "pending",
        parse_started_at: new Date().toISOString(),
        parse_error: null,
      })
      .eq("id", draft.id);
    if (dbErr) {
      console.error("uploadPlan: DB update failed", dbErr);
      return { error: "Couldn't save your file , please try again." };
    }
    return { success: true };
  } catch (err) {
    console.error("uploadPlan: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

// ─── uploadOcPhoto: photo of the OC's building (page 3) ───────────
//
// Photos are <=10MB JPEG/PNG/WebP. Same R2 layout as logos:
//   logos/{managementCompanyId}/oc-photos/{draftId}-{uuid}.{ext}
// On wizard completion the storage key is copied to
// owners_corporations.photo_storage_key.

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function uploadOcPhoto(draftId: string, formData: FormData) {
  try {
    const { draft, profile } = await loadDraft(draftId);
    const file = formData.get("file");
    const thumb = formData.get("thumb");
    if (!(file instanceof File)) return { error: "No file uploaded" };
    if (!PHOTO_TYPES.has(file.type)) {
      return { error: "Photos must be JPEG, PNG, or WebP" };
    }
    if (file.size > 10 * 1024 * 1024) {
      return { error: "Photo exceeds 10MB" };
    }
    const ext = file.name.toLowerCase().match(/\.(jpe?g|png|webp)$/i)?.[0] ?? ".jpg";
    const baseKey = `logos/${profile.management_company_id}/oc-photos/${draft.id}-${crypto.randomUUID()}`;
    const key = `${baseKey}${ext}`;
    // Thumbnail is always JPEG (compressed from canvas client-side).
    const thumbKey = `${baseKey}-thumb.jpg`;
    const buf = Buffer.from(await file.arrayBuffer());

    try {
      await uploadObject(key, buf, file.type);
    } catch (err) {
      console.error("uploadOcPhoto: R2 upload failed", err);
      return { error: "Couldn't save your photo , please try again." };
    }

    // Best-effort thumbnail upload. If the client didn't generate one (very
    // old browser, canvas failure) we just leave thumbnail_storage_key null
    // and consumers fall back to the full-res image.
    let storedThumbKey: string | null = null;
    if (thumb instanceof File) {
      try {
        const thumbBuf = Buffer.from(await thumb.arrayBuffer());
        await uploadObject(thumbKey, thumbBuf, "image/jpeg");
        storedThumbKey = thumbKey;
      } catch (err) {
        console.error("uploadOcPhoto: thumbnail upload failed (non-fatal)", err);
      }
    }

    const supabase = createServerClient();

    // Best-effort cleanup: drop the previous photo + thumb from R2 if the user
    // is replacing them. Don't block on the result; orphan keys are harmless.
    if (draft.photo_storage_key && draft.photo_storage_key !== key) {
      void deleteObject(draft.photo_storage_key).catch(() => {});
    }
    if (draft.photo_thumbnail_storage_key && draft.photo_thumbnail_storage_key !== storedThumbKey) {
      void deleteObject(draft.photo_thumbnail_storage_key).catch(() => {});
    }

    const { error: dbErr } = await supabase
      .from("oc_drafts")
      .update({ photo_storage_key: key, photo_thumbnail_storage_key: storedThumbKey })
      .eq("id", draft.id);
    if (dbErr) {
      console.error("uploadOcPhoto: DB update failed", dbErr);
      return { error: "Couldn't save your photo , please try again." };
    }
    return {
      success: true,
      storage_key: key,
      thumbnail_storage_key: storedThumbKey,
      public_url: publicUrlFor(key),
    };
  } catch (err) {
    console.error("uploadOcPhoto: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

// Resolves a storage key to its public URL without leaking the bucket origin
// to the bundle. Called once on page 3 mount when the draft already has a
// previously-uploaded photo (resumed wizard).
export async function getPhotoPublicUrl(storageKey: string): Promise<string> {
  return publicUrlFor(storageKey);
}

export async function removeOcPhoto(draftId: string) {
  try {
    const { draft } = await loadDraft(draftId);
    if (draft.photo_storage_key) {
      void deleteObject(draft.photo_storage_key).catch(() => {});
    }
    if (draft.photo_thumbnail_storage_key) {
      void deleteObject(draft.photo_thumbnail_storage_key).catch(() => {});
    }
    const supabase = createServerClient();
    const { error } = await supabase
      .from("oc_drafts")
      .update({ photo_storage_key: null, photo_thumbnail_storage_key: null })
      .eq("id", draft.id);
    if (error) return { error: "Couldn't remove the photo." };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── parseDraftWithGemini: blocking call, ~10-30s ───────────────

export async function parseDraftWithGemini(draftId: string) {
  try {
    const { draft } = await loadDraft(draftId);
    if (!draft.plan_storage_key) return { error: "No plan uploaded" };

    const supabase = createServerClient();

    let buf: Buffer;
    try {
      buf = await fetchObject(draft.plan_storage_key);
    } catch (err) {
      console.error("parseDraftWithGemini: R2 fetch failed", err);
      await supabase.from("oc_drafts").update({
        parse_status: "failed",
        parse_error: "Storage read failed",
      }).eq("id", draft.id);
      return { error: "We couldn't read the uploaded plan." };
    }

    // Only the Gemini read runs here , it's what the manager is waiting on.
    // Full-text OCR happens later on the cron sweep against the documents
    // row completeWizard creates.
    const [parsedResult] = await Promise.allSettled([parsePlanPdf(buf)]);
    if (parsedResult.status === "rejected") {
      console.error("parseDraftWithGemini: parser failed", parsedResult.reason);
      await supabase.from("oc_drafts").update({
        parse_status: "failed",
        parse_completed_at: new Date().toISOString(),
        parse_error: parsedResult.reason instanceof Error ? parsedResult.reason.message : "Parser failed",
      }).eq("id", draft.id);
      return { error: "Couldn't read this PDF automatically." };
    }
    const parsed: ParsedPlan = parsedResult.value;

    // Document-type gate: Gemini saw the PDF and decided it's not a Plan of
    // Subdivision. Surface a clear message and don't pollute draft_json with
    // a hallucinated lot schedule.
    if (!parsed.is_plan_of_subdivision) {
      await supabase.from("oc_drafts").update({
        parse_status: "failed",
        parse_completed_at: new Date().toISOString(),
        parse_error: `Not a Plan of Subdivision (looks like: ${parsed.document_type_guess || "unknown document"})`,
      }).eq("id", draft.id);
      return {
        error: `That didn't look like a Plan of Subdivision (looks like: ${parsed.document_type_guess || "another document type"}). Upload a different PDF, or skip this step and enter details manually.`,
      };
    }

    // Default to the first detected OC and seed draft_json so page 2 has
    // something to render even if the user never edits.
    const first = parsed.detected_ocs[0];
    const cased = titleCaseAddress({
      street_name: first?.street_name ?? null,
      suburb: first?.suburb ?? null,
      address: first?.address ?? null,
    });
    const draftJson: DraftJson = {
      plan_number: parsed.plan_of_subdivision_number ?? undefined,
      oc_number: first?.oc_number ?? 1,
      oc_name: first?.oc_name ?? undefined,
      // Seed both building_name (new) + trading_name (legacy) so either
      // wizard surface picks it up. The plan parser's `building_name` is
      // the building's display name (e.g. "The Grandview Apartments").
      building_name: first?.building_name ?? undefined,
      trading_name: first?.building_name ?? undefined,
      address: cased.address ?? undefined,
      street_number: first?.street_number ?? undefined,
      street_name: cased.street_name ?? undefined,
      suburb: cased.suburb ?? undefined,
      state: first?.state ?? "VIC",
      postcode: first?.postcode ?? undefined,
      total_lots: first?.lot_count ?? first?.lots.length ?? 0,
      lots: (first?.lots ?? []).map((l) => ({
        lot_number: l.lot_number,
        unit_number: l.unit_number ?? undefined,
        unit_entitlement: l.unit_entitlement,
        lot_liability: l.lot_liability,
      })),
    };

    const { error } = await supabase
      .from("oc_drafts")
      .update({
        parsed_json: parsed as unknown as Record<string, unknown>,
        draft_json: draftJson as unknown as Record<string, unknown>,
        parse_status: "complete",
        parse_completed_at: new Date().toISOString(),
        parse_error: null,
      })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return {
      success: true,
      ocCount: parsed.detected_ocs.length,
      lotCount: first?.lots.length ?? 0,
      detectedOcs: parsed.detected_ocs.map((o) => ({
        oc_number: o.oc_number,
        lot_count: o.lot_count,
        oc_name: o.oc_name ?? null,
      })),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── uploadRules / parseDraftRules / skipRules ──────────────────
//
// Wizard page 6 captures custom OC rules. When a manager uploads a PDF we:
//   1. Push it to R2 under rules/{draftId}/source.pdf,
//   2. Run Gemini's rules extractor → cache parsed JSON on the draft,
//   3. On completeWizard, materialise one oc_rules row per parsed rule and
//      register the PDF in `documents`.
//
// "Use Victoria's Model Rules" path is just a flag , no upload, no parse.

export async function uploadRules(draftId: string, formData: FormData) {
  try {
    const { draft } = await loadDraft(draftId);
    const file = formData.get("file");
    if (!(file instanceof File)) return { error: "No file uploaded" };
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return { error: "Only PDF files are accepted" };
    }
    if (file.size > 25 * 1024 * 1024) return { error: "Rules PDF exceeds 25MB" };

    const key = `rules/${draft.id}/source.pdf`;
    const buf = Buffer.from(await file.arrayBuffer());
    try {
      await uploadObject(key, buf, "application/pdf");
    } catch (err) {
      console.error("uploadRules: R2 upload failed", err);
      return { error: "Couldn't save your file , please try again." };
    }

    const supabase = createServerClient();
    const { error: dbErr } = await supabase
      .from("oc_drafts")
      .update({
        rules_storage_key: key,
        rules_filename: file.name,
        rules_size_bytes: file.size,
        rules_parsed_json: null,
      })
      .eq("id", draft.id);
    if (dbErr) {
      console.error("uploadRules: DB update failed", dbErr);
      return { error: "Couldn't save your file , please try again." };
    }
    return { success: true };
  } catch (err) {
    console.error("uploadRules: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

export async function parseDraftRules(draftId: string) {
  try {
    const { draft } = await loadDraft(draftId);
    if (!draft.rules_storage_key) return { error: "No rules PDF uploaded" };

    let buf: Buffer;
    try {
      buf = await fetchObject(draft.rules_storage_key);
    } catch (err) {
      console.error("parseDraftRules: R2 fetch failed", err);
      return { error: "We couldn't read the uploaded rules document." };
    }

    // Gemini only , full-text OCR is the cron sweep's job.
    const [parsedResult] = await Promise.allSettled([parseRulesPdf(buf)]);

    if (parsedResult.status === "rejected") {
      console.error("parseDraftRules: Gemini parse failed", parsedResult.reason);
      return { error: "We couldn't read this rules PDF automatically. Continue and we'll keep the original , searchable but not indexed." };
    }
    const parsed = parsedResult.value;
    if (!parsed.is_oc_rules) {
      return {
        error: `That didn't look like an OC rules document (looks like: ${parsed.document_type_guess || "another document type"}). Upload a different PDF or skip to use Victoria's Model Rules.`,
      };
    }

    const supabase = createServerClient();
    const { error } = await supabase
      .from("oc_drafts")
      .update({
        rules_parsed_json: parsed as unknown as Record<string, unknown>,
      })
      .eq("id", draft.id);
    if (error) return { error: error.message };

    return {
      success: true,
      ruleCount: parsed.rules.length,
      ocScopes: parsed.oc_scopes,
      rules: parsed.rules.map((r) => ({
        oc_scope: r.oc_scope,
        parent_heading: r.parent_heading ?? null,
        chapter_number: r.chapter_number ?? null,
        chapter_heading: r.chapter_heading ?? null,
        section_number: r.section_number ?? null,
        section_heading: r.section_heading ?? null,
        rule_number: r.rule_number,
        heading: r.heading ?? null,
        body: r.body,
      })),
    };
  } catch (err) {
    console.error("parseDraftRules: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

export async function setRulesSource(draftId: string, source: "model" | "custom") {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const merged = { ...(draft.draft_json as DraftJson), rules_source: source };
    const { error } = await supabase
      .from("oc_drafts")
      .update({ draft_json: merged })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── uploadAndParseCoC , upload + Gemini extraction in one round-trip ───
//
// Page 7 uploads a Certificate of Currency. We push it to R2, record the
// metadata on the draft, run the Gemini parser, and return both the storage
// reference and the extracted policies. The client appends the entry to its
// running list of uploaded CoCs.
//
// Caller can pass `expectedPlanNumber` so we can compare against the PS
// number Gemini finds on the cert , the UI then warns the manager if the
// cert is for a different plan.

export async function uploadAndParseCoC(
  draftId: string,
  formData: FormData,
  expectedPlanNumber?: string,
): Promise<{
  success?: true;
  storage_key?: string;
  filename?: string;
  size_bytes?: number;
  plan_number?: string | null;
  insured_name?: string | null;
  ps_match?: boolean;
  policies?: ParsedInsurancePolicy[];
  error?: string;
}> {
  try {
    const { draft } = await loadDraft(draftId);
    const file = formData.get("file");
    if (!(file instanceof File)) return { error: "No file uploaded" };
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return { error: "Only PDF files are accepted" };
    }
    if (file.size > 25 * 1024 * 1024) return { error: "Certificate exceeds 25MB" };

    const key = `insurance/${draft.id}/${crypto.randomUUID()}.pdf`;
    const buf = Buffer.from(await file.arrayBuffer());

    try {
      await uploadObject(key, buf, "application/pdf");
    } catch (err) {
      console.error("uploadAndParseCoC: R2 upload failed", err);
      return { error: "Couldn't save your file , please try again." };
    }

    // Gemini only , full-text OCR is the cron sweep's job.
    const [parsedResult] = await Promise.allSettled([parseInsurancePdf(buf)]);
    if (parsedResult.status === "rejected") {
      console.error("uploadAndParseCoC: parser failed", parsedResult.reason);
      return { error: "We couldn't read this PDF automatically. Enter details manually." };
    }
    const parsed = parsedResult.value;
    if (!parsed.is_insurance_certificate) {
      // Best-effort cleanup: the file isn't a real cert, so don't leave it
      // sitting in R2.
      void deleteObject(key).catch(() => {});
      return {
        error: `That didn't look like a certificate of currency (looks like: ${parsed.document_type_guess || "another document type"}). Upload a different PDF or enter details manually.`,
      };
    }
    // Compare cert PS number to the OC's. Normalise both sides to handle
    // whitespace + casing differences. ps_match is true only when both sides
    // have a value AND they agree.
    const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");
    const expected = norm(expectedPlanNumber);
    const found = norm(parsed.plan_number ?? null);
    const psMatch = !!expected && !!found && expected === found;

    return {
      success: true,
      storage_key: key,
      filename: file.name,
      size_bytes: file.size,
      plan_number: parsed.plan_number,
      insured_name: parsed.insured_name,
      ps_match: psMatch,
      policies: parsed.policies,
    };
  } catch (err) {
    console.error("uploadAndParseCoC: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

// ─── deleteCoC , remove a CoC document from R2 + draft ───
//
// Called when the manager removes a CoC from page 7. Best-effort R2 delete
// so we don't leave orphaned objects when a cert is rejected or replaced.

export async function deleteCoC(draftId: string, storageKey: string): Promise<{ success?: true; error?: string }> {
  try {
    await loadDraft(draftId);
    // R2 delete is best-effort; orphans are harmless.
    void deleteObject(storageKey).catch(() => {});
    return { success: true };
  } catch (err) {
    console.error("deleteCoC: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

// ─── uploadInsuranceDoc , stores the policy schedule PDF on the draft ────

export async function uploadInsuranceDoc(draftId: string, formData: FormData) {
  try {
    const { draft } = await loadDraft(draftId);
    const file = formData.get("file");
    if (!(file instanceof File)) return { error: "No file uploaded" };
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return { error: "Only PDF files are accepted" };
    }
    if (file.size > 25 * 1024 * 1024) return { error: "Insurance document exceeds 25MB" };

    const key = `insurance/${draft.id}/policy.pdf`;
    const buf = Buffer.from(await file.arrayBuffer());
    try {
      await uploadObject(key, buf, "application/pdf");
    } catch (err) {
      console.error("uploadInsuranceDoc: R2 upload failed", err);
      return { error: "Couldn't save your file , please try again." };
    }

    const supabase = createServerClient();
    const { error: dbErr } = await supabase
      .from("oc_drafts")
      .update({
        insurance_doc_storage_key: key,
        insurance_doc_filename: file.name,
        insurance_doc_size_bytes: file.size,
      })
      .eq("id", draft.id);
    if (dbErr) {
      console.error("uploadInsuranceDoc: DB update failed", dbErr);
      return { error: "Couldn't save your file , please try again." };
    }
    return { success: true };
  } catch (err) {
    console.error("uploadInsuranceDoc: unexpected error", err);
    return { error: "Something went wrong , please try again." };
  }
}

// ─── Wizard rules state (manual edits while the wizard is open) ──────
//
// Page 6 lets the manager add / edit / delete rules during the wizard so
// the rule list saved at completeWizard time matches what they actually
// want. We piggy-back on the existing `rules_parsed_json` blob to persist
// these edits , the live page 6 reads from that on hydrate.

export async function saveDraftRules(
  draftId: string,
  rules: Array<{
    oc_scope?: string;
    parent_heading?: string | null;
    chapter_number?: string | null;
    chapter_heading?: string | null;
    section_number?: string | null;
    section_heading?: string | null;
    rule_number: string;
    heading?: string | null;
    body: string;
    page_number?: number | null;
    rule_type?: "registered" | "standing";
  }>,
): Promise<{ success?: true; error?: string }> {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const existing = (draft.rules_parsed_json ?? {}) as Record<string, unknown>;
    // Persist rules + clear oc_scopes since the edited list is already
    // filtered. Keeps completeWizard's existing materialiser happy.
    const next = { ...existing, rules };
    const { error } = await supabase
      .from("oc_drafts")
      .update({ rules_parsed_json: next })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

export async function getDraftRulesSourceUrl(
  draftId: string,
): Promise<{ url: string | null; error?: string }> {
  try {
    const { draft } = await loadDraft(draftId);
    if (!draft.rules_storage_key) return { url: null };
    const { getSignedDownloadUrl } = await import("@/lib/storage/r2");
    const url = await getSignedDownloadUrl(draft.rules_storage_key, 60 * 60);
    return { url };
  } catch (err) {
    console.error("getDraftRulesSourceUrl: failed", err);
    return { url: null, error: "Couldn't open the rules PDF." };
  }
}

// ─── DRN CSV staging during the wizard ──────────────────────────
//
// Macquarie users get a "Upload DRN CSV" panel on Page 5 once they pick
// Macquarie as the admin bank. The CSV is parsed + auto-matched against the
// draft's lot schedule (by lot number / unit number / payer name → owner)
// the same way macquarie-ingest does it for live OCs. The big difference:
// lots don't exist yet, so the preview ships back lot_numbers rather than
// lot_ids, and the staged rows live on draft_json.lot_drns until
// completeWizard resolves them and writes lot_drns.

export type WizardDrnPreviewMatch = {
  rowNumber: number;
  drn: string;
  primaryId: string | null;
  secondaryId: string | null;
  /** Lot number from the draft this row was auto-matched to (null = needs
   *  manual resolution). The UI lets the manager override via a Select that
   *  picks from the same lot_numbers list. */
  lot_number: number | null;
  matchedBy: DrnMatchResult["matchedBy"];
  confidence: DrnMatchResult["confidence"];
  note?: string;
};

export type WizardDrnPreview = {
  matches: WizardDrnPreviewMatch[];
  totals: { total: number; matchedExact: number; matchedFuzzy: number; unmatched: number };
};

export async function previewDraftDrnCsv(
  draftId: string,
  formData: FormData,
): Promise<{ preview?: WizardDrnPreview; error?: string }> {
  try {
    const { draft } = await loadDraft(draftId);
    const file = formData.get("file");
    if (!(file instanceof File)) return { error: "No file uploaded" };
    if (file.size > 5 * 1024 * 1024) return { error: "CSV exceeds 5MB" };

    const text = await file.text();
    const { rows, errors } = parseDrnCsv(text);
    if (errors.length > 0 && rows.length === 0) {
      return { error: errors[0].message };
    }

    // matchDrnsToLots expects {id, lot_number, unit_number}. Wizard lots don't
    // have ids yet, so we use lot_number as a stand-in id and translate back
    // when we ship the response.
    const d = draft.draft_json as DraftJson;
    const draftLots: LotForMatch[] = (d.lots ?? []).map((l) => ({
      id: String(l.lot_number),
      lot_number: l.lot_number,
      unit_number: l.unit_number ?? null,
    }));
    const draftOwners: LotOwnerForMatch[] = (d.lots ?? [])
      .filter((l) => l.owner_name?.trim())
      .map((l) => ({ lot_id: String(l.lot_number), name: (l.owner_name ?? "").trim() }));

    const matchResults = matchDrnsToLots(rows, draftLots, draftOwners);

    let exact = 0, fuzzy = 0, unmatched = 0;
    const matches: WizardDrnPreviewMatch[] = matchResults.map((m) => {
      if (m.confidence === "exact") exact++;
      else if (m.confidence === "fuzzy") fuzzy++;
      else unmatched++;
      return {
        rowNumber: m.drnRow.rowNumber,
        drn: m.drnRow.drn,
        primaryId: m.drnRow.primaryId,
        secondaryId: m.drnRow.secondaryId,
        lot_number: m.lotId ? parseInt(m.lotId, 10) : null,
        matchedBy: m.matchedBy,
        confidence: m.confidence,
        note: m.note,
      };
    });

    return {
      preview: {
        matches,
        totals: { total: matches.length, matchedExact: exact, matchedFuzzy: fuzzy, unmatched },
      },
    };
  } catch (err) {
    console.error("previewDraftDrnCsv: unexpected error", err);
    return { error: "Couldn't read the DRN file , please try again." };
  }
}

export async function saveDraftDrnMappings(
  draftId: string,
  mappings: Array<{ drn: string; lot_number: number; primary_id: string | null; secondary_id: string | null }>,
): Promise<{ success?: true; error?: string }> {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const merged: DraftJson = { ...(draft.draft_json as DraftJson), lot_drns: mappings };
    const { error } = await supabase
      .from("oc_drafts")
      .update({ draft_json: merged })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

export async function clearDraftDrnMappings(draftId: string): Promise<{ success?: true; error?: string }> {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const merged: DraftJson = { ...(draft.draft_json as DraftJson) };
    delete merged.lot_drns;
    const { error } = await supabase
      .from("oc_drafts")
      .update({ draft_json: merged })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── skipParsing: user opted to enter manually ──────────────────

export async function skipParsing(draftId: string) {
  try {
    await loadDraft(draftId);
    const supabase = createServerClient();
    // Land on page 2 (Review) , the manager wants to type the plan number,
    // address, and lot schedule by hand. Page 2 already supports an empty
    // initial state.
    const { error } = await supabase
      .from("oc_drafts")
      .update({ parse_status: "skipped", current_step: 2 })
      .eq("id", draftId);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── saveStep: merge partial draft_json + step number ───────────

export async function saveStep(
  draftId: string,
  patch: Partial<DraftJson>,
  nextStep: number,
  nextSubstep: number = 0,
) {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const merged = { ...(draft.draft_json as DraftJson), ...patch };
    const { error } = await supabase
      .from("oc_drafts")
      .update({ draft_json: merged, current_step: nextStep, current_substep: nextSubstep })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// Save without advancing the wizard pointer (Item 11). Same shape as saveStep
// but skips validation and never moves current_step/current_substep , the
// manager can leave the wizard, come back later, and resume on the exact same
// page with whatever they had typed.
export async function saveDraftPatch(draftId: string, patch: Partial<DraftJson>) {
  try {
    const { draft } = await loadDraft(draftId);
    const supabase = createServerClient();
    const merged = { ...(draft.draft_json as DraftJson), ...patch };
    const { error } = await supabase
      .from("oc_drafts")
      .update({ draft_json: merged })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── completeWizard: promote draft to real OC + lots + lot_owners ─

export async function completeWizard(draftId: string) {
  try {
    const { draft, profile } = await loadDraft(draftId);
    const d = draft.draft_json as DraftJson;
    if (!profile.management_company_id) return { error: "No management company assigned" };

    // Idempotency guard. If this draft already promoted to an OC we MUST NOT
    // create another one , the bug was that the Create button could fire
    // twice (double click, back-button-then-resubmit, stale tab) and each
    // call would mint a fresh OC, leaving the manager staring at a
    // ballooning OC count. Now a re-run on a promoted draft returns the
    // existing OC's short_code so the caller still navigates to /ocs/<code>
    // , same UX as the first successful run, just without the duplicate
    // side effects.
    if (draft.promoted_oc_id) {
      const supabase = createServerClient();
      const { data: existing } = await supabase
        .from("owners_corporations")
        .select("short_code")
        .eq("id", draft.promoted_oc_id)
        .maybeSingle();
      if (existing?.short_code) {
        return {
          success: true,
          ocCode: existing.short_code as string,
          sourceDraftId: draft.id,
          nextOcIndex: null,
          alreadyCreated: true,
        };
      }
      // Draft has promoted_oc_id but the OC row vanished (manual cleanup?).
      // Block rather than silently re-create , managers can start a fresh
      // wizard if they really want to.
      return { error: "This wizard has already finished and the resulting OC was removed. Start a new draft to create another OC." };
    }

    // Minimum viable: plan_number, address, at least 2 lots. owners_corporations.name
    // is derived from building_name (new) → trading_name (legacy) → address.
    if (!d.plan_number) return { error: "Plan number is required (page 2)" };
    if (!d.address) return { error: "Address is required (page 2)" };
    const resolvedBuildingName = (d.building_name?.trim() || d.trading_name?.trim() || "");
    const resolvedName = resolvedBuildingName || d.address.trim() || `Owners Corporation ${d.plan_number}`;
    if (!d.lots || d.lots.length < 2) return { error: "At least 2 lots are required" };

    // Banking can be deferred , see step-4-banking.tsx. When the manager
    // ticked "set up later", skip every bank-account / opening-balance
    // gate and complete the OC without any bank_accounts rows.
    const bankingDeferred = !!d.banking_deferred;

    if (!bankingDeferred) {
      if (!d.admin_bsb || !d.admin_account_number || !d.admin_account_name || !d.admin_bank_id) {
        return { error: "Trust account details are required (page 5)" };
      }
      if (!d.opening_balance_date) return { error: "Opening balance date is required (page 6)" };
    }

    // Maintenance plan fund , optional. Either shares the operating
    // account or has its own bank.
    const hasMaintenance = !bankingDeferred && !!d.has_maintenance_plan_fund;
    const maintenanceShared = d.maintenance_same_as_admin ?? true;
    const maintenance = !hasMaintenance || maintenanceShared
      ? null
      : { bank_id: d.maintenance_bank_id, account_name: d.maintenance_account_name, bsb: d.maintenance_bsb, account_number: d.maintenance_account_number };
    if (maintenance && (!maintenance.bsb || !maintenance.account_number || !maintenance.account_name || !maintenance.bank_id)) {
      return { error: "Maintenance plan trust account details are required" };
    }

    const supabase = createServerClient();

    const insertResult = await insertOCWithCode(supabase, {
      management_company_id: profile.management_company_id,
      plan_number: d.plan_number,
      name: resolvedName,
      // Write to BOTH the new building_name column (canonical going forward)
      // AND the legacy trading_name column so older code paths (global
      // search, sidebar swapper) still find the friendly name. Cleanup PR
      // drops trading_name once those readers are migrated.
      building_name: resolvedBuildingName || null,
      trading_name: d.trading_name || resolvedBuildingName || null,
      oc_number: d.oc_number ?? 1,
      address: d.address,
      street_number: d.street_number || null,
      street_name: d.street_name || null,
      suburb: d.suburb || null,
      state: d.state || "VIC",
      postcode: d.postcode || null,
      total_lots: d.lots.length,
      photo_storage_key: draft.photo_storage_key ?? null,
      photo_thumbnail_storage_key: draft.photo_thumbnail_storage_key ?? null,
      financial_year_start_month: d.financial_year_start_month ?? 7,
      financial_year_start_day: d.financial_year_start_day ?? 1,
      services_only: !!d.services_only,
      billing_cycle: d.billing_cycle ?? "quarterly",
      // Notice address always set , wizard defaults to OC address; user can override.
      notice_address_same_as_oc: !d.notice_address || d.notice_address.trim() === d.address.trim(),
      notice_address: d.notice_address || d.address,
      bank_provider: d.bank_provider ?? "other_csv",
      uses_shared_trust_account: !hasMaintenance || maintenanceShared,
      // Legacy summary fields point at the operating trust account.
      bank_bsb: d.admin_bsb,
      bank_account_number: d.admin_account_number,
      bank_account_name: d.admin_account_name,
      opening_balance_date: d.opening_balance_date,
      // Fold any legacy capital_works opening balance from in-flight drafts
      // into the operating balance so no money is lost during the rename.
      opening_operating_balance:
        (d.opening_operating_balance ?? 0) + (d.opening_capital_works_balance ?? 0),
      opening_maintenance_plan_balance: hasMaintenance ? (d.opening_maintenance_plan_balance ?? 0) : null,
      // Rules + insurance moved out of the wizard in the May refresh.
      // Every new OC starts on Victoria's Model Rules; managers upload
      // custom registered rules later from a post-wizard task card on
      // the OC dashboard. Insurance is captured the same way once the
      // CoC arrives (typically weeks after handover).
      rules_source: "model",
      rules_uploaded_at: null,
      // Communications & consent policy , see migration
      // oc_and_lot_owner_digital_consent. Postal-default + signup-consent-on
      // matches Victorian regulatory practice.
      default_delivery_method: d.default_delivery_method ?? "mixed",
      collect_consent_on_signup: d.collect_consent_on_signup ?? true,
      consent_categories_offered: d.consent_categories_offered ?? ["levies", "agms", "minutes", "breach_notices", "financials"],
      // Buffer config moved to OC settings , save defaults silently
      // here so the wizard doesn't make every manager click through
      // future-proofing.
      meetings_postal_buffer_days: d.meetings_postal_buffer_days ?? 14,
      levies_postal_buffer_days: d.levies_postal_buffer_days ?? 14,
      financial_postal_buffer_days: d.financial_postal_buffer_days ?? 14,
      // ABN + GST + management start + tier + committee , captured during
      // the wizard. `oc_tier` is the live column (`tier` is unused legacy).
      // Committee snapshot is no longer captured by the new wizard , for
      // back-compat with older drafts we still write what was on the JSONB,
      // but new drafts produce undefined here.
      abn: d.abn ?? null,
      gst_registered: d.gst_registered ?? false,
      manager_appointment_date: d.manager_appointment_date ?? null,
      oc_tier: d.tier ?? null,
      tier_confirmed_at: d.tier_confirmed ? new Date().toISOString() : null,
      tier_confirmed_by: d.tier_confirmed ? profile.id : null,
      has_active_committee: d.has_active_committee ?? true,
      last_agm_date: d.last_agm_date ?? null,
      // Financial settings captured on Step 2 of the new wizard. Defaults
      // match the existing column defaults so drafts that predate Step 2
      // still produce a valid OC row.
      annual_interest_rate_percent: d.annual_interest_rate_percent ?? 0,
      interest_free_period_days: d.interest_free_period_days ?? 28,
      early_payment_incentive_percent: d.early_payment_incentive_percent ?? 0,
      arrears_action_threshold_cents: d.arrears_action_threshold_cents ?? 5000,
      levy_calculation_basis: d.levy_calculation_basis ?? "lot_liability",
      // Master toggle on Step 2. When the manager turns interest off entirely
      // we set the boolean and zero the rate; the cron checks the boolean.
      interest_enabled: d.interest_on_overdue_enabled ?? true,
      setup_step: 8,
      status: "active",
      created_by: profile.id,
    });
    if (insertResult.error || !insertResult.success) {
      return { error: insertResult.error ?? "Failed to create OC" };
    }
    const oc = insertResult.success;

    // Add creator as primary OC member.
    await supabase.from("oc_members").insert({
      oc_id: oc.id,
      profile_id: profile.id,
      role: "strata_manager",
      is_primary_contact: true,
    });

    // TFN , encrypt and persist via the pgp_sym_encrypt RPC. Done after the
    // OC row exists (we need oc.id). Non-fatal: if TFN_ENCRYPTION_KEY isn't
    // configured we log + carry on rather than aborting OC creation.
    if (d.tfn && d.tfn.trim()) {
      const { setOcTfn } = await import("@/lib/crypto/tfn");
      const r = await setOcTfn(oc.id, d.tfn.trim());
      if (r.error) {
        console.error("completeWizard: setOcTfn failed (non-fatal)", r.error);
      }
    }

    // Management-fee step removed (item 4): managers bill the OC outside
    // the platform, so we stopped capturing fee + contract term during OC
    // creation. The legacy draft.management_fee field is intentionally
    // ignored here even if an in-progress draft still has it.

    // Insert lots , opening_balance carries per-lot arrears/credit at setup date.
    // Entitlement / liability are coerced to a number here; the submit
    // validator on Page 2 guarantees they're set + entitlement > 0 + liability
    // >= 0 before we reach completeWizard, so falling back to 0 is just a
    // safety net for older drafts that predate the nullable schema.
    const lotsToInsert = d.lots.map((l) => ({
      oc_id: oc.id,
      lot_number: l.lot_number,
      unit_number: l.unit_number || null,
      lot_entitlement: l.unit_entitlement ?? 0,
      lot_liability: l.lot_liability ?? 0,
      opening_balance: l.opening_balance ?? 0,
    }));
    const { data: insertedLots, error: lotsError } = await supabase
      .from("lots")
      .insert(lotsToInsert)
      .select("id, lot_number");
    if (lotsError || !insertedLots) {
      return { error: `Failed to create lots: ${lotsError?.message ?? "unknown"}` };
    }

    // Per-lot creation audit entries , so the lot history tab on each
    // individual lot shows "Lot created" from day one, not just a single
    // OC-level "create" entry. Best-effort: failures are logged but don't
    // roll the OC creation back.
    const draftLots = d.lots ?? [];
    const lotCreatedAuditRows = insertedLots.map((l) => {
      const draftLot = draftLots.find((dl) => dl.lot_number === l.lot_number);
      return {
        profile_id: profile.id,
        oc_id: oc.id,
        action: "create" as const,
        entity_type: "lot" as const,
        entity_id: l.id,
        after_state: draftLot
          ? {
              lot_number: draftLot.lot_number,
              unit_number: draftLot.unit_number ?? null,
              unit_entitlement: draftLot.unit_entitlement ?? null,
              lot_liability: draftLot.lot_liability ?? null,
              opening_balance: draftLot.opening_balance ?? 0,
            }
          : { lot_number: l.lot_number },
        metadata: { source: "oc_wizard_v2", lot_id: l.id },
      };
    });
    // Seed lot_ledger_entries for any lot that arrived with a non-zero
    // opening_balance , otherwise the per-lot ledger tab is empty even
    // though the lot's overall balance reflects the arrears/credit. We
    // put everything under fund_type=operating because the wizard
    // only collects one number per lot; managers can re-fund later via
    // the ledger UI. Skipped when banking was deferred (no opening date
    // means no anchor for an entry_date).
    if (!bankingDeferred && d.opening_balance_date) {
      const ledgerSeedRows: Array<{
        oc_id: string;
        lot_id: string;
        fund_type: "operating";
        entry_type: "debit" | "credit";
        category: "adjustment_debit" | "adjustment_credit";
        amount: number;
        entry_date: string;
        description: string;
        status: "active";
        created_by: string;
      }> = [];
      for (const l of insertedLots) {
        const draftLot = draftLots.find((dl) => dl.lot_number === l.lot_number);
        const ob = draftLot?.opening_balance ?? 0;
        if (!ob) continue;
        const isDebit = ob > 0;
        ledgerSeedRows.push({
          oc_id: oc.id,
          lot_id: l.id,
          fund_type: "operating",
          entry_type: isDebit ? "debit" : "credit",
          category: isDebit ? "adjustment_debit" : "adjustment_credit",
          amount: Math.abs(ob),
          entry_date: d.opening_balance_date,
          description: isDebit
            ? "Opening balance , owed at OC management start"
            : "Opening balance , credit at OC management start",
          status: "active",
          created_by: profile.id,
        });
      }
      if (ledgerSeedRows.length > 0) {
        const { error: seedErr } = await supabase
          .from("lot_ledger_entries")
          .insert(ledgerSeedRows);
        if (seedErr) {
          console.error("completeWizard: opening-balance ledger seed failed (non-fatal)", seedErr);
        }
      }
    }

    if (lotCreatedAuditRows.length > 0) {
      const { error: lotAuditErr } = await supabase
        .from("audit_log")
        .insert(lotCreatedAuditRows);
      if (lotAuditErr) {
        console.error("completeWizard: lot-create audit insert failed (non-fatal)", lotAuditErr);
      }
    }

    // Insert lot_owners for any lot that had at least a name or contact.
    const lotByNumber = new Map<number, string>();
    for (const l of insertedLots) lotByNumber.set(l.lot_number, l.id);

    // Per-lot payment_reference: {first 5 chars of OC short_code}-{lot # padded to 3}.
    // Spec example: short_code='WHDPECRX', lot 1 → 'WHDPE-001'.
    const refPrefix = oc.short_code.slice(0, 5).toUpperCase();
    const paymentRefFor = (lotNumber: number) =>
      `${refPrefix}-${String(lotNumber).padStart(3, "0")}`;

    const ownerRows = d.lots
      .map((l) => {
        const name = (l.owner_name ?? "").trim();
        const email = (l.owner_email ?? "").trim();
        const phone = (l.owner_phone ?? "").trim();
        const postal = (l.owner_postal_address ?? "").trim();
        if (!name && !email && !phone && !postal) return null;
        const lotId = lotByNumber.get(l.lot_number);
        if (!lotId) return null;
        // Initial digital-comms consent recorded by the manager on Step 3.2
        // of the wizard. source='manager_initial' (no IP / user-agent)
        // because the manager is attesting on the owner's behalf , when the
        // owner later signs up via the portal, that flow overwrites these
        // with source='signup_flow' + their real IP + UA.
        const consentCats = l.digital_consent_categories ?? [];
        const hasConsent = consentCats.length > 0;
        const signupCats = l.at_portal_signup_categories ?? [];
        // Resolve occupancy. The explicit enum wins; if the manager skipped
        // tenant info (Item 18) we default to 'vacant'. Otherwise derive from
        // the legacy boolean + tenant presence.
        const occupancyStatus: "owner_occupied" | "tenanted" | "vacant" =
          l.occupancy_status ??
          (l.is_occupied_by_owner === false
            ? l.tenant_name?.trim()
              ? "tenanted"
              : "vacant"
            : "owner_occupied");
        return {
          lot_id: lotId,
          oc_id: oc.id,
          name: name || "Owner",
          owner_type: l.owner_type ?? "individual",
          email: email || null,
          phone: phone || null,
          postal_address: postal || null,
          is_occupied_by_owner: occupancyStatus === "owner_occupied",
          occupancy_status: occupancyStatus,
          tenant_name: occupancyStatus === "tenanted" ? l.tenant_name || null : null,
          tenant_email: occupancyStatus === "tenanted" ? l.tenant_email || null : null,
          tenant_phone: occupancyStatus === "tenanted" ? l.tenant_phone || null : null,
          digital_consent_categories: consentCats,
          digital_consent_given_at: hasConsent ? new Date().toISOString() : null,
          digital_consent_source: hasConsent ? "manager_initial" as const : null,
          at_portal_signup_categories: signupCats,
          payment_reference: paymentRefFor(l.lot_number),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (ownerRows.length > 0) {
      const { data: insertedOwners, error: ownersError } = await supabase
        .from("lot_owners")
        .insert(ownerRows)
        .select("id, lot_id, digital_consent_categories");
      if (ownersError) {
        console.error("lot_owners insert failed (non-fatal):", ownersError);
      }
      // Seed the consent audit log for any owner who arrived with
      // categories ticked by the manager. before_categories is empty
      // (no prior state); after carries the manager-attested set.
      // Source = manager_initial; IP / UA are null because the manager
      // is attesting on the owner's behalf, not the owner themselves.
      if (insertedOwners && insertedOwners.length > 0) {
        const consentLogRows = insertedOwners
          .filter((o) => Array.isArray(o.digital_consent_categories) && o.digital_consent_categories.length > 0)
          .map((o) => ({
            lot_owner_id: o.id,
            oc_id: oc.id,
            before_categories: [],
            after_categories: o.digital_consent_categories,
            source: "manager_initial" as const,
            actor_profile_id: profile.id,
          }));
        if (consentLogRows.length > 0) {
          const { error: consentLogErr } = await supabase.from("lot_owner_consent_log").insert(consentLogRows);
          if (consentLogErr) {
            console.error("lot_owner_consent_log seed failed (non-fatal):", consentLogErr);
          }
        }

        // Per-owner audit entries so the lot history shows "Owner added"
        // for each lot that had an owner attached at OC creation.
        const ownerAuditRows = insertedOwners.map((o) => {
          const draftLot = (d.lots ?? []).find((dl) => lotByNumber.get(dl.lot_number) === o.lot_id);
          return {
            profile_id: profile.id,
            oc_id: oc.id,
            action: "create" as const,
            entity_type: "lot_owner" as const,
            entity_id: o.id,
            after_state: draftLot
              ? {
                  name: draftLot.owner_name ?? null,
                  email: draftLot.owner_email ?? null,
                  occupancy_status: draftLot.occupancy_status ?? null,
                }
              : {},
            metadata: { source: "oc_wizard_v2", lot_id: o.lot_id },
          };
        });
        if (ownerAuditRows.length > 0) {
          const { error: ownerAuditErr } = await supabase
            .from("audit_log")
            .insert(ownerAuditRows);
          if (ownerAuditErr) {
            console.error("completeWizard: owner-create audit insert failed (non-fatal)", ownerAuditErr);
          }
        }
      }
    }

    // Entity-model writes: every captured lot owner also gets an owner
    // row + an active lot_ownership row. profile_id stays NULL until the
    // owner accepts a portal invite , at which point a future migration
    // step (the accept flow) flips profile_id on the owner row. Both
    // writes are non-fatal so a failure here can't break OC creation.
    try {
      const startDate = d.manager_appointment_date
        ?? d.opening_balance_date
        ?? new Date().toISOString().slice(0, 10);
      const ownerEntityRows = d.lots
        .map((l) => {
          const name = (l.owner_name ?? "").trim();
          const email = (l.owner_email ?? "").trim();
          const phone = (l.owner_phone ?? "").trim();
          const postal = (l.owner_postal_address ?? "").trim();
          if (!name && !email && !phone && !postal) return null;
          const lotId = lotByNumber.get(l.lot_number);
          if (!lotId) return null;
          return {
            lot_id: lotId,
            lot_number: l.lot_number,
            owner_payload: {
              management_company_id: profile.management_company_id,
              owner_type: (l.owner_type ?? "individual") as "individual" | "company",
              name: name || "Owner",
              email: email || null,
              phone: phone || null,
              postal_address: postal || null,
            },
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (ownerEntityRows.length > 0) {
        const { data: insertedOwnerEntities, error: ownerInsertErr } = await supabase
          .from("owners")
          .insert(ownerEntityRows.map((r) => r.owner_payload))
          .select("id");
        if (ownerInsertErr) {
          console.error("owners insert failed (non-fatal):", ownerInsertErr);
        } else if (insertedOwnerEntities && insertedOwnerEntities.length === ownerEntityRows.length) {
          const lotOwnershipRows = ownerEntityRows.map((r, i) => ({
            lot_id: r.lot_id,
            owner_id: insertedOwnerEntities[i].id,
            oc_id: oc.id,
            start_date: startDate,
            is_primary_contact: true,
            is_financial: true,
          }));
          const { error: lotOwnershipErr } = await supabase
            .from("lot_ownerships")
            .insert(lotOwnershipRows);
          if (lotOwnershipErr) {
            console.error("lot_ownerships insert failed (non-fatal):", lotOwnershipErr);
          }
        }
      }

      // management_agreements: every newly-created OC gets an active
      // agreement row scoped to the current manager. Mirrors the backfill
      // applied to existing OCs in the entity-model migration.
      const { error: agreementErr } = await supabase
        .from("management_agreements")
        .insert({
          oc_id: oc.id,
          management_company_id: profile.management_company_id,
          start_date: d.manager_appointment_date ?? new Date().toISOString().slice(0, 10),
        });
      if (agreementErr) {
        console.error("management_agreements insert failed (non-fatal):", agreementErr);
      }
    } catch (err) {
      console.error("entity-model writes failed (non-fatal)", err);
    }

    // Committee snapshot. Only insert rows when the manager said the OC
    // has an active committee AND captured at least one name on Step 6.
    // Empty roles are dropped. lot_owner_id is resolved by mapping each
    // committee member's lot_number to the inserted lots and looking up
    // the matching lot_owner from the freshly-inserted lot_owners rows.
    const committeeMembers = d.committee_members ?? [];
    if ((d.has_active_committee ?? true) && committeeMembers.length > 0) {
      // Fetch the inserted lot_owners' ids keyed by lot_id, so we can
      // populate lot_owner_id for each committee row that points at a
      // captured lot owner.
      const { data: ownersForCommittee } = await supabase
        .from("lot_owners")
        .select("id, lot_id")
        .in("lot_id", insertedLots.map((l) => l.id));
      const ownerIdByLotId = new Map<string, string>();
      for (const o of ownersForCommittee ?? []) {
        if (!ownerIdByLotId.has(o.lot_id)) ownerIdByLotId.set(o.lot_id, o.id);
      }
      const committeeRows = committeeMembers
        .filter((m) => (m.name ?? "").trim())
        .map((m) => {
          const lotId = m.lot_number != null ? lotByNumber.get(m.lot_number) : undefined;
          return {
            oc_id: oc.id,
            role: m.role,
            lot_owner_id: lotId ? (ownerIdByLotId.get(lotId) ?? null) : null,
            name: m.name.trim(),
            email: m.email?.trim() || null,
            phone: m.phone?.trim() || null,
            in_from: d.manager_appointment_date ?? null,
          };
        });
      const { error: committeeErr } = await supabase
        .from("oc_committee_members")
        .insert(committeeRows);
      if (committeeErr) {
        console.error("completeWizard: oc_committee_members insert failed (non-fatal)", committeeErr);
      }
    }

    // Trust accounts → bank_accounts rows. One row per PHYSICAL account:
    // always the operating account; plus a separate maintenance row only
    // when the manager opted into a maintenance plan AND ticked "use its
    // own bank account". When maintenance shares the operating account
    // there is NO maintenance bank_accounts row , the operating account
    // holds maintenance fund money too, and the funds table (via
    // funds.bank_account_id) is the source of truth for fund-to-account
    // mapping. Skipped entirely when banking was deferred.
    let operatingBankId: string | null = null;
    if (!bankingDeferred) {
      const { data: operatingBank, error: operatingBankErr } = await supabase
        .from("bank_accounts")
        .insert({
          oc_id: oc.id,
          fund_type: "operating",
          bank_name: d.admin_bank_id ?? null,
          account_name: d.admin_account_name,
          bsb: d.admin_bsb,
          account_number: d.admin_account_number,
          opening_balance: (d.opening_operating_balance ?? 0) + (d.opening_capital_works_balance ?? 0),
          opening_balance_date: d.opening_balance_date,
        })
        .select("id")
        .single();
      if (operatingBankErr || !operatingBank) {
        console.error("completeWizard: operating bank_accounts insert failed", operatingBankErr);
        return { error: "Couldn't save the operating account. Please check the details and try again." };
      }
      operatingBankId = (operatingBank as { id: string }).id;

      if (maintenance) {
        const { error: mBankErr } = await supabase.from("bank_accounts").insert({
          oc_id: oc.id,
          fund_type: "maintenance_plan",
          bank_name: maintenance.bank_id ?? null,
          account_name: maintenance.account_name!,
          bsb: maintenance.bsb!,
          account_number: maintenance.account_number!,
          opening_balance: d.opening_maintenance_plan_balance ?? 0,
          opening_balance_date: d.opening_balance_date,
        });
        if (mBankErr) {
          console.error("completeWizard: maintenance_plan bank_accounts insert failed", mBankErr);
          return { error: "Couldn't save the maintenance plan fund bank account. Please check the details and try again." };
        }
      }
    }

    // Default Admin Fund , every OC needs one. Marked is_system=true so the
    // funds page hides delete + edit controls. Linked to the operating
    // bank account when the manager set one up (otherwise stands alone until
    // banking is configured later from Settings → Banking).
    const { data: adminFund, error: adminFundErr } = await supabase
      .from("funds")
      .insert({
        oc_id: oc.id,
        name: "Admin Fund",
        kind: "admin",
        is_system: true,
      })
      .select("id")
      .single();
    if (adminFundErr || !adminFund) {
      console.error("completeWizard: default admin fund insert failed (non-fatal)", adminFundErr);
    } else if (operatingBankId) {
      // Link the operating bank_accounts row to the admin fund via fund_id.
      // Non-fatal: a failure here just leaves the link blank and the
      // manager can wire it up from /funds.
      const { error: linkErr } = await supabase
        .from("bank_accounts")
        .update({ fund_id: (adminFund as { id: string }).id })
        .eq("id", operatingBankId);
      if (linkErr) {
        console.error("completeWizard: linking operating bank to admin fund failed (non-fatal)", linkErr);
      }
    }

    // DRN mappings (Macquarie only). The wizard staged rows in
    // draft_json.lot_drns keyed by lot_number; now that lots exist we resolve
    // each row to a real lot_id and write the lot_drns table. Rows that
    // didn't resolve to a lot are silently skipped , the manager can fix
    // them from the OC's DRN page later.
    if (d.lot_drns && d.lot_drns.length > 0) {
      const drnRows = d.lot_drns
        .map((m) => {
          const lotId = lotByNumber.get(m.lot_number);
          if (!lotId) return null;
          return {
            lot_id: lotId,
            drn: m.drn,
            primary_id: m.primary_id,
            secondary_id: m.secondary_id,
            source: "macquarie_csv" as const,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      if (drnRows.length > 0) {
        const { error: drnError } = await supabase.from("lot_drns").insert(drnRows);
        if (drnError) {
          console.error("completeWizard: lot_drns insert failed (non-fatal)", drnError);
        }
      }
    }

    // Mark draft promoted. promoted_short_code denormalises the OC's short
    // code so the wizard's idempotency guard (page.tsx) doesn't have to JOIN
    // back to owners_corporations on every load.
    await supabase
      .from("oc_drafts")
      .update({
        promoted_oc_id: oc.id,
        promoted_short_code: oc.short_code,
        promoted_at: new Date().toISOString(),
      })
      .eq("id", draft.id);

    // Item 22: persist the uploaded Plan-of-Subdivision PDF as a document on
    // the new OC. The file is already in R2 at draft.plan_storage_key; we
    // just register a documents row pointing at it so it surfaces in the OC's
    // documents tab and is full-text searchable once OCR completes.
    if (draft.plan_storage_key && draft.plan_filename) {
      await supabase.from("documents").insert({
        oc_id: oc.id,
        lot_id: null,
        category: "plan_of_subdivision",
        file_name: friendlyDocName("plan_of_subdivision", { planNumber: d.plan_number, ocName: d.oc_name }),
        original_filename: draft.plan_filename,
        file_path: draft.plan_storage_key,
        file_size: draft.plan_size_bytes ?? null,
        mime_type: "application/pdf",
        is_confidential: false,
        uploaded_by: profile.id,
        // Full-text OCR runs on the cron sweep, not here.
        ocr_status: "pending",
      });
    }

    // Rules (custom path only): register the source PDF + materialise the
    // parsed rules into oc_rules so they're searchable + linkable.
    let rulesDocumentId: string | null = null;
    if (d.rules_source === "custom" && draft.rules_storage_key && draft.rules_filename) {
      const { data: rulesDoc } = await supabase.from("documents").insert({
        oc_id: oc.id,
        lot_id: null,
        category: "oc_rules",
        file_name: friendlyDocName("oc_rules", { planNumber: d.plan_number, ocName: d.oc_name }),
        original_filename: draft.rules_filename,
        file_path: draft.rules_storage_key,
        file_size: draft.rules_size_bytes ?? null,
        mime_type: "application/pdf",
        is_confidential: false,
        uploaded_by: profile.id,
        ocr_status: "pending",
      }).select("id").single();
      rulesDocumentId = rulesDoc?.id ?? null;

      // Materialise parsed rules. Best-effort: if the parse failed earlier
      // we still keep the PDF , the search index works via OCR text.
      //
      // Multi-OC documents (one PDF that registers rules for two or more OCs)
      // are filtered down to the rules whose `oc_scope` matches THIS OC,
      // matched by plan_number first then by ordinal position in oc_scopes
      // (the OC at index N in the parsed scopes maps to the N-th OC promoted
      // from this plan). This prevents two OCs' rule "1.1.1" from getting
      // merged onto a single OC.
      const parsedRules = draft.rules_parsed_json as {
        oc_scopes?: Array<{ label: string; plan_number: string | null; rule_count: number }>;
        rules?: Array<{
          oc_scope?: string;
          parent_heading?: string | null;
          chapter_number?: string | null;
          chapter_heading?: string | null;
          section_number?: string | null;
          section_heading?: string | null;
          rule_number: string;
          heading?: string | null;
          body: string;
          page_number?: number | null;
        }>;
      } | null;

      const scopes = parsedRules?.oc_scopes ?? [];
      const allRules = parsedRules?.rules ?? [];
      const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase().replace(/\s+/g, "");
      // Resolve which scope to keep:
      //  (a) the scope whose stated plan_number matches the current OC's, or
      //  (b) if there's a multi-OC plan and we're creating the N-th OC, pick
      //      the N-th scope, or
      //  (c) fall back to all rules (single-OC document).
      let scopeLabel: string | null = null;
      if (scopes.length > 0) {
        const byPlan = scopes.find((s) => norm(s.plan_number) === norm(d.plan_number));
        if (byPlan) {
          scopeLabel = byPlan.label;
        } else if (scopes.length > 1) {
          // Use oc_number as a 1-based index hint.
          const idx = Math.min(Math.max((d.oc_number ?? 1) - 1, 0), scopes.length - 1);
          scopeLabel = scopes[idx]?.label ?? null;
        } else {
          scopeLabel = scopes[0].label;
        }
      }
      const ocRules = scopeLabel
        ? allRules.filter((r) => (r.oc_scope ?? scopes[0]?.label ?? "") === scopeLabel)
        : allRules;

      if (ocRules.length > 0) {
        const rows = ocRules.map((r, idx) => ({
          oc_id: oc.id,
          rule_number: r.rule_number,
          heading: r.heading ?? null,
          // Hierarchical columns , let the rules page group + filter
          // without parsing rule_number at read time. Falls back to null
          // when the document didn't have an explicit chapter / section
          // tier above the numbered rule.
          chapter_number: r.chapter_number ?? null,
          chapter_heading: r.chapter_heading ?? null,
          section_number: r.section_number ?? null,
          section_heading: r.section_heading ?? null,
          body: r.body,
          page_number: r.page_number ?? null,
          ordinal: idx + 1,
          source_document_id: rulesDocumentId,
        }));
        const { error: rulesError } = await supabase.from("oc_rules").insert(rows);
        if (rulesError) {
          console.error("completeWizard: oc_rules insert failed (non-fatal)", rulesError);
        }
      }
    }

    // Insurance , support multiple policies. Backward compat: when the older
    // single-policy fields are set but `insurance_policies` is empty, treat
    // the legacy fields as one policy.
    if (d.has_insurance) {
      const policies: DraftInsurancePolicy[] =
        d.insurance_policies && d.insurance_policies.length > 0
          ? d.insurance_policies
          : (d.insurance_provider && d.insurance_start_date && d.insurance_end_date
              ? [{
                  provider: d.insurance_provider,
                  policy_number: d.insurance_policy_number,
                  policy_type: (d.insurance_policy_type as DraftInsurancePolicy["policy_type"]) ?? "combined",
                  sum_insured: d.insurance_sum_insured,
                  premium: d.insurance_premium,
                  start_date: d.insurance_start_date,
                  end_date: d.insurance_end_date,
                }]
              : []);

      // Register every uploaded Certificate of Currency as a separate
      // document so each is archived + OCR-indexed independently. Managers
      // routinely upload multiple certs (e.g. one per insurer when a cover
      // mix changes mid-year). We capture the resulting documents row id
      // keyed by R2 storage_key so policy inserts below can attach
      // source_document_id back to the originating cert.
      const cocs = d.insurance_cocs ?? [];
      const cocDocByKey = new Map<string, string>();
      for (let idx = 0; idx < cocs.length; idx++) {
        const coc = cocs[idx];
        const friendly = friendlyDocName("insurance_policy", {
          planNumber: d.plan_number,
          ocName: d.oc_name,
          index: cocs.length > 1 ? idx + 1 : undefined,
        });
        const { data: docRow } = await supabase
          .from("documents")
          .insert({
            oc_id: oc.id,
            lot_id: null,
            category: "insurance_policy",
            file_name: friendly,
            original_filename: coc.filename,
            file_path: coc.storage_key,
            file_size: coc.size_bytes,
            mime_type: "application/pdf",
            is_confidential: false,
            uploaded_by: profile.id,
            ocr_status: "pending",
          })
          .select("id")
          .single();
        if (docRow?.id) cocDocByKey.set(coc.storage_key, docRow.id);
      }
      // Legacy single-doc path , only register it if no multi-CoC list is
      // present, to avoid duplicating older drafts that wrote the same key
      // through `insurance_doc_storage_key`.
      if (cocs.length === 0 && draft.insurance_doc_storage_key && draft.insurance_doc_filename) {
        await supabase.from("documents").insert({
          oc_id: oc.id,
          lot_id: null,
          category: "insurance_policy",
          file_name: friendlyDocName("insurance_policy", { planNumber: d.plan_number, ocName: d.oc_name }),
          original_filename: draft.insurance_doc_filename,
          file_path: draft.insurance_doc_storage_key,
          file_size: draft.insurance_doc_size_bytes ?? null,
          mime_type: "application/pdf",
          is_confidential: false,
          uploaded_by: profile.id,
          ocr_status: "pending",
        });
      }

      for (const p of policies) {
        const sourceDocId = p.source_coc_storage_key
          ? cocDocByKey.get(p.source_coc_storage_key) ?? null
          : null;
        const { data: insRow, error: insErr } = await supabase
          .from("insurance_policies")
          .insert({
            oc_id: oc.id,
            policy_type: p.policy_type,
            provider: p.provider,
            policy_number: p.policy_number ?? null,
            sum_insured: p.sum_insured ?? null,
            premium: p.premium ?? null,
            start_date: p.start_date,
            end_date: p.end_date,
            notes: p.notes && p.notes.trim().length > 0 ? p.notes.trim() : null,
            status: "active",
            source_document_id: sourceDocId,
          })
          .select("id")
          .single();
        if (insErr) {
          console.error("completeWizard: insurance_policies insert failed (non-fatal)", insErr);
          continue;
        }
        // Standalone insurance create/update goes through
        // lib/actions/insurance.ts which writes its own audit entry. The
        // wizard path used to swallow this silently , add the same audit
        // entry here so the policy shows up in the history feed from day
        // one of the OC.
        await supabase.from("audit_log").insert({
          profile_id: profile.id,
          oc_id: oc.id,
          action: "create",
          entity_type: "insurance_policy",
          entity_id: insRow?.id ?? null,
          after_state: {
            policy_type: p.policy_type,
            provider: p.provider,
            policy_number: p.policy_number,
            sum_insured: p.sum_insured,
            premium: p.premium,
            start_date: p.start_date,
            end_date: p.end_date,
          },
          metadata: { source: "oc_wizard_v2" },
        });
      }
    }

    // Audit.
    await supabase.from("audit_log").insert({
      profile_id: profile.id,
      oc_id: oc.id,
      action: "create",
      entity_type: "oc",
      entity_id: oc.id,
      after_state: { name: resolvedName, plan_number: d.plan_number, lots: d.lots.length },
      metadata: { source: "oc_wizard_v2", draft_id: draft.id },
    });

    // Sidebar OC list uses unstable_cache tagged with the company id , without
    // this updateTag, the sidebar serves the previous (empty) list until the
    // 5-min localStorage TTL expires. revalidatePath isn't enough on its own:
    // the cache key is unrelated to the path.
    updateTag(`sidebar-ocs-${profile.management_company_id}`);
    revalidatePath("/ocs");
    revalidatePath("/dashboard");

    // Multi-OC follow-on: if the parsed plan detected more than one OC, the
    // caller can prompt the manager to create the next one. The next OC's
    // index in detected_ocs[] is just the position after the one we already
    // promoted (i.e. however many OCs share this plan_number, minus the
    // count we've already created from this same draft). We surface that
    // metadata; the client decides what to do.
    const detectedOcs = (draft.parsed_json as { detected_ocs?: Array<unknown> } | null)?.detected_ocs ?? [];
    let nextOcIndex: number | null = null;
    if (detectedOcs.length > 1) {
      // Count OCs we've already created against this plan number from any
      // promoted draft on the same management_company_id.
      const { data: siblings } = await supabase
        .from("owners_corporations")
        .select("id")
        .eq("management_company_id", profile.management_company_id)
        .eq("plan_number", d.plan_number);
      const made = siblings?.length ?? 1;
      if (made < detectedOcs.length) {
        nextOcIndex = made; // 0-based index into detected_ocs[]
      }
    }

    return {
      success: true,
      ocCode: oc.short_code,
      sourceDraftId: draft.id,
      nextOcIndex,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── selectDetectedOc , pick which OC to set up first from a multi-OC plan ──
//
// Called after a plan PDF is parsed and Gemini reports more than one OC on
// the same plan. We rewrite this draft's `draft_json` to reflect the chosen
// OC's lot schedule, address, building name, etc., so page 2 prefill matches
// the OC the manager is setting up. The OTHER detected OCs stay in
// `parsed_json.detected_ocs` and can be promoted later via the multi-OC
// follow-on dialog at wizard completion.

export async function selectDetectedOc(
  draftId: string,
  ocIndex: number,
): Promise<{ success?: true; error?: string }> {
  try {
    const { draft } = await loadDraft(draftId);
    const parsed = draft.parsed_json as ParsedPlan | null;
    const target = parsed?.detected_ocs?.[ocIndex];
    if (!target) return { error: "That OC isn't in this plan." };

    const supabase = createServerClient();
    const current = (draft.draft_json ?? {}) as DraftJson;
    const cased = titleCaseAddress({
      street_name: target.street_name ?? null,
      suburb: target.suburb ?? null,
      address: target.address ?? null,
    });
    const draftJson: DraftJson = {
      ...current,
      plan_number: parsed?.plan_of_subdivision_number ?? current.plan_number,
      oc_number: target.oc_number,
      oc_name: target.oc_name ?? undefined,
      building_name: target.building_name ?? undefined,
      trading_name: target.building_name ?? undefined,
      address: cased.address ?? undefined,
      street_number: target.street_number ?? undefined,
      street_name: cased.street_name ?? undefined,
      suburb: cased.suburb ?? undefined,
      state: target.state ?? "VIC",
      postcode: target.postcode ?? undefined,
      total_lots: target.lot_count ?? target.lots?.length ?? 0,
      lots: (target.lots ?? []).map((l) => ({
        lot_number: l.lot_number,
        unit_number: l.unit_number ?? undefined,
        unit_entitlement: l.unit_entitlement,
        lot_liability: l.lot_liability,
      })),
    };

    const { error } = await supabase
      .from("oc_drafts")
      .update({ draft_json: draftJson as unknown as Record<string, unknown> })
      .eq("id", draft.id);
    if (error) return { error: error.message };
    return { success: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}

// ─── createDraftFromDetectedOc , fork a new draft from a multi-OC plan ──
//
// Used by the "Create the next OC from this plan?" prompt after a wizard
// completes. We copy the plan + parse from the source draft and seed page 2
// with the chosen OC's detected fields.

export async function createDraftFromDetectedOc(sourceDraftId: string, ocIndex: number) {
  try {
    const profile = await requireCompanyRole();
    if (!profile.management_company_id) {
      return { error: "No management company assigned" };
    }
    const supabase = createServerClient();

    const { data: source } = await supabase
      .from("oc_drafts")
      .select("plan_storage_key, plan_filename, plan_size_bytes, parsed_json")
      .eq("id", sourceDraftId)
      .eq("management_company_id", profile.management_company_id)
      .single();
    if (!source) return { error: "Source draft not found" };

    const detectedOcs = (source.parsed_json as { detected_ocs?: Array<{
      oc_number: number;
      oc_name?: string | null;
      address?: string | null;
      street_number?: string | null;
      street_name?: string | null;
      suburb?: string | null;
      state?: string | null;
      postcode?: string | null;
      lot_count?: number;
      building_name?: string | null;
      lots?: Array<{ lot_number: number; unit_number?: string | null; unit_entitlement: number; lot_liability: number }>;
    }> } | null)?.detected_ocs ?? [];
    const target = detectedOcs[ocIndex];
    if (!target) return { error: "That OC index isn't in the source plan." };

    const parsed = source.parsed_json as { plan_of_subdivision_number?: string | null };
    const cased = titleCaseAddress({
      street_name: target.street_name ?? null,
      suburb: target.suburb ?? null,
      address: target.address ?? null,
    });
    const draftJson: DraftJson = {
      plan_number: parsed?.plan_of_subdivision_number ?? undefined,
      oc_number: target.oc_number,
      oc_name: target.oc_name ?? undefined,
      building_name: target.building_name ?? undefined,
      trading_name: target.building_name ?? undefined,
      address: cased.address ?? undefined,
      street_number: target.street_number ?? undefined,
      street_name: cased.street_name ?? undefined,
      suburb: cased.suburb ?? undefined,
      state: target.state ?? "VIC",
      postcode: target.postcode ?? undefined,
      total_lots: target.lot_count ?? target.lots?.length ?? 0,
      lots: (target.lots ?? []).map((l) => ({
        lot_number: l.lot_number,
        unit_number: l.unit_number ?? undefined,
        unit_entitlement: l.unit_entitlement,
        lot_liability: l.lot_liability,
      })),
    };

    const { data: created, error } = await supabase
      .from("oc_drafts")
      .insert({
        management_company_id: profile.management_company_id,
        created_by: profile.id,
        // Keep the same plan PDF + parse cache so the user can re-parse if
        // they want or just review.
        plan_storage_key: source.plan_storage_key,
        plan_filename: source.plan_filename,
        plan_size_bytes: source.plan_size_bytes,
        parse_status: "complete",
        parsed_json: source.parsed_json,
        draft_json: draftJson as unknown as Record<string, unknown>,
        current_step: 2,    // Skip the upload step , the parse is already done.
      })
      .select("id")
      .single();
    if (error || !created) {
      console.error("createDraftFromDetectedOc: insert failed", error);
      return { error: "Couldn't start the next OC , please try again." };
    }
    return { draftId: created.id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unexpected error" };
  }
}
