// ============================================================================
// Cloudflare R2 client helper (PP7-A).
// ----------------------------------------------------------------------------
// Consolidates 5 pre-existing inline S3Client init sites into a single
// module-scoped client with typed put/get/delete/presign helpers.
//
// R2 is S3-compatible. Configuration via env:
//   R2_ENDPOINT            , https://{account}.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID       , auth
//   R2_SECRET_ACCESS_KEY   , auth
//   R2_BUCKET_NAME         , single multi-purpose bucket
//   R2_PUBLIC_URL          , public CDN custom domain (used for logo/levy URLs
//                            stored in management_companies.logo_url +
//                            levy_notices.pdf_url)
//
// Path-prefix convention inside the single bucket:
//   logos/{managementCompanyId}/logo.{ext}
//   logos/{managementCompanyId}/signature.{ext}
//   documents/{ocId}/{documentId}.{ext}
//   levies/{ocId}/{referenceNumber}.pdf
//
// Bucket public access: the bucket is fronted by a public CDN custom domain
// (R2_PUBLIC_URL). Objects can be fetched anonymously via that domain ,
// logos rendered in unauthenticated SMTP-delivered email <img> tags rely on
// this. PDF retrieval inside the dashboard also uses the public URL today;
// PP7-A keeps that semantic. getSignedDownloadUrl is exported for future use
// when PII concerns push us to time-limited access.
//
// Module-scoped client is intentional , S3Client is heavy to construct and
// safely shared across requests. R2 has no per-connection limit issue on
// Vercel's lambda-per-request model.
// ============================================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  if (!process.env.R2_ENDPOINT) {
    throw new Error("R2_ENDPOINT is not configured");
  }
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 credentials are not configured");
  }
  _client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

// Public bucket , anonymously readable via R2_PUBLIC_URL. Holds assets that
// MUST render in unauthenticated contexts (logos in outbound email, levy
// notice PDFs delivered to owners, avatars).
export function getBucket(): string {
  return (
    process.env.R2_BUCKET_PUBLIC ??
    process.env.R2_BUCKET_NAME ??
    "stratawise-public"
  );
}

// Key prefixes that hold SENSITIVE objects , these live in the private
// (confidential) bucket which has NO public URL and is only ever served
// through authenticated app routes (/api/documents, /api/insurance-docs,
// /api/inbox-attachments) via fetchObject.
//
// What stays in the PUBLIC bucket: logos (rendered in unauthenticated email
// img tags), blog/ images (marketing site content). Everything else lives
// in confidential.
//
// Levies migrated to confidential 2026-06: notice PDFs carry the owner's
// name + address + BPAY CRN + amount. The email path already attaches via
// fetchObject (which works for confidential prefixes); direct links (when
// we add them in dashboards / owner portals) should use
// getSignedDownloadUrl. Existing levies stored under R2 PUBLIC stay where
// they are , the stored pdf_url still resolves , but every NEW levy goes
// to confidential.
const CONFIDENTIAL_PREFIXES = [
  "documents/",
  "insurance/",
  "plans/",
  "rules/",
  "inbound-emails/",
  "levies/",
  "contractors/",
  "meetings/",
  "vcat-packs/",
  "followup/",
];

// Resolve the bucket for a key. Confidential prefixes (OC documents,
// insurance, plans, rules, inbound emails, levies) ALWAYS go to the
// private bucket. If R2_BUCKET_CONFIDENTIAL isn't configured we throw
// rather than silently falling back to the public bucket , uploading
// an OC document to a publicly-readable bucket is a data leak we never
// want to ship by accident. Only non-sensitive prefixes (logos, blog
// assets) live in the public bucket.
function bucketForKey(key: string): string {
  const isConfidential = CONFIDENTIAL_PREFIXES.some((p) => key.startsWith(p));
  if (isConfidential) {
    const confidential = process.env.R2_BUCKET_CONFIDENTIAL;
    if (!confidential) {
      throw new Error(
        "Confidential storage is not configured. Set R2_BUCKET_CONFIDENTIAL in Vercel AND Trigger.dev environments.",
      );
    }
    return confidential;
  }
  return getBucket();
}

