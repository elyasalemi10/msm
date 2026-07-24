// ============================================================================
// Idempotent levy-notice PDF render + cache helper (PP7-A).
// ----------------------------------------------------------------------------
// Reads/writes the levy_notices.pdf_url + pdf_generated_at sentinels.
// pdf_url stores the full public R2 CDN URL (consistent with the legacy
// generateAndUploadLevyPDF shape and management_companies.logo_url).
//
// Entry points:
//   - renderLevyNoticePdf(levyId, supabase, opts?): always renders fresh,
//     uploads to R2, stamps DB sentinels, returns the buffer.
//   - getLevyNoticePdfBuffer(levyId, supabase): cache-first; fetches from
//     R2 when pdf_url is populated; falls back to renderLevyNoticePdf when
//     pdf_url is null OR the R2 fetch fails (logs a warning).
//
// Escalation senders (overdue / second-reminder / final-notice) use
// getLevyNoticePdfBuffer to attach the PDF. Levy batch issuance at
// src/lib/actions/levy.ts continues to render in-line for now; future
// cleanup can route those call sites through this wrapper.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LevyNoticeProps } from "@/lib/pdf/types";
import { generateAndUploadLevyPDF, generateLevyPDFBuffer } from "@/lib/levy-pdf";
import { fetchObject, keyFromPublicUrl } from "@/lib/storage/r2";

interface RenderOptions {
  force?: boolean; // bypass the pdf_url cache check
}

export async function renderLevyNoticePdf(
  levyId: string,
  supabase: SupabaseClient,
  opts: RenderOptions = {},
): Promise<Buffer> {
  // Read existing pdf_url first (so force=false can short-circuit without
  // re-rendering).
  const { data: levyRow } = await supabase
    .from("levy_notices")
    .select("id, oc_id, reference_number, pdf_url")
    .eq("id", levyId)
    .single();
  const row = levyRow as
    | { pdf_url: string | null; oc_id: string | null; reference_number: string | null }
    | null;
  const existingPdfUrl = row?.pdf_url ?? null;

  if (!opts.force && existingPdfUrl) {
    // Cached path , fetch from R2 to satisfy the buffer contract. Levy PDFs
    // live in the CONFIDENTIAL bucket at a deterministic key, and pdf_url is
    // now the authenticated app route (/api/levies/{id}/pdf), so derive the
    // key from oc_id + reference. Fall back to keyFromPublicUrl for any legacy
    // rows that still store a CDN URL.
    const key = (row?.oc_id && row?.reference_number)
      ? `levies/${row.oc_id}/${row.reference_number}.pdf`
      : keyFromPublicUrl(existingPdfUrl);
    if (key) {
      try {
        return await fetchObject(key);
      } catch (err) {
        console.warn(
          `renderLevyNoticePdf: pdf_url present but R2 fetch failed for levy ${levyId}, regenerating`,
          err instanceof Error ? err.message : err,
        );
        // Fall through to fresh render.
      }
    }
  }

  // Fresh render path: assemble props, upload to R2, stamp DB. The upload
  // returns a public CDN URL, but levy objects live in the confidential
  // bucket with NO public CDN , storing that URL would 404. Persist the
  // authenticated app route instead (matches createLevyBatch).
  const props = await assembleLevyNoticeProps(supabase, levyId);
  await generateAndUploadLevyPDF(props, props._ocId, props.referenceNumber);
  await supabase
    .from("levy_notices")
    .update({
      // ?v cache-buster so a re-render is picked up by browsers that cached
      // the previous /api/levies/{id}/pdf response.
      pdf_url: `/api/levies/${levyId}/pdf?v=${Date.now()}`,
      pdf_generated_at: new Date().toISOString(),
    })
    .eq("id", levyId);

  // Re-render once more to return a buffer , alternative would be to
  // capture the buffer from generateAndUploadLevyPDF (which discards it).
  // Cheaper to render twice here than to rev the lib signature for this
  // single PP7-A consumer; revisit if cron throughput demands.
  return generateLevyPDFBuffer(props);
}

