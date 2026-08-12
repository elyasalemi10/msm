import { NextRequest, NextResponse } from "next/server";
import { getAuthUserId } from "@/lib/auth";
import { publicBase } from "@/lib/storage/r2";
const ALLOWED_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"];

// R2_PUBLIC_URL may be configured as a bare custom domain
// ("cdn.stratawise.com.au"), and rows written before publicBase() landed can
// hold scheme-less URLs too. Force https:// on both sides before parsing,
// otherwise new URL() throws and the proxy 500s on every image.
function withScheme(value: string): string {
  const raw = value.trim();
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export async function GET(request: NextRequest) {
  const userId = await getAuthUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // publicBase() already normalises the scheme and strips a trailing slash.
  const r2Domain = publicBase();
  if (!r2Domain) {
    console.error("proxy-image: R2_PUBLIC_URL is not set");
    return NextResponse.json({ error: "Image proxy not configured" }, { status: 500 });
  }

  const url = request.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(withScheme(url));
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  let allowed: URL;
  try {
    allowed = new URL(r2Domain);
  } catch {
    console.error(`proxy-image: R2_PUBLIC_URL is not a usable host: ${r2Domain}`);
    return NextResponse.json({ error: "Image proxy not configured" }, { status: 500 });
  }

  // Only allow proxying from our R2 public host, over https, same origin.
  if (parsed.protocol !== "https:" || parsed.host !== allowed.host) {
    return NextResponse.json({ error: "Invalid URL" }, { status: 403 });
  }

  try {
    const res = await fetch(parsed.toString());
    if (!res.ok) {
      return NextResponse.json({ error: "Upstream error" }, { status: 502 });
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))) {
      return NextResponse.json({ error: "Unsupported content type" }, { status: 415 });
    }
    const buffer = await res.arrayBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}
