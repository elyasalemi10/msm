/**
 * Company branding logo-validator verification (PP7-A).
 *
 * Exercises the pure `validateLogoFile` helper from
 * src/lib/actions/company-branding.ts. The server-action wrapper
 * (updateCompanyLogo) is exercised end-to-end via the deploy-time UI
 * smoke walk , this suite is for the validation gate (size, type,
 * dimension) which is the only path with non-trivial logic worth a
 * standalone harness.
 *
 * pattern (the validator itself never sends mail; the gate is here as a
 * safety net for cross-imports).
 *
 * Usage:
 *   npx tsx src/lib/actions/company-branding.verification.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { validateLogoFile } from "./company-branding";
import {
  MAX_LOGO_BYTES,
  MAX_LOGO_WIDTH,
  MAX_LOGO_HEIGHT,
} from "./company-branding-constants";

type Result = { scenario: string; passed: boolean; detail: string };
const results: Result[] = [];

function record(scenario: string, passed: boolean, detail: string) {
  results.push({ scenario, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${scenario}${detail ? " , " + detail : ""}`);
}

// ─── Test PNG fixtures ─────────────────────────────────────────────────
// 1×1 transparent PNG (smallest valid PNG; 67 bytes, 1×1 dimensions).
// Decoded from the canonical base64.
const TINY_VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

// PNG with synthesized dimensions > MAX_LOGO_WIDTH × MAX_LOGO_HEIGHT.
// Construct a 1000×500 PNG header that image-size can parse. The pixel
// data is invalid but image-size only reads the IHDR chunk.
function buildOversizedPng(width: number, height: number): Buffer {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR chunk: length (4) + type (4) + data (13) + crc (4)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type (RGBA)
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from("IHDR", "ascii");
  // CRC value is irrelevant for image-size IHDR-only parsing.
  const ihdrCrc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc]);
}

// ─── Scenarios ─────────────────────────────────────────────────────────

async function cb1_happyPath() {
  const result = await validateLogoFile(TINY_VALID_PNG, "image/png", TINY_VALID_PNG.length);
  const ok = result.ok === true;
  record(
    "CB-1: 1×1 PNG within 1MB cap + 800×400 dimensions → validateLogoFile.ok=true",
    ok,
    `result=${JSON.stringify(result)}`,
  );
}

async function cb2_fileTooLargeRejected() {
  // Build a buffer > MAX_LOGO_BYTES (1MB). Content doesn't have to be a
  // real image , the size check fires before image-size is called.
  const bigBuffer = Buffer.alloc(MAX_LOGO_BYTES + 1, 0);
  const result = await validateLogoFile(bigBuffer, "image/png", bigBuffer.length);
  const ok = result.ok === false && result.errorCode === "FILE_TOO_LARGE";
  record(
    "CB-2: buffer > 1MB → FILE_TOO_LARGE",
    ok,
    `result=${JSON.stringify(result)}`,
  );
}

async function cb3_invalidTypeRejected() {
  const result = await validateLogoFile(TINY_VALID_PNG, "image/gif", TINY_VALID_PNG.length);
  const ok = result.ok === false && result.errorCode === "INVALID_TYPE";
  record(
    "CB-3: image/gif mimeType → INVALID_TYPE",
    ok,
    `result=${JSON.stringify(result)}`,
  );
}

async function cb4_dimensionsTooLargeRejected() {
  // Build a synthetic PNG header reporting 1000×500 dimensions
  // (exceeds 800×400 cap). image-size reads only the IHDR chunk.
  const oversized = buildOversizedPng(MAX_LOGO_WIDTH + 200, MAX_LOGO_HEIGHT + 100);
  const result = await validateLogoFile(oversized, "image/png", oversized.length);
  const ok = result.ok === false && result.errorCode === "DIMENSIONS_TOO_LARGE";
  record(
    "CB-4: 1000×500 PNG → DIMENSIONS_TOO_LARGE",
    ok,
    `result=${JSON.stringify(result)}`,
  );
}

async function main() {
  console.log("Company branding logo validator , PP7-A scenarios CB-1..CB-4\n");
  await cb1_happyPath();
  await cb2_fileTooLargeRejected();
  await cb3_invalidTypeRejected();
  await cb4_dimensionsTooLargeRejected();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
