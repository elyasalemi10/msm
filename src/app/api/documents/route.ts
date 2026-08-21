import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_SIZE } from "@/lib/validations/documents";
import { uploadObject, publicUrlFor } from "@/lib/storage/r2";
import { isOcrable } from "@/lib/ocr/ingest";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitiseFileName(name: string): string {
  // Strip path separators and control chars, collapse whitespace, cap length.
  const base = name.replace(/[/\\]/g, "_").replace(/[\x00-\x1f]/g, "").trim();
  return base.slice(0, 200) || "document";
}

export async function POST(request: NextRequest) {
  let profile;
  try {
    profile = await requireCompanyRole();
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const ocId = formData.get("oc_id") as string | null;
  const lotId = formData.get("lot_id") as string | null;
  const category = (formData.get("category") as string) || "other";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (!ocId || !UUID_REGEX.test(ocId)) {
    return NextResponse.json({ error: "Valid oc_id is required" }, { status: 400 });
  }

  if (lotId && !UUID_REGEX.test(lotId)) {
    return NextResponse.json({ error: "Invalid lot_id" }, { status: 400 });
  }

  try {
    await requireOCAccess(ocId);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: "File type not supported. Allowed: PDF, DOC, DOCX, XLS, XLSX, PNG, JPG, TXT, CSV" },
      { status: 400 }
    );
  }

  if (file.size > MAX_DOCUMENT_SIZE) {
    return NextResponse.json(
      { error: "File too large. Maximum 25MB." },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  // If uploading against a lot, ensure the lot belongs to this OC.
  if (lotId) {
    const { data: lot } = await supabase
      .from("lots")
      .select("id, oc_id")
      .eq("id", lotId)
      .single();
    if (!lot || lot.oc_id !== ocId) {
      return NextResponse.json({ error: "Lot does not belong to this OC" }, { status: 400 });
    }
  }

  const safeName = sanitiseFileName(file.name);
  const uuid = crypto.randomUUID();
  const folder = lotId || "oc";
  const key = `documents/${ocId}/${folder}/${uuid}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadObject(key, buffer, file.type);

  // The "self-OCR" categories (settlement parse, insurance parse,
  // plan-of-subdivision + OC-rules + certificate_of_currency) used to
  // SKIP the background Doc AI queue entirely because the inline
  // Gemini parse already wrote structured fields. That meant their
  // full-text wasn't searchable from the docs page.
  //
  // We now run BOTH pipelines: the upload route still queues Doc AI
  // for plain-text indexing, AND the inline caller writes its
  // structured output. Doc AI's `ocr_text` lands on the documents
  // row; the inline parse's structured columns live wherever they
  // belong (insurance_policies, settlements, oc_drafts, etc).
  // ocr_status starts "pending" so the cron sweep can flip it to
  // "complete" once Document AI finishes.
  const willOcr = isOcrable(file.type);
  const { data: doc, error } = await supabase
    .from("documents")
    .insert({
      oc_id: ocId,
      lot_id: lotId || null,
      category,
      file_name: safeName,
      file_path: key,
      file_size: file.size,
      mime_type: file.type,
      is_confidential: false,
      uploaded_by: profile.id,
      // Self-OCR categories carry their own status lifecycle (the inline
      // parse flips it to complete). Generic docs start pending → the
      // background job moves them to complete.
      ocr_status: willOcr ? "pending" : "skipped",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "upload",
    entity_type: "document",
    entity_id: doc.id,
    after_state: { file_name: safeName, category, lot_id: lotId || null },
    // metadata.lot_id is what lot-overview's activity feed filters on , without
    // it the lot's History tab never surfaces document uploads.
    metadata: lotId ? { lot_id: lotId } : null,
  });

  // OCR is never run in the request path , it costs seconds and the user
  // is waiting. The row is left at ocr_status='pending' and the cron sweep
  // (/api/cron/ocr-sweep) picks it up within 10 minutes and fills in
  // ocr_text. Search just doesn't match the file's contents until then.

  return NextResponse.json({
    ...doc,
    public_url: publicUrlFor(key),
  });
}
