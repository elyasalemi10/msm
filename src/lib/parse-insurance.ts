import "server-only";
import { GoogleGenAI, Type } from "@google/genai";

// Insurance Certificate of Currency / policy schedule parser (Gemini 2.5 Pro).
//
// Most OCs receive an annual "Certificate of Currency" PDF from their insurer
// (CHU, Strata Community Insurance, QBE, Longitude, etc.). It lists every
// policy section the OC holds: building, public liability, voluntary workers,
// fidelity guarantee, etc. We extract the fields that map onto our
// insurance_policies row shape so the wizard can prefill the form.

export type ParsedInsurancePolicy = {
  provider: string;
  policy_number: string | null;
  /** Gemini PREFERS one of: building, public_liability, combined,
   *  contents, workers_comp, office_bearers, fidelity. Falls back to a
   *  short custom snake_case label for unusual policy types (e.g.
   *  plant_machinery, cyber_liability). UI maps unknown values onto
   *  the "Other" select option with the raw value preserved as the
   *  custom-type label. */
  policy_type: string;
  sum_insured: number | null;
  premium: number | null;
  start_date: string | null;      // ISO yyyy-mm-dd
  end_date: string | null;        // ISO yyyy-mm-dd
};
// Note: Gemini does NOT extract "notes" , the field is manager-entered only.
// The model kept hallucinating boilerplate like "Policy covers Strata
// Building with Legal Liability of $20,000,000. Financial Interest:
// National Australia Bank LIMITED. This certificate is for information
// only and does not amend, extend or alter the coverage provided by the
// policy." That's restating the structured fields, not adding context.
// notes stays in the DB + the UI textbox, but only the manager writes to it.

export type ParsedInsuranceDocument = {
  /** Did Gemini decide this is a real CoC / policy schedule? */
  is_insurance_certificate: boolean;
  /** Free-text guess of what the upload actually is. */
  document_type_guess: string;
  /** Plan-of-Subdivision number shown on the certificate, if present.
   *  Format: PS + 6 digits + 1 letter (e.g. "PS812345X"). Null if not located. */
  plan_number: string | null;
  /** "Insured" / "Owners Corporation" name from the cert header, if present. */
  insured_name: string | null;
  policies: ParsedInsurancePolicy[];
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_insurance_certificate: {
      type: Type.BOOLEAN,
      description:
        "True ONLY if this PDF is a Certificate of Currency or insurance policy schedule for a strata / owners-corporation building. False for plan-of-subdivision PDFs, OC rules, levy notices, photos, contracts, or anything else.",
    },
    document_type_guess: { type: Type.STRING, description: "One-line guess of the upload's actual type." },
    plan_number: {
      type: Type.STRING,
      nullable: true,
      description: "Plan-of-Subdivision number shown on the certificate (format PS + 6 digits + 1 letter, e.g. 'PS812345X'). Null if not found.",
    },
    insured_name: {
      type: Type.STRING,
      nullable: true,
      description: "'Insured' / 'Owners Corporation' / 'Body Corporate' name from the certificate header. Null if not found.",
    },
    policies: {
      type: Type.ARRAY,
      description: "Every distinct policy section listed on the certificate. Typically 1-5 entries.",
      items: {
        type: Type.OBJECT,
        properties: {
          provider: { type: Type.STRING, description: "Insurer/underwriter name (e.g. 'CHU Underwriting Agencies', 'Strata Community Insurance', 'QBE')." },
          policy_number: { type: Type.STRING, nullable: true, description: "Policy number verbatim. Null if not shown." },
          policy_type: {
            type: Type.STRING,
            description:
              "Best-fit category. PREFER one of these exact snake_case enum values: 'building', 'public_liability', 'contents', 'workers_comp', 'office_bearers', 'fidelity'. Treat 'voluntary_workers' as a synonym for 'workers_comp'. If the certificate covers MULTIPLE distinct sections (e.g. building + public liability + voluntary workers as one bundled policy), DO NOT return 'combined' or any other snake_case token , instead return a SHORT human-readable Title Case label describing the bundle, e.g. 'Building + Public Liability', 'Building + Indemnity + Workers Comp', 'Strata Pack'. The UI uses this string verbatim as the policy type, so write what a manager would say to another manager (not a code name).",
          },
          sum_insured: { type: Type.NUMBER, nullable: true, description: "Sum insured in AUD. Strip currency symbols + commas. Null if not applicable (public liability has 'limit of liability' , use that)." },
          premium: { type: Type.NUMBER, nullable: true, description: "Annual premium in AUD inclusive of GST + stamp duty. Null if not shown." },
          start_date: { type: Type.STRING, nullable: true, description: "ISO yyyy-mm-dd. Period of insurance FROM date." },
          end_date: { type: Type.STRING, nullable: true, description: "ISO yyyy-mm-dd. Period of insurance TO date." },
        },
        required: ["provider", "policy_type"],
      },
    },
  },
  required: ["is_insurance_certificate", "document_type_guess", "plan_number", "insured_name", "policies"],
};

