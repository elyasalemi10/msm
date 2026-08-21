import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { ingestDocumentOcr, isOcrable } from "@/lib/ocr/ingest";

// ============================================================================
// GET /api/cron/ocr-sweep , Vercel Cron
// ----------------------------------------------------------------------------
// Full-text OCR is deliberately never run in a request the user is waiting on.
// Uploads and the OC wizard both leave their documents row at
// ocr_status='pending'; this sweep picks those rows up and fills in ocr_text
// so the search bar can match on the contents of the file.
//
// Schedule lives in vercel.json. Vercel cron expressions are UTC only (there
// is no timezone field), which is fine here: the cadence is "every N minutes",
// not a wall-clock time, so daylight saving is irrelevant.
//
// Auth: Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron
// invocation. We reject anything else so the endpoint isn't publicly runnable.
//
// Each document is processed through ingestDocumentOcr, the single source of
// truth for the pipeline. That function never throws and no-ops when the
// document row has since been deleted, so a document removed between upload
// and sweep is simply skipped.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Documents handled per run. Each one is a Document AI round trip, so this is
// bounded to stay inside maxDuration with headroom. Anything left over is
// picked up by the next run.
const BATCH_SIZE = 10;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("ocr-sweep: CRON_SECRET is not configured");
    return NextResponse.json({ error: "unconfigured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    console.warn("ocr-sweep: rejected, bad or missing bearer token");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, mime_type")
    .eq("ocr_status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error("ocr-sweep: query failed", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  const eligible = (data ?? []).filter((row) =>
    isOcrable(row.mime_type as string | null),
  );
  if (eligible.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // Sequential, not parallel: Document AI is the slow part and running ten
  // concurrently would spike memory on a single function instance for no
  // throughput gain against the per-run cap.
  let processed = 0;
  for (const row of eligible) {
    await ingestDocumentOcr(row.id as string);
    processed++;
  }

  return NextResponse.json({ ok: true, processed });
}
