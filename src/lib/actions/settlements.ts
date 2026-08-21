"use server";

import { revalidatePath } from "next/cache";
import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import {
  applySettlementSchema,
  type ApplySettlementInput,
  type OwnershipHistoryEntry,
} from "@/lib/validations/settlement";
import { fetchObject } from "@/lib/storage/r2";
import { runDocumentAiOcr } from "@/lib/google/document-ai";
import { parseSettlementPdf, type ParsedSettlement } from "@/lib/parse-settlement";

import { generateInviteCode } from "@/lib/invite-code";

// ─── Settlement PDF parsing ─────────────────────────────────────
//
// First-cut: we run Document AI OCR on every uploaded settlement PDF and
// store the sanitised raw text on `documents.ocr_text` (parallel run
// pattern shared with the wizard's plan-of-subdivision flow , see
// CLAUDE.md "Document OCR" rule). The raw text powers full-text search +
// future Gemini structured extraction.
//
// Structured field extraction via Gemini (Settlement statement → new
// owner name / settlement date / sale price / etc.) is deferred. The
// parseSettlement* paths now return an empty SettlementReview so the
// manager can complete the review form manually; once the Gemini prompt
// + schema are written we drop the parsed nulls in here.

type StubReturn = { data?: SettlementReview; error: string };

// ─── parseSettlementForReview ──────────────────────────────────

export interface SettlementReview {
  parsed: {
    lotNumber: number | null;
    planNumber: string | null;
    transferee: {
      name: string | null;
      email: string | null;
      phone: string | null;
      postalAddress: string | null;
      dateOfBirth: string | null;
    };
    settlementDate: string | null;
    salePriceCents: number | null;
    contractDate: string | null;
    conveyancer: { name: string | null; email: string | null };
    additionalTransferees: Array<{ name: string | null }>;
  };
  matches: {
    lotNumber: boolean | null;
    planNumber: boolean | null;
  };
  expected: {
    lotNumber: number | null;
    planNumber: string | null;
    planNumberNormalized: string | null;
  };
  currentOwner: {
    profileId: string | null;
    name: string | null;
    email: string | null;
    joinedAt: string | null;
  } | null;
  pendingInvitationId: string | null;
  documentName: string;
  matchedLot: {
    id: string;
    lotNumber: number;
    unitNumber: string | null;
  } | null;
}

function emptyReviewParsed(): SettlementReview["parsed"] {
  return {
    lotNumber: null,
    planNumber: null,
    transferee: { name: null, email: null, phone: null, postalAddress: null, dateOfBirth: null },
    settlementDate: null,
    salePriceCents: null,
    contractDate: null,
    conveyancer: { name: null, email: null },
    additionalTransferees: [],
  };
}

function normalizePlanNumber(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim().toUpperCase().replace(/\s+/g, "");
  return trimmed || null;
}

// Map Gemini's snake_case ParsedSettlement onto SettlementReview's
// camelCase parsed shape. Keeps the storage / API layer (Gemini) and the
// UI layer (review form) free to evolve independently , change one
// without touching the other.
function geminiToReviewParsed(p: ParsedSettlement): SettlementReview["parsed"] {
  return {
    lotNumber: p.lot_number,
    planNumber: p.plan_number,
    transferee: {
      name: p.transferee.name,
      email: p.transferee.email,
      phone: p.transferee.phone,
      postalAddress: p.transferee.postal_address,
      dateOfBirth: p.transferee.date_of_birth,
    },
    settlementDate: p.settlement_date,
    salePriceCents: p.sale_price_cents,
    contractDate: p.contract_date,
    conveyancer: { name: p.conveyancer.name, email: p.conveyancer.email },
    additionalTransferees: p.additional_transferees,
  };
}