// Public CDN base, always with a scheme. R2_PUBLIC_URL may be configured as a
// bare custom domain ("cdn.stratawise.com.au") , without normalising, the
// stored URLs come out scheme-less and the browser treats them as relative
// paths (a scheme-less <audio>/<img> src 404s). Force https:// when missing.
export function publicBase(): string {
  const raw = (process.env.R2_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Upload an object to R2. Returns the full public CDN URL.
 */
export async function uploadObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<{ key: string; publicUrl: string }> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucketForKey(key),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  const publicUrl = `${publicBase()}/${key}`;
  return { key, publicUrl };
}

/**
 * Fetch an object's bytes from R2. Used by the email layer to attach
 * PDFs and by the OCR worker to read the uploaded source file. Always
 * reads from the bucket that `bucketForKey` resolves , no fallback,
 * so confidential prefixes can never accidentally leak into the
 * public bucket on either side of the upload/read pair.
 *
 * Tags the bucket name into thrown errors so OCR failures in the DB
 * tell operators which bucket the worker tried to read from (catches
 * env-var skew between Vercel and Trigger.dev at a glance).
 */
export async function fetchObject(key: string): Promise<Buffer> {
  const client = getClient();
  const bucket = bucketForKey(key);
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!res.Body) {
      throw new Error(`R2 fetchObject: empty body for ${key} (bucket=${bucket})`);
    }
    const bodyAsAsyncIterable = res.Body as {
      transformToByteArray: () => Promise<Uint8Array>;
    };
    const bytes = await bodyAsAsyncIterable.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name
      ?? (err as { Code?: string }).Code
      ?? "unknown";
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`R2 fetchObject failed (bucket=${bucket}, code=${code}): ${msg}`);
  }
}

/**
 * Delete an object from R2.
 */
export async function deleteObject(key: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucketForKey(key),
      Key: key,
    }),
  );
}

/**
 * Build the public CDN URL for a key without performing any network call.
 * Use when storing the URL in the database after uploadObject (or to
 * reconstruct on demand).
 */
export function publicUrlFor(key: string): string {
  return `${publicBase()}/${key}`;
}

/**
 * Extract the object key from a previously-stored public CDN URL. Returns
 * null when the URL doesn't match the configured prefix (e.g. legacy or
 * external URL).
 */
export function keyFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const base = publicBase();
  if (!base) return null;
  // Compare host+path with the scheme stripped from both sides, so a stored
  // URL works whether it has https:// or is a legacy scheme-less value.
  const strip = (s: string) => s.replace(/^https?:\/\//i, "");
  const b = strip(base);
  const u = strip(url);
  if (!u.startsWith(b + "/")) return null;
  return u.slice(b.length + 1);
}

/**
 * Build a time-limited presigned download URL.
 *
 * Default 15 minutes (matches the document-proxy redirect policy) so
 * sensitive strata documents can be served via direct R2 URLs without
 * the URL itself being long-lived. Callers serving non-sensitive assets
 * (logos rendered into outbound email, for example) should keep using
 * `publicUrlFor` so the asset stays inline-renderable.
 *
 * Optionally accepts the user-facing filename so the signed URL forces
 * the right download name even when the R2 key is something like
 * `documents/<ocId>/<uuid>.pdf`.
 */
export async function getSignedDownloadUrl(
  key: string,
  expiresInSeconds = 900, // 15 minutes
  options?: { filename?: string; inline?: boolean },
): Promise<string> {
  const client = getClient();
  const disposition = options?.filename
    ? `${options.inline ? "inline" : "attachment"}; filename="${encodeURIComponent(
        options.filename,
      )}"`
    : undefined;
  const command = new GetObjectCommand({
    Bucket: bucketForKey(key),
    Key: key,
    ResponseContentDisposition: disposition,
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}
