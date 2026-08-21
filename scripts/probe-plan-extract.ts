/* eslint-disable no-console */
// One-off probe: ask Gemini what's discoverable in public/plan-of-sub-example.pdf
// BEYOND the fields we already extract in src/lib/parse-plan.ts. Helps decide
// what to add to the wizard pre-fill so the user types less.
//
// Usage:
//   npx tsx scripts/probe-plan-extract.ts
//
// Reads GEMINI_API_KEY from .env.local (loaded via dotenv-cli).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";

// Manually load .env.local. We can't `source` it from zsh because the JSON
// service-account value contains characters that break shell parsing.
const envPath = resolve(process.cwd(), ".env.local");
const envText = readFileSync(envPath, "utf8");
// dotenv-style parser: KEY=value (each line). DO NOT unescape \n — the
// service-account JSON keeps `\n` as the two-char escape sequence inside the
// string, and JSON.parse expands it correctly at consumption time. If we
// pre-unescape we end up with literal newlines breaking JSON.parse.
for (const m of envText.matchAll(/^([A-Z_][A-Z0-9_]*)=(.*)$/gm)) {
  const key = m[1];
  let val = m[2].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

type ServiceAccount = { project_id?: string };

function buildClient(): GoogleGenAI {
  const raw = process.env.GEMINI_API_KEY;
  if (!raw) throw new Error("GEMINI_API_KEY missing");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const credentials = JSON.parse(trimmed) as ServiceAccount;
    if (!credentials.project_id) throw new Error("service account missing project_id");
    return new GoogleGenAI({
      vertexai: true,
      project: credentials.project_id,
      location: "global",
      googleAuthOptions: { credentials: credentials as object },
    });
  }
  return new GoogleGenAI({ apiKey: trimmed });
}

async function main() {
  const ai = buildClient();
  const pdfPath = resolve(process.cwd(), "public/plan-of-sub-example.pdf");
  const pdfBytes = readFileSync(pdfPath);
  console.log(`PDF size: ${pdfBytes.length} bytes`);

  // First pass: ask for a thorough free-form inventory.
  const inventoryPrompt = `You are reading a Victorian Plan-of-Subdivision PDF.

Your job: produce an inventory of EVERY discrete piece of structured data this document contains that could be extracted by a strata-management onboarding wizard.

Be exhaustive. Include:
- Identifying info (plan number, council reference, surveyor, registered date, vesting deed references)
- Owners Corporations created (numbers, optional names, restricted/unrestricted, schedule of which lots belong to which)
- Common property descriptions
- Lot schedule (lot numbers, unit numbers / apartment labels if any, unit entitlement, lot liability, lot purpose if shown)
- Easements, covenants, restrictions, road reserves, drainage reserves
- Building details if shown (storeys, building name, services-only flags)
- Address + locality info
- Total site area / individual lot areas
- Any flag for "this OC is services-only", "this OC has restrictive scope", etc.
- Any cross-reference to other plans (folio, parent title)

Then for each item, mark which would be USEFUL to pre-fill into a strata onboarding wizard (vs trivia).

Format as a markdown list. No code, no JSON, just a clean inventory.`;

  const r1 = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{
      role: "user",
      parts: [
        { text: inventoryPrompt },
        { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
      ],
    }],
    config: { temperature: 0.1 },
  });
  console.log("\n=== INVENTORY PASS ===\n");
  console.log(r1.text);

  // Second pass: compare to our current schema and call out gaps.
  const gapPrompt = `Our wizard currently extracts these fields from a Plan of Subdivision:
- plan_of_subdivision_number, plan_of_subdivision_confidence
- For each OC: oc_number, oc_name, address (formatted), street_number, street_name, suburb, state, postcode, building_name, storeys, site_area_sqm, property_type, registered_year, common_property_description, lot_count
- For each lot: lot_number, unit_number, unit_entitlement, lot_liability, confidence

What ADDITIONAL fields in THIS specific PDF could we extract that we currently don't? List them with: field name, where it appears in the document, why it's useful to pre-fill (1-line each). Skip anything that's just nice-to-have trivia.`;

  const r2 = await ai.models.generateContent({
    model: "gemini-2.5-pro",
    contents: [{
      role: "user",
      parts: [
        { text: gapPrompt },
        { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
      ],
    }],
    config: { temperature: 0.1 },
  });
  console.log("\n=== GAP-VS-CURRENT-SCHEMA PASS ===\n");
  console.log(r2.text);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