function computeMatches(
  parsed: SettlementReview["parsed"],
  expected: SettlementReview["expected"],
): SettlementReview["matches"] {
  return {
    lotNumber: parsed.lotNumber == null
      ? null
      : expected.lotNumber == null ? null : parsed.lotNumber === expected.lotNumber,
    planNumber: parsed.planNumber == null
      ? null
      : expected.planNumberNormalized == null
        ? null
        : normalizePlanNumber(parsed.planNumber) === expected.planNumberNormalized,
  };
}

/**
 * Fetch the PDF, then run Gemini structured extraction + Document AI OCR
 * in PARALLEL. Gemini gates the review-form prefill; the OCR raw text
 * gets persisted on the document row regardless (for full-text search).
 *
 * Returns the parsed-settlement fields (Gemini), or null if parsing
 * failed / the model decided this isn't a settlement document. The
 * caller falls back to an empty parsed shape in that case so the
 * manager can complete the review manually.
 */
async function parseAndOcrSettlement(
  documentId: string,
): Promise<ParsedSettlement | null> {
  const supabase = createServerClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, file_path, mime_type, ocr_status")
    .eq("id", documentId)
    .maybeSingle();
  if (error || !doc) {
    console.error("parseAndOcrSettlement: document fetch failed", error);
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = await fetchObject(doc.file_path);
  } catch (err) {
    console.error("parseAndOcrSettlement: R2 fetch failed", err);
    return null;
  }
  const buffer = Buffer.from(bytes);
  const mimeType = doc.mime_type ?? "application/pdf";

  // Skip OCR if already done , keeps the parse path idempotent.
  const shouldOcr = doc.ocr_status !== "complete";

  const [parseResult, ocrResult] = await Promise.allSettled([
    parseSettlementPdf(buffer),
    shouldOcr
      ? runDocumentAiOcr(buffer, mimeType)
      : Promise.resolve(null),
  ]);

  // Persist OCR raw text , fire and forget the update; failures log
  // server-side but don't block the review form.
  if (ocrResult.status === "fulfilled" && ocrResult.value) {
    await supabase
      .from("documents")
      .update({ ocr_text: ocrResult.value.text, ocr_status: "complete" })
      .eq("id", documentId);
  } else if (ocrResult.status === "rejected") {
    console.error("parseAndOcrSettlement: OCR failed", ocrResult.reason);
    await supabase
      .from("documents")
      .update({ ocr_status: "failed" })
      .eq("id", documentId);
  }

  if (parseResult.status === "rejected") {
    console.error("parseAndOcrSettlement: Gemini parse failed", parseResult.reason);
    return null;
  }
  const parsed = parseResult.value;
  // Document-type gate , Gemini decided this isn't a settlement doc.
  if (!parsed.is_settlement_document) {
    console.warn(
      "parseAndOcrSettlement: model rejected document",
      parsed.document_type_guess,
    );
    return null;
  }
  return parsed;
}

