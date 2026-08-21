// Bench Gemini 2.5 Pro vs 2.5 Flash on the example PDFs in /public.
//
// Usage:
//   npx tsx scripts/test-pro-vs-flash.ts
//
// Reads GEMINI_API_KEY from .env.local (service-account JSON path or bare
// API key — same env shape as the production parsers). Calls each parser
// twice (once with each model) and reports timing + a coarse output shape
// diff so you can decide whether Flash is good enough.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

loadEnv({ path: resolve(process.cwd(), ".env.local") });

const RULES_PDF = resolve(process.cwd(), "public/rules-example.pdf");
const COC_PDF = resolve(process.cwd(), "public/coc-example.pdf");

const RULES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_oc_rules: { type: Type.BOOLEAN },
    document_type_guess: { type: Type.STRING },
    oc_scopes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          plan_number: { type: Type.STRING, nullable: true },
          rule_count: { type: Type.INTEGER },
        },
        required: ["label", "rule_count"],
      },
    },
    rules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          oc_scope: { type: Type.STRING },
          parent_heading: { type: Type.STRING, nullable: true },
          chapter_number: { type: Type.STRING, nullable: true },
          chapter_heading: { type: Type.STRING, nullable: true },
          section_number: { type: Type.STRING, nullable: true },
          section_heading: { type: Type.STRING, nullable: true },
          rule_number: { type: Type.STRING },
          heading: { type: Type.STRING, nullable: true },
          body: { type: Type.STRING },
          page_number: { type: Type.INTEGER, nullable: true },
        },
        required: ["oc_scope", "rule_number", "body"],
      },
    },
  },
  required: ["is_oc_rules", "document_type_guess", "oc_scopes", "rules"],
};

const RULES_PROMPT = `Extract every numbered rule from this Owners Corporation rules PDF. For every rule populate chapter_number+heading and section_number+heading. Output a JSON object matching the response schema. Return rules=[] if the PDF is not OC rules.`;

const COC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_insurance_certificate: { type: Type.BOOLEAN },
    document_type_guess: { type: Type.STRING },
    plan_number: { type: Type.STRING, nullable: true },
    insured_name: { type: Type.STRING, nullable: true },
    policies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          provider: { type: Type.STRING },
          policy_number: { type: Type.STRING, nullable: true },
          policy_type: {
            type: Type.STRING,
            enum: ["building", "public_liability", "combined", "fidelity", "voluntary_workers", "other"],
          },
          sum_insured: { type: Type.NUMBER, nullable: true },
          premium: { type: Type.NUMBER, nullable: true },
          start_date: { type: Type.STRING, nullable: true },
          end_date: { type: Type.STRING, nullable: true },
          start_time: { type: Type.STRING, nullable: true },
          end_time: { type: Type.STRING, nullable: true },
        },
        required: ["provider", "policy_type"],
      },
    },
  },
  required: ["is_insurance_certificate", "document_type_guess", "plan_number", "insured_name", "policies"],
};

const COC_PROMPT = `Extract every policy section from this strata insurance certificate. Bundle policies sharing one policy number under policy_type="combined". Return JSON matching the schema. Set is_insurance_certificate=false if it's not an insurance cert.`;

function buildClient(): GoogleGenAI {
  const raw = process.env.GEMINI_API_KEY;
  if (!raw) throw new Error("GEMINI_API_KEY not set in .env.local");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const credentials = JSON.parse(trimmed);
    return new GoogleGenAI({
      vertexai: true,
      project: credentials.project_id,
      location: "global",
      googleAuthOptions: { credentials },
    });
  }
  return new GoogleGenAI({ apiKey: trimmed });
}

async function runParse(
  ai: GoogleGenAI,
  model: string,
  pdfBytes: Buffer,
  prompt: string,
  schema: unknown,
): Promise<{ ms: number; result: unknown; error?: string }> {
  const t0 = Date.now();
  try {
    const r = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 65535,
        responseMimeType: "application/json",
        responseSchema: schema as never,
      },
    });
    const ms = Date.now() - t0;
    const text = r.text;
    if (!text) return { ms, result: null, error: "empty response" };
    return { ms, result: JSON.parse(text) };
  } catch (err) {
    return { ms: Date.now() - t0, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function summariseRules(result: unknown): string {
  if (!result || typeof result !== "object") return "(no result)";
  const r = result as { is_oc_rules?: boolean; rules?: unknown[]; oc_scopes?: unknown[] };
  if (!r.is_oc_rules) return "not classified as OC rules";
  const rules = r.rules ?? [];
  const withChapter = rules.filter((x) => x && typeof x === "object" && (x as { chapter_number?: unknown }).chapter_number).length;
  const withSection = rules.filter((x) => x && typeof x === "object" && (x as { section_number?: unknown }).section_number).length;
  return `${rules.length} rules, ${withChapter} chapters tagged, ${withSection} sections tagged, ${r.oc_scopes?.length ?? 0} OC scope(s)`;
}

function summariseCoc(result: unknown): string {
  if (!result || typeof result !== "object") return "(no result)";
  const r = result as { is_insurance_certificate?: boolean; policies?: unknown[]; plan_number?: unknown; insured_name?: unknown };
  if (!r.is_insurance_certificate) return "not classified as CoC";
  const policies = r.policies ?? [];
  const withDates = policies.filter((x) => x && typeof x === "object" && (x as { start_date?: unknown }).start_date && (x as { end_date?: unknown }).end_date).length;
  const withTimes = policies.filter((x) => x && typeof x === "object" && (x as { start_time?: unknown }).start_time).length;
  const withPremium = policies.filter((x) => x && typeof x === "object" && (x as { premium?: unknown }).premium != null).length;
  return `${policies.length} policies (${withDates} with dates, ${withTimes} with times, ${withPremium} with premium), plan=${r.plan_number ?? "—"}, insured=${(r.insured_name as string | null | undefined)?.slice(0, 40) ?? "—"}`;
}

async function main() {
  const ai = buildClient();

  const rules = readFileSync(RULES_PDF);
  const coc = readFileSync(COC_PDF);
  console.log(`Rules PDF size: ${(rules.length / 1024).toFixed(1)} KB`);
  console.log(`CoC PDF size:   ${(coc.length / 1024).toFixed(1)} KB`);
  console.log("");

  // Run in pairs (one model at a time per parser to avoid double-charging
  // for the same PDF upload on the network).
  for (const model of ["gemini-2.5-pro", "gemini-2.5-flash"]) {
    console.log(`========== ${model} ==========`);
    const rulesResult = await runParse(ai, model, rules, RULES_PROMPT, RULES_SCHEMA);
    console.log(`  rules:     ${(rulesResult.ms / 1000).toFixed(1)}s — ${rulesResult.error ?? summariseRules(rulesResult.result)}`);
    const cocResult = await runParse(ai, model, coc, COC_PROMPT, COC_SCHEMA);
    console.log(`  insurance: ${(cocResult.ms / 1000).toFixed(1)}s — ${cocResult.error ?? summariseCoc(cocResult.result)}`);
    console.log("");

    // Save the raw outputs so we can diff key fields by hand if needed.
    const out = { model, rules: rulesResult.result, insurance: cocResult.result, timings: { rules_ms: rulesResult.ms, insurance_ms: cocResult.ms } };
    const fname = `/tmp/parser-test-${model}.json`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fname, JSON.stringify(out, null, 2));
    console.log(`  → saved full output to ${fname}\n`);
  }
}

main().catch((err) => {
  console.error("test failed:", err);
  process.exit(1);
});