const SYSTEM_PROMPT = `You extract every policy section from a strata / owners-corporation Certificate of Currency or insurance policy schedule PDF.

CRITICAL , how to count policies:
- A "policy" is anything the cert assigns its OWN policy number to. ONE policy number = ONE policy, even if the cert lists multiple coverage limits under it (e.g. "Sum Insured" for the building AND "Legal Liability" / "Public Liability" / "Workers Compensation" as separate limits within the same policy).
- Australian strata policies are typically BUNDLED , a single "Strata Building" or "Residential Strata" policy carries Building, Public/Legal Liability, sometimes Voluntary Workers and Fidelity, all under one policy number. Output ONE entry with policy_type="combined" when you see that.
- DO NOT emit a separate policy entry for each coverage limit. If you see policy number HSA154109901 with Sum Insured $3,045,000 AND Legal Liability $20 million, that's ONE policy with sum_insured=3045000 and policy_type="combined" , NOT two policies.
- Emit a separate policy entry only when there's a DIFFERENT policy_number (e.g. a separate "fidelity guarantee" policy from a different insurer or with a distinct policy number).

Other rules:
- Return policies in source order.
- Money fields are AUD numbers, no currency symbols. Strip commas: "$12,500,000" → 12500000.
- "Legal Liability $20 million" → 20000000 (parse abbreviations like 'million' / 'm' / 'mn').
- Dates: ISO yyyy-mm-dd. Australian DD/MM/YYYY is the dominant source format , convert carefully. Do NOT extract times , the form has dropped time fields.
- Do NOT produce a "notes" field. That field is reserved for the manager's own annotations (mid-year broker changes, claim history, etc.) and should not be populated from boilerplate cert language. If you find policy-level info that doesn't fit the structured fields, leave it out rather than inventing a notes field.
- plan_number: scan the cert for the Plan-of-Subdivision identifier ("PS812345X" or similar , "PS" + 6 digits + 1 letter). Typically near the address or under "Insured" / "Property Description". Case-insensitive , emit upper-case. Null if not present.
- insured_name: the named insured / owners corporation name from the cert header. Null if not present.

Document-type gate:
- BEFORE extracting anything, decide whether this PDF IS a CoC or policy schedule for a strata building.
- If it's something else (plan of subdivision, OC rules, levy notice, photo, contract, blank page), set is_insurance_certificate=false, document_type_guess to your best one-line description, plan_number=null, insured_name=null, and policies=[].
- When in doubt return false. The manager can re-upload.`;

type ServiceAccount = { project_id?: string; client_email?: string; private_key?: string };

function buildClient(): GoogleGenAI {
  const raw = process.env.GEMINI_API_KEY;
  if (!raw) {
    console.error("parseInsurancePdf: GEMINI_API_KEY missing");
    throw new Error("Automatic insurance parsing is temporarily unavailable.");
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let credentials: ServiceAccount;
    try {
      credentials = JSON.parse(trimmed) as ServiceAccount;
    } catch {
      throw new Error("Automatic insurance parsing is temporarily unavailable.");
    }
    return new GoogleGenAI({
      vertexai: true,
      project: credentials.project_id,
      location: "global",
      googleAuthOptions: { credentials },
    });
  }
  return new GoogleGenAI({ apiKey: trimmed });
}

export async function parseInsurancePdf(pdfBytes: Buffer): Promise<ParsedInsuranceDocument> {
  const ai = buildClient();
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract every policy section from this strata insurance certificate." },
          { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.1,
      // Insurance schedules are short (1-5 policies typically) so the
      // default would usually be fine , but a 65535 cap costs nothing
      // when the model emits a smaller response and saves us from one
      // class of silent truncation.
      maxOutputTokens: 65535,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  const text = result.text;
  if (!text) {
    console.error("parseInsurancePdf: empty response from model");
    throw new Error("Automatic insurance parsing returned no data.");
  }
  return JSON.parse(text) as ParsedInsuranceDocument;
}