export async function parseSettlementForReview(
  documentId: string,
  lotId: string,
): Promise<StubReturn> {
  await requireCompanyRole();
  const supabase = createServerClient();

  const { data: doc } = await supabase
    .from("documents")
    .select("id, file_name, oc_id, lot_id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return { error: "Document not found" };
  if (doc.lot_id !== lotId) return { error: "Document is not attached to this lot" };
  await requireOCAccess(doc.oc_id);

  const { data: lot } = await supabase
    .from("lots")
    .select("id, lot_number, unit_number, oc_id")
    .eq("id", lotId)
    .maybeSingle();
  if (!lot) return { error: "Lot not found" };

  const { data: ocRow } = await supabase
    .from("owners_corporations")
    .select("plan_number")
    .eq("id", lot.oc_id)
    .maybeSingle();

  const expected: SettlementReview["expected"] = {
    lotNumber: lot.lot_number,
    planNumber: ocRow?.plan_number ?? null,
    planNumberNormalized: normalizePlanNumber(ocRow?.plan_number),
  };

  // Gemini parse blocks the response so the review form opens already
  // pre-filled , same UX as the wizard's plan-of-subdivision step. OCR
  // raw-text persistence happens in parallel inside parseAndOcrSettlement.
  const parsed = await parseAndOcrSettlement(documentId);

  const parsedFields = parsed ? geminiToReviewParsed(parsed) : emptyReviewParsed();
  return {
    error: "",
    data: {
      parsed: parsedFields,
      matches: computeMatches(parsedFields, expected),
      expected,
      currentOwner: null,
      pendingInvitationId: null,
      documentName: doc.file_name,
      matchedLot: {
        id: lot.id,
        lotNumber: lot.lot_number,
        unitNumber: lot.unit_number,
      },
    },
  };
}

// ─── parseSettlementAndMatchLot ──────────────────────────────
// Bulk-upload entry point used from the /lots page Tools dropdown. The
// PDF is uploaded against the OC (not yet attached to a specific lot);
// once Gemini extracts the lot + plan number we look up the matching
// lot row in this OC and attach the document to it.

export async function parseSettlementAndMatchLot(
  documentId: string,
  ocId: string,
): Promise<StubReturn> {
  await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: doc } = await supabase
    .from("documents")
    .select("id, file_name, oc_id")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc) return { error: "Document not found" };

  const { data: ocRow } = await supabase
    .from("owners_corporations")
    .select("plan_number")
    .eq("id", ocId)
    .maybeSingle();

  const ocExpected: SettlementReview["expected"] = {
    lotNumber: null,
    planNumber: ocRow?.plan_number ?? null,
    planNumberNormalized: normalizePlanNumber(ocRow?.plan_number),
  };

  const parsed = await parseAndOcrSettlement(documentId);
  const parsedFields = parsed ? geminiToReviewParsed(parsed) : emptyReviewParsed();

  // Try to match the lot by parsed lot_number within the OC. plan_number
  // matching is a secondary check , the OC scope is the primary filter.
  let matchedLot: SettlementReview["matchedLot"] = null;
  if (parsedFields.lotNumber != null) {
    const { data: lotMatch } = await supabase
      .from("lots")
      .select("id, lot_number, unit_number")
      .eq("oc_id", ocId)
      .eq("lot_number", parsedFields.lotNumber)
      .maybeSingle();
    if (lotMatch) {
      matchedLot = {
        id: lotMatch.id,
        lotNumber: lotMatch.lot_number,
        unitNumber: lotMatch.unit_number,
      };
      // Attach the document to the matched lot so applySettlementToLot
      // can find it via doc.lot_id later.
      await supabase
        .from("documents")
        .update({ lot_id: lotMatch.id })
        .eq("id", documentId);
    }
  }

  const expected: SettlementReview["expected"] = {
    lotNumber: matchedLot?.lotNumber ?? null,
    planNumber: ocExpected.planNumber,
    planNumberNormalized: ocExpected.planNumberNormalized,
  };

  return {
    error: "",
    data: {
      parsed: parsedFields,
      matches: computeMatches(parsedFields, expected),
      expected,
      currentOwner: null,
      pendingInvitationId: null,
      documentName: doc.file_name,
      matchedLot,
    },
  };
}

// ─── applySettlementToLot ─────────────────────────────────────