export async function getLevyNoticePdfBuffer(
  levyId: string,
  supabase: SupabaseClient,
): Promise<Buffer | null> {
  try {
    return await renderLevyNoticePdf(levyId, supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `getLevyNoticePdfBuffer: render failed for levy ${levyId}; sender will fall back to body-only email:`,
      msg,
    );
    return null;
  }
}

// ─── Internal: props assembly ──────────────────────────────────────────
// Mirrors the assembly inline in src/lib/actions/levy.ts:1218-1267.
// Extracted here so escalation senders + future call sites share one path.

interface AssembledLevyProps extends LevyNoticeProps {
  _ocId: string; // used only for the R2 key prefix
}

async function assembleLevyNoticeProps(
  supabase: SupabaseClient,
  levyId: string,
): Promise<AssembledLevyProps> {
  const { data: levyData, error: levyErr } = await supabase
    .from("levy_notices")
    .select(
      "id, reference_number, amount, due_date, issue_date, period_start, period_end, lot_id, oc_id, levy_type, batch_id",
    )
    .eq("id", levyId)
    .single();
  if (levyErr || !levyData) {
    throw new Error(
      `assembleLevyNoticeProps: levy_notices ${levyId} not found: ${levyErr?.message}`,
    );
  }
  const levy = levyData as {
    id: string;
    reference_number: string;
    amount: number | string;
    due_date: string;
    issue_date: string | null;
    period_start: string;
    period_end: string;
    lot_id: string;
    oc_id: string;
    levy_type: "regular" | "special" | "penalty_interest";
    batch_id: string | null;
  };

  // Special-levy reason / note. Lives on the batch row, fetched only
  // for `levy_type === 'special'` to skip a pointless query for the
  // common case (regular quarterly levies have no batch-level note).
  let specialReason: string | null = null;
  if (levy.levy_type === "special" && levy.batch_id) {
    const { data: batchRow } = await supabase
      .from("levy_batches")
      .select("special_purpose")
      .eq("id", levy.batch_id)
      .maybeSingle();
    specialReason = (batchRow as { special_purpose: string | null } | null)?.special_purpose ?? null;
  }

  const [
    { data: subRow },
    { data: lotRow },
    { data: itemsRow },
    { data: memberRow },
    { data: drnRow },
    { data: ownerRefRow },
  ] = await Promise.all([
    supabase
      .from("owners_corporations")
      .select(
        "id, name, address, abn, plan_number, management_company_id, bank_bsb, bank_account_number, bank_account_name, include_arrears_on_notice, multilot_note_enabled, multilot_note_text",
      )
      .eq("id", levy.oc_id)
      .single(),
    supabase
      .from("lots")
      .select("lot_number, unit_number")
      .eq("id", levy.lot_id)
      .single(),
    supabase
      .from("levy_notice_items")
      .select("description, amount")
      .eq("levy_notice_id", levy.id)
      .order("sort_order"),
    supabase
      .from("oc_members")
      .select("profile_id, profiles!inner(first_name, last_name)")
      .eq("oc_id", levy.oc_id)
      .eq("lot_id", levy.lot_id)
      .eq("role", "lot_owner")
      .eq("is_primary_contact", true)
      .maybeSingle(),
    // DRN active on the levy's PERIOD_START , Macquarie issues one DRN per
    // lot but they can be reassigned on owner change; using the period_start
    // as the cutoff keeps the historical notice tied to the DRN that was
    // current when the levy was raised. Null when the OC isn't on Macquarie
    // DEFT yet , callers fall back to the LEV-NNNN reference.
    supabase
      .from("lot_drns")
      .select("drn")
      .eq("lot_id", levy.lot_id)
      .lte("active_from", levy.period_start)
      .or(`active_to.is.null,active_to.gte.${levy.period_start}`)
      .order("active_from", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Owner-reference fallback when no DRN is active. payment_reference
    // is generated on OC creation ("WHDPE-001" = first-5-of-short_code
    // + lot-number-padded-3) and is what the lot owner sees as their
    // permanent billing reference.
    supabase
      .from("lot_owners")
      .select("payment_reference")
      .eq("lot_id", levy.lot_id)
      .not("payment_reference", "is", null)
      .limit(1)
      .maybeSingle(),
  ]);
  const activeDrn = (drnRow as { drn: string } | null)?.drn ?? null;
  const ownerPaymentRef = (ownerRefRow as { payment_reference: string | null } | null)?.payment_reference ?? null;

  const sub = subRow as {
    id: string;
    name: string;
    address: string;
    abn: string | null;
    plan_number: string;
    management_company_id: string;
    bank_bsb: string | null;
    bank_account_number: string | null;
    bank_account_name: string | null;
    include_arrears_on_notice: boolean | null;
    multilot_note_enabled: boolean | null;
    multilot_note_text: string | null;
  } | null;
  if (!sub) {
    throw new Error(`assembleLevyNoticeProps: oc missing for levy ${levyId}`);
  }
  const lot = lotRow as { lot_number: number; unit_number: string | null } | null;

  // Reference cascade: DRN > owner payment_reference > "Lot N" label.
  // Internal LEV-NNNN is never surfaced to the owner (it's our DB
  // sequence, not theirs).
  const displayRef = activeDrn ?? ownerPaymentRef ?? `Lot ${lot?.lot_number ?? ""}`.trim();

  // Management company name + logo + brand colours for the header. Reading
  // brand_color here keeps the resend / arrears re-render visually identical
  // to the batch-generated notice; without it this path silently fell back to
  // the template default navy, which read slightly off next to brand-coloured
  // notices from the same OC.
  const { data: mcRow } = await supabase
    .from("management_companies")
    .select("name, logo_url, brand_color, brand_color_secondary")
    .eq("id", sub.management_company_id)
    .single();
  const mc = mcRow as
    | { name: string; logo_url: string | null; brand_color: string | null; brand_color_secondary: string | null }
    | null;
  const managementCompany = mc
    ? { name: mc.name, logo_url: mc.logo_url }
    : { name: "", logo_url: null };
  const isHex = (v: string | null | undefined): v is string => !!v && /^#[0-9a-f]{3,8}$/i.test(v);
  const primaryHex = mc?.brand_color;
  const secondaryHex = mc?.brand_color_secondary;
  const brandColors = {
    primary: isHex(primaryHex) ? primaryHex : "#0E314C",
    secondary: isHex(secondaryHex) ? secondaryHex : "#CFA753",
  };

  // Owner display name.
  let ownerName = "Lot Owner";
  if (memberRow) {
    const rel = (memberRow as {
      profiles: { first_name: string | null; last_name: string | null } | { first_name: string | null; last_name: string | null }[] | null;
    }).profiles;
    const flat = Array.isArray(rel) ? rel[0] : rel;
    if (flat) {
      const f = flat.first_name?.trim() ?? "";
      const l = flat.last_name?.trim() ?? "";
      const full = `${f} ${l}`.trim();
      if (full.length > 0) ownerName = full;
    }
  }

  const lotLabel = lot
    ? `${lot.lot_number ?? ""}${lot.unit_number ? ` Unit ${lot.unit_number}` : ""}`
    : "";

  const hasEft = Boolean(sub.bank_bsb && sub.bank_account_number);
  const items = (itemsRow ?? []) as Array<{ description: string; amount: number | string }>;

  // Arrears summary , only computed when the OC opts in. Sums the
  // outstanding (amount minus amount_paid) for every PRIOR levy notice
  // on this lot whose period started before this one's period_start.
  // "As of" date = most recent bank_transactions.imported_at so the
  // owner knows how fresh the balance is.
  let priorArrears: { amount: number; asOf: string } | null = null;
  if (sub.include_arrears_on_notice) {
    // ALL prior unpaid notices on this lot count as arrears , regular,
    // special AND penalty_interest. Status filter includes 'issued',
    // 'partially_paid', 'overdue', 'draft' (latest soft-cancel work
    // means drafts are real notices, not just placeholders). Drafts
    // count too if the manager has issued them via "Mark as sent"
    // since that's the moment the owner owes the money.
    const { data: priorRows } = await supabase
      .from("levy_notices")
      .select("amount, amount_paid")
      .eq("lot_id", levy.lot_id)
      .lt("period_start", levy.period_start)
      .in("status", ["issued", "partially_paid", "overdue"])
      .neq("id", levy.id);
    const outstanding = (priorRows ?? []).reduce((sum, r) => {
      return sum + Math.max(0, Number(r.amount ?? 0) - Number(r.amount_paid ?? 0));
    }, 0);
    // Show the row even when outstanding rounds to $0.00 , the
    // manager turned the toggle on, they expect to see SOME line
    // confirming the system did the check.
    priorArrears = {
      amount: Math.round(outstanding * 100) / 100,
      asOf: formatDateLong(new Date().toISOString().slice(0, 10)),
    };
  }

  // Multi-lot detection: count distinct lots in this OC owned by the
  // same contact (by email when present, else name). 2+ triggers the
  // configured multi-lot note when the OC has it enabled.
  let multilotNote: string | null = null;
  if (sub.multilot_note_enabled) {
    const ownerContact = await supabase
      .from("lot_owners")
      .select("email, name")
      .eq("lot_id", levy.lot_id)
      .order("ownership_since", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const me = (ownerContact.data as { email: string | null; name: string | null } | null);
    const myKey = (me?.email ?? me?.name ?? "").trim().toLowerCase();
    if (myKey) {
      const { data: peers } = await supabase
        .from("lot_owners")
        .select("lot_id, email, name")
        .eq("oc_id", levy.oc_id);
      const lots = new Set<string>();
      for (const p of peers ?? []) {
        const key = (p.email ?? p.name ?? "").trim().toLowerCase();
        if (key === myKey && p.lot_id) lots.add(p.lot_id);
      }
      if (lots.size >= 2) {
        multilotNote = sub.multilot_note_text ?? null;
      }
    }
  }

  const props: AssembledLevyProps = {
    _ocId: sub.id,
    managementCompany,
    oc: {
      name: sub.name,
      address: sub.address,
      abn: sub.abn,
      plan_number: sub.plan_number,
    },
    // Title varies by levy_type so the document reads correctly out of
    // the box (Special Levy raises differ legally + visually from
    // standard contributions).
    documentTitle: levy.levy_type === "special" ? "Special Levy" : "Levy Notice",
    note: multilotNote ?? undefined,
    // Top-right of the PDF shows the LEV-/SLEV-NNNN sequence , the
    // internal levy number managers cite when chasing this notice. The
    // owner's permanent reference (DRN / payment_reference) goes into
    // the EFT "Reference" field below where they actually need it.
    referenceNumber: levy.reference_number,
    // The issue date the manager picked when the batch was raised. Only
    // falls back to today for legacy notices written before the field
    // existed.
    date: levy.issue_date ? new Date(`${levy.issue_date}T00:00:00`) : new Date(),
    lotOwner: {
      name: ownerName,
      lot_number: lotLabel,
      address: sub.address,
    },
    levyPeriod: {
      start: formatDateLong(levy.period_start),
      end: formatDateLong(levy.period_end),
    },
    lineItems: items.map((i) => ({
      description: i.description,
      amount: Number(i.amount),
    })),
    totalDue: Number(levy.amount),
    dueDate: formatDateLong(levy.due_date),
    paymentInstructions: {
      bpay: null,
      eft: hasEft
        ? {
            bsb: sub.bank_bsb!,
            account_number: sub.bank_account_number!,
            account_name: sub.bank_account_name ?? sub.name,
            // EFT reference must match Macquarie's reconciliation key (the
            // DRN) when one exists, otherwise the LEV-NNNN sequence.
            reference: displayRef,
          }
        : {
            bsb: "",
            account_number: "",
            account_name: "",
            reference: displayRef,
          },
    },
    priorArrears,
    specialReason,
    brandColors,
  };

  return props;
}

function formatDateLong(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00Z" : ""));
  return d.toLocaleDateString("en-AU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}