// Server-side lookup used by the "Go to lot X" branch of the
// wrong-lot-number confirmation popup in the settlement drawer. Returns
// the lot's id + short_code so the UI can navigate to
// /ocs/{shortCode}/lots/{id}?settlement=open with the parsed data
// shuttled via sessionStorage.
export async function findLotByNumberInOc(
  ocId: string,
  lotNumber: number,
  // When the manager jumps from a wrong-lot settlement to the correct
  // lot, we re-point the already-uploaded document at the new lot so
  // applySettlementToLot's "document attached to this lot" check passes
  // and the PDF stays linked to the settlement it actually describes.
  documentId?: string | null,
): Promise<{ ok: true; lotId: string; ocShortCode: string } | { ok: false; error: string }> {
  await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();
  const { data: lot } = await supabase
    .from("lots")
    .select("id, oc_id")
    .eq("oc_id", ocId)
    .eq("lot_number", lotNumber)
    .maybeSingle();
  if (!lot) return { ok: false, error: `Lot ${lotNumber} doesn't exist in this OC.` };
  const { data: oc } = await supabase
    .from("owners_corporations")
    .select("short_code")
    .eq("id", ocId)
    .maybeSingle();
  if (!oc?.short_code) return { ok: false, error: "OC missing short code." };

  if (documentId) {
    // Re-attach the document to the target lot (same OC, so access is
    // already verified). The settlement at the new lot then links the
    // PDF that describes it.
    await supabase
      .from("documents")
      .update({ lot_id: lot.id })
      .eq("id", documentId)
      .eq("oc_id", ocId);
  }

  return { ok: true, lotId: lot.id as string, ocShortCode: oc.short_code as string };
}

export async function applySettlementToLot(input: ApplySettlementInput) {
  const profile = await requireCompanyRole();
  const parsed = applySettlementSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { documentId, lotId, newOwner, settlementDate } = parsed.data;

  const supabase = createServerClient();

  // Two paths: (a) a settlement PDF was uploaded → use it as the source of
  // truth for oc/lot lookup; (b) the manager is entering manually → resolve
  // oc via the lot row directly.
  let resolvedOcId: string;
  let docMeta: { id: string; file_name: string } | null = null;
  let docNeedsRepoint = false;
  if (documentId) {
    const { data: doc } = await supabase
      .from("documents")
      .select("id, oc_id, lot_id, file_name")
      .eq("id", documentId)
      .single();

    if (!doc) return { error: "Document not found" };
    resolvedOcId = doc.oc_id;
    docMeta = { id: doc.id, file_name: doc.file_name };
    docNeedsRepoint = doc.lot_id !== lotId;
  } else {
    const { data: lotRow } = await supabase
      .from("lots")
      .select("oc_id")
      .eq("id", lotId)
      .single();
    if (!lotRow) return { error: "Lot not found" };
    resolvedOcId = lotRow.oc_id;
  }
  void docMeta;
  // Authorize BEFORE any mutation, then confirm the target lot is in this OC.
  await requireOCAccess(resolvedOcId);

  const { data: lot } = await supabase
    .from("lots")
    .select("id, lot_number")
    .eq("id", lotId)
    .eq("oc_id", resolvedOcId)
    .single();

  if (!lot) return { error: "Lot not found in this oc" };

  // The manager may have re-targeted the settlement to a different lot via the
  // drawer's lot selector; re-point the doc now that access + same-OC lot
  // ownership are both verified.
  if (docNeedsRepoint && documentId) {
    await supabase.from("documents").update({ lot_id: lotId }).eq("id", documentId);
  }

  // The OC's management company scopes the owners table (an Owner lives
  // under one management company; if it ever transfers to another we'll
  // duplicate the row at transfer time, since ownership history at the
  // old company stays attributed there).
  const { data: ocRow } = await supabase
    .from("owners_corporations")
    .select("management_company_id")
    .eq("id", resolvedOcId)
    .single();
  if (!ocRow?.management_company_id) {
    return { error: "OC has no management company configured" };
  }
  const managementCompanyId = ocRow.management_company_id;

  const settlementTimestamp = new Date(`${settlementDate}T00:00:00Z`).toISOString();

  // 1. End the current active member, if any.
  const { data: activeMember } = await supabase
    .from("oc_members")
    .select("id, profile_id, joined_at, role, is_primary_contact, is_financial")
    .eq("lot_id", lotId)
    .eq("role", "lot_owner")
    .is("left_at", null)
    .maybeSingle();

  if (activeMember) {
    const { error: updErr } = await supabase
      .from("oc_members")
      .update({ left_at: settlementTimestamp })
      .eq("id", activeMember.id);
    if (updErr) return { error: `Could not end existing ownership: ${updErr.message}` };

    await supabase.from("audit_log").insert({
      profile_id: profile.id,
      oc_id: resolvedOcId,
      action: "ownership_transfer",
      entity_type: "oc_member",
      entity_id: activeMember.id,
      before_state: { left_at: null },
      after_state: { left_at: settlementTimestamp },
      metadata: {
        settlement_document_id: documentId,
        side: "outgoing",
        lot_id: lotId,
      },
    });
  }

  // 1a. End the active lot_ownership for the new entity model. Set end_date
  //     to the settlement date. There may be 0 (first-ever owner) or 1
  //     active row; the partial index lot_ownerships_active_idx makes the
  //     lookup cheap.
  let endedLotOwnershipId: string | null = null;
  {
    const { data: activeOwnership } = await supabase
      .from("lot_ownerships")
      .select("id")
      .eq("lot_id", lotId)
      .is("end_date", null)
      .maybeSingle();
    if (activeOwnership) {
      await supabase
        .from("lot_ownerships")
        .update({ end_date: settlementDate })
        .eq("id", activeOwnership.id);
      endedLotOwnershipId = activeOwnership.id;
    }
  }

  // 2. Mark any existing pending invitation as revoked (replaced by this settlement).
  const { data: existingPending } = await supabase
    .from("invitations")
    .select("id, email, name")
    .eq("lot_id", lotId)
    .eq("status", "pending");

  if (existingPending && existingPending.length > 0) {
    await supabase
      .from("invitations")
      .update({ status: "revoked" })
      .in("id", existingPending.map((i) => i.id));
  }

  // 3. Create the new pending invitation , ONLY when we have an email.
  //    Email is optional for settling a new owner (the manager may not
  //    have it yet). The invitations table requires a non-null email, so
  //    with no email we skip the invitation entirely; the owner still
  //    gets created via the lot_ownerships + lot_owners writes below and
  //    shows as a captured contact. The manager can send an invite later
  //    from the lot once they have the email.
  let invitation: { id: string; code: string; email: string | null; name: string | null } | null = null;
  const inviteEmail = (newOwner.email ?? "").trim();
  if (inviteEmail) {
    const { data: createdInvite, error: invErr } = await supabase
      .from("invitations")
      .insert({
        oc_id: resolvedOcId,
        lot_id: lotId,
        email: inviteEmail,
        name: newOwner.name,
        phone: newOwner.phone,
        role: "lot_owner",
        invited_by: profile.id,
        code: generateInviteCode(),
      })
      .select("id, code, email, name")
      .single();

    if (invErr || !createdInvite) {
      return { error: invErr?.message ?? "Could not create invitation" };
    }
    invitation = createdInvite;
  }

  // 3a. Owner + lot_ownership + settlement , the new entity-model writes.
  //     Owner is matched by case-insensitive email within the OC's
  //     management company; if no match, a new owner row is inserted.
  //     A fresh lot_ownership row starts the new tenure (end_date null).
  //     The settlement row links the old + new lot_ownerships together
  //     with the source PDF document.
  let newOwnerId: string | null = null;
  let newLotOwnershipId: string | null = null;
  let settlementRowId: string | null = null;
  try {
    const normEmail = (newOwner.email ?? "").trim().toLowerCase();
    if (normEmail) {
      const { data: existingOwner } = await supabase
        .from("owners")
        .select("id")
        .eq("management_company_id", managementCompanyId)
        .ilike("email", normEmail)
        .maybeSingle();
      if (existingOwner) newOwnerId = existingOwner.id;
    }
    if (!newOwnerId) {
      const { data: createdOwner, error: ownerErr } = await supabase
        .from("owners")
        .insert({
          management_company_id: managementCompanyId,
          owner_type: "individual",
          name: newOwner.name,
          email: newOwner.email ?? null,
          phone: newOwner.phone ?? null,
          postal_address: newOwner.postalAddress ?? null,
          date_of_birth: newOwner.dateOfBirth ?? null,
        })
        .select("id")
        .single();
      if (ownerErr || !createdOwner) {
        console.error("applySettlementToLot: owner insert failed (non-fatal)", ownerErr);
      } else {
        newOwnerId = createdOwner.id;
      }
    }

    if (newOwnerId) {
      const { data: newOwnership, error: ownershipErr } = await supabase
        .from("lot_ownerships")
        .insert({
          lot_id: lotId,
          owner_id: newOwnerId,
          oc_id: resolvedOcId,
          start_date: settlementDate,
          is_primary_contact: true,
          is_financial: true,
        })
        .select("id")
        .single();
      if (ownershipErr || !newOwnership) {
        console.error("applySettlementToLot: lot_ownership insert failed (non-fatal)", ownershipErr);
      } else {
        newLotOwnershipId = newOwnership.id;
      }
    }

    if (newLotOwnershipId) {
      const { data: settlementRow, error: settlementErr } = await supabase
        .from("settlements")
        .insert({
          oc_id: resolvedOcId,
          lot_id: lotId,
          document_id: documentId,
          settlement_date: settlementDate,
          ended_lot_ownership_id: endedLotOwnershipId,
          created_lot_ownership_id: newLotOwnershipId,
          recorded_by: profile.id,
        })
        .select("id")
        .single();
      if (settlementErr || !settlementRow) {
        console.error("applySettlementToLot: settlement insert failed (non-fatal)", settlementErr);
      } else {
        settlementRowId = settlementRow.id;
        // Backfill source_settlement_id on the just-created lot_ownership.
        await supabase
          .from("lot_ownerships")
          .update({ source_settlement_id: settlementRow.id })
          .eq("id", newLotOwnershipId);
      }
    }
  } catch (err) {
    // The new-table writes are non-fatal in this first cut , the legacy
    // invitation + oc_members flow below remains the source of truth for
    // the existing UI. If owner / lot_ownership / settlement fails we
    // log and carry on; a follow-up migration can repair from the
    // invitation + audit_log records.
    console.error("applySettlementToLot: entity-model writes failed (non-fatal)", err);
  }

  // 3b. Sync the legacy lot_owners row that the lot detail page still
  // reads from (owner identity, postal address + verification status,
  // occupancy, tenant). Best-effort , failures are logged but don't
  // break the settlement.
  try {
    // Addresses are stored as-is. Address verification is not integrated.
    const postalVerificationStatus: string | null = null;
    const postalVerificationId: string | null = null;
    const postalVerifiedAt: string | null = null;

    // Occupancy normalisation. New owners default to owner-occupied unless
    // the manager flagged the lot as tenanted / vacant on the settlement
    // form. Tenant fields are only persisted when occupancy === tenanted.
    const occupancy = parsed.data.occupancyStatus ?? null;
    const ownerOccupied = occupancy === null ? null : occupancy === "owner_occupied";

    // End any active lot_owners row for this lot (left_at semantics
    // aren't on this table, so we just close-out the row to "ended" by
    // setting ownership_until). Then insert the new owner.
    await supabase
      .from("lot_owners")
      .update({ ownership_until: settlementDate })
      .eq("lot_id", lotId)
      .is("ownership_until", null);

    await supabase.from("lot_owners").insert({
      lot_id: lotId,
      name: newOwner.name,
      email: newOwner.email || null,
      phone: newOwner.phone,
      postal_address: newOwner.postalAddress,
      ...(postalVerificationStatus
        ? {
            postal_address_verification_status: postalVerificationStatus,
            postal_address_verification_id: postalVerificationId,
            postal_address_verified_at: postalVerifiedAt,
          }
        : {}),
      owner_type: "individual",
      ownership_since: settlementDate,
      occupancy_status: occupancy,
      is_occupied_by_owner: ownerOccupied,
      tenant_name: occupancy === "tenanted" ? parsed.data.tenantName : null,
      tenant_email: occupancy === "tenanted" ? parsed.data.tenantEmail : null,
      tenant_phone: occupancy === "tenanted" ? parsed.data.tenantPhone : null,
    });
  } catch (err) {
    console.error("applySettlementToLot: lot_owners sync failed (non-fatal)", err);
  }

  // 4. Audit-log the incoming side of the transfer. When there was no
  //    email (no invitation created), still record the ownership change
  //    against the new lot_ownership row so the history is complete.
  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: resolvedOcId,
    action: "ownership_transfer",
    entity_type: invitation ? "invitation" : "lot_owner",
    entity_id: invitation?.id ?? newOwnerId,
    after_state: {
      email: invitation?.email ?? newOwner.email ?? null,
      name: invitation?.name ?? newOwner.name,
      lot_id: lotId,
      invitation_created: !!invitation,
    },
    metadata: {
      settlement_document_id: documentId,
      side: "incoming",
      settlement_date: settlementDate,
      postal_address: newOwner.postalAddress,
      replaced_pending_invitation_ids: existingPending?.map((i) => i.id) ?? [],
    },
  });

  // 5. Notify the outgoing owner in-app (no email).
  if (activeMember?.profile_id) {
    const { data: oc } = await supabase
      .from("owners_corporations")
      .select("name, address")
      .eq("id", resolvedOcId)
      .single();

    const lotLabel = oc?.address ?? oc?.name ?? `Lot ${lot.lot_number}`;
    await supabase.from("notifications").insert({
      profile_id: activeMember.profile_id,
      oc_id: resolvedOcId,
      type: "ownership_ended",
      title: "Ownership transferred",
      body: `Your ownership of ${lotLabel} ended on ${settlementDate}. Your historical records remain available under Past lots.`,
      link: `/dashboard/past-lots/${lotId}`,
    });
  }

  revalidatePath("/ocs/[ocCode]/lots/[lotId]", "page");
  revalidatePath("/ocs/[ocCode]/manage", "page");
  revalidatePath("/dashboard", "page");

  return {
    success: true,
    invitationId: invitation?.id ?? null,
    invitationCode: invitation?.code ?? null,
    endedMemberId: activeMember?.id ?? null,
    // Entity-model surface: tells the caller which new-shape rows were
    // created. Non-fatal , settlementId / newLotOwnershipId may be null
    // if the entity-model write failed (legacy flow still succeeded).
    settlementId: settlementRowId,
    newOwnerId,
    newLotOwnershipId,
    endedLotOwnershipId,
  };
}

// ─── getLotOwnershipHistory (manager-side, for the lot detail page) ─

export async function getLotOwnershipHistory(
  lotId: string,
): Promise<OwnershipHistoryEntry[]> {
  try {
    return await getLotOwnershipHistoryInner(lotId);
  } catch (err) {
    console.error("getLotOwnershipHistory failed:", err);
    return [];
  }
}

async function getLotOwnershipHistoryInner(
  lotId: string,
): Promise<OwnershipHistoryEntry[]> {
  const supabase = createServerClient();

  // ─── Source of truth #1: lot_ownerships + owners + settlements ────────
  //
  // Newly-created OCs and any post-settlement transitions populate the
  // entity tables. Each lot_ownership row carries its own settlement
  // back-reference, so we can join all the way through without the
  // audit_log workaround we used pre-migration.

  const { data: ownerships } = await supabase
    .from("lot_ownerships")
    .select(
      "id, start_date, end_date, is_primary_contact, is_financial, source_settlement_id, owners!inner(id, name, email, profile_id)",
    )
    .eq("lot_id", lotId)
    .order("start_date", { ascending: false });

  if (ownerships && ownerships.length > 0) {
    const settlementIds = ownerships
      .map((o) => o.source_settlement_id)
      .filter((x): x is string => !!x);
    const settlementDocs = new Map<string, { docId: string; fileName: string; filePath: string }>();
    if (settlementIds.length > 0) {
      const { data: settlementRows } = await supabase
        .from("settlements")
        .select("id, document_id, documents(id, file_name, file_path)")
        .in("id", settlementIds);
      for (const s of settlementRows ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (s as any).documents;
        if (doc) {
          settlementDocs.set(s.id, {
            docId: doc.id,
            fileName: doc.file_name,
            filePath: doc.file_path,
          });
        }
      }
    }
    return ownerships.map((o) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const owner = (o as any).owners;
      const docInfo = o.source_settlement_id ? settlementDocs.get(o.source_settlement_id) ?? null : null;
      return {
        id: o.id,
        profileId: owner?.profile_id ?? null,
        name: owner?.name ?? null,
        email: owner?.email ?? null,
        // The OwnershipHistoryEntry type expects ISO timestamp strings.
        // start_date is non-null in the schema; coerce to T00:00:00Z.
        joinedAt: `${o.start_date}T00:00:00Z`,
        leftAt: o.end_date ? `${o.end_date}T00:00:00Z` : null,
        isPrimaryContact: o.is_primary_contact,
        isFinancial: o.is_financial,
        // Document is served only through the authenticated /api/documents
        // route (never a public R2 URL) so a copied link is useless to
        // anyone without an authorised session.
        settlementDocument: docInfo
          ? { id: docInfo.docId, fileName: docInfo.fileName }
          : null,
      };
    });
  }

  // ─── Source of truth #2: legacy oc_members + audit_log fallback ─
  //
  // Pre-entity-migration OCs have no lot_ownership rows yet. Read the
  // historical oc_members rows + the audit_log "ownership_transfer"
  // metadata for the settlement-doc backreference.

  const { data: members, error } = await supabase
    .from("oc_members")
    .select(
      "id, profile_id, joined_at, left_at, is_primary_contact, is_financial, profiles(first_name, last_name, email)",
    )
    .eq("lot_id", lotId)
    .eq("role", "lot_owner")
    .order("joined_at", { ascending: false });

  if (error) throw new Error(`oc_members query failed: ${error.message}`);
  if (!members || members.length === 0) return [];

  const memberIds = members.map((m) => m.id);
  const { data: auditRows } = await supabase
    .from("audit_log")
    .select("entity_id, metadata")
    .eq("entity_type", "oc_member")
    .eq("action", "ownership_transfer")
    .in("entity_id", memberIds);

  const docIds = new Set<string>();
  const docByMember = new Map<string, string>();
  for (const row of auditRows ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (row as any).metadata ?? {};
    if (meta.settlement_document_id && row.entity_id) {
      docByMember.set(row.entity_id, meta.settlement_document_id);
      docIds.add(meta.settlement_document_id);
    }
  }

  const docMap = new Map<string, { fileName: string; filePath: string }>();
  if (docIds.size > 0) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, file_name, file_path")
      .in("id", Array.from(docIds));
    for (const d of docs ?? []) {
      docMap.set(d.id, { fileName: d.file_name, filePath: d.file_path });
    }
  }

  return members.map((m) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (m as any).profiles;
    const docId = docByMember.get(m.id) ?? null;
    const doc = docId ? docMap.get(docId) ?? null : null;
    return {
      id: m.id,
      profileId: m.profile_id,
      name: [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() || null,
      email: p?.email ?? null,
      joinedAt: m.joined_at,
      leftAt: m.left_at,
      isPrimaryContact: m.is_primary_contact,
      isFinancial: m.is_financial,
      settlementDocument: doc
        ? { id: docId!, fileName: doc.fileName }
        : null,
    };
  });
}
