import "server-only";
import { GoogleGenAI, Type } from "@google/genai";

// Plan-of-Subdivision parser. Gemini 2.5 Flash vision over the raw PDF with
// a structured response schema, so the result is always the same shape and
// we never have to parse free-text. Confidence is per-field so the UI can
// tint low-confidence cells amber and prompt the user to verify.

export type ParsedLot = {
  lot_number: number;
  /** Apartment / unit label distinct from the lot number, e.g. "3B" or "204". */
  unit_number: string | null;
  unit_entitlement: number;
  lot_liability: number;
  confidence: number;
};

export type ParsedOC = {
  oc_number: number;
  oc_name: string | null;
  address: string | null;
  street_number: string | null;
  street_name: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  /** Optional descriptive name of the building / development (from cover sheet). */
  building_name: string | null;
  /** Number of storeys / levels if shown on the plan. */
  storeys: number | null;
  /** Total site area in sqm if stated. */
  site_area_sqm: number | null;
  /** What kind of property the plan covers (apartments, townhouses, mixed, services-only…). */
  property_type: string | null;
  /** Year the plan was registered (or surveyed). */
  registered_year: number | null;
  /** Description of the common property as written on the plan. */
  common_property_description: string | null;
  lot_count: number;
  lots: ParsedLot[];
};

export type ParsedPlan = {
  /** True only when the model is confident this PDF really is a Victorian
   *  Plan-of-Subdivision. When false, all other fields are null. */
  is_plan_of_subdivision: boolean;
  document_type_guess: string;        // e.g. "Plan of Subdivision", "Bank statement", "Insurance policy"…
  plan_of_subdivision_number: string | null;
  plan_of_subdivision_confidence: number;
  detected_ocs: ParsedOC[];
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_plan_of_subdivision: { type: Type.BOOLEAN, description: "True ONLY if this PDF really is a registered Victorian Plan-of-Subdivision. Set false for ANY other document (bank statement, insurance policy, image, contract, blank page, OCR-garbled file, etc.)." },
    document_type_guess: { type: Type.STRING, description: "Best one-line guess of what this PDF actually is, e.g. 'Plan of Subdivision', 'Section 32 statement', 'Bank statement', 'Insurance policy', 'Unknown'." },
    plan_of_subdivision_number: { type: Type.STRING, nullable: true, description: "Plan-of-Subdivision identifier, e.g. PS812345X. Null if not visible or not a plan." },
    plan_of_subdivision_confidence: { type: Type.NUMBER, description: "0-1 confidence in the extracted plan number. 0 when is_plan_of_subdivision is false." },
    detected_ocs: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          oc_number: { type: Type.INTEGER, description: "OC ordinal in the plan (1 for OC1, 2 for OC2, etc.). Use 1 if only one OC." },
          oc_name: { type: Type.STRING, nullable: true },
          address: { type: Type.STRING, nullable: true, description: "Full address as written on the plan." },
          street_number: { type: Type.STRING, nullable: true },
          street_name: { type: Type.STRING, nullable: true },
          suburb: { type: Type.STRING, nullable: true },
          state: { type: Type.STRING, nullable: true, description: "AU state code, e.g. VIC." },
          postcode: { type: Type.STRING, nullable: true, description: "4-digit AU postcode." },
          building_name: { type: Type.STRING, nullable: true, description: "Friendly name of the building or development, e.g. 'Riverside Apartments'. Null when not stated." },
          storeys: { type: Type.INTEGER, nullable: true, description: "Number of storeys / levels if shown on the plan, otherwise null." },
          site_area_sqm: { type: Type.NUMBER, nullable: true, description: "Total site area in square metres if stated. Convert hectares to sqm. Null if absent." },
          property_type: { type: Type.STRING, nullable: true, description: "One of: 'apartments', 'townhouses', 'mixed', 'commercial', 'services_only', 'other'. Null when unclear." },
          registered_year: { type: Type.INTEGER, nullable: true, description: "Year the plan was registered or surveyed. Null when not stated." },
          common_property_description: { type: Type.STRING, nullable: true, description: "Description of the common property as written on the plan (driveways, lifts, gardens, etc.). Null when absent." },
          lot_count: { type: Type.INTEGER },
          lots: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                lot_number: { type: Type.INTEGER, description: "Lot number on the plan (the legal 'Lot N' identifier)." },
                unit_number: { type: Type.STRING, nullable: true, description: "Apartment/unit label distinct from the lot number, e.g. '3B' or 'Unit 204'. Null if the plan only shows lot numbers." },
                unit_entitlement: { type: Type.NUMBER },
                lot_liability: { type: Type.NUMBER },
                confidence: { type: Type.NUMBER, description: "0-1 confidence in this row's values." },
              },
              required: ["lot_number", "unit_entitlement", "lot_liability", "confidence"],
            },
          },
        },
        required: ["oc_number", "lot_count", "lots"],
      },
    },
  },
  required: ["is_plan_of_subdivision", "document_type_guess", "plan_of_subdivision_confidence", "detected_ocs"],
};

const SYSTEM_PROMPT = `You extract structured data from Victorian Plan-of-Subdivision PDFs.

A Plan of Subdivision (PS) is a registered survey document under the Subdivision Act 1988 (Vic). It can create one or more Owners Corporations (OCs); each OC has its own lot schedule with per-lot Unit Entitlement and Lot Liability (typically integers summing to 100 or 1000, sometimes equal per lot).

CRITICAL , document-type gate:
- BEFORE extracting anything, decide whether this PDF really IS a Victorian Plan-of-Subdivision.
- A real Plan-of-Subdivision has: a PS identifier (e.g. "PS812345X"), registered-survey diagrams, and an Owners-Corporation lot-entitlement/lot-liability schedule.
- If the document is anything else (a bank statement, insurance policy, contract, photo, blank page, random text, image of a building, conveyancer Section 32, OCR-garbled file, etc.), set is_plan_of_subdivision=false, document_type_guess to your best one-line description, leave plan_of_subdivision_number=null, plan_of_subdivision_confidence=0, and return detected_ocs=[]. DO NOT invent fields.
- When in doubt, return false. We'd rather the user re-upload than ingest a hallucinated lot schedule.

When the document IS a plan:
- Return ALL OCs found on the plan, not just the largest one.
- Lot numbers, unit entitlement, and lot liability come from the lot schedule table (often titled "Schedule of Lot Entitlement and Liability" or similar).
- If the plan creates only one OC, set oc_number=1.
- If a field is illegible or not present, return null and confidence below 0.5.
- Confidence reflects how clearly the value is rendered, not how plausible it is.
- Do NOT invent lot numbers. Do NOT extrapolate from the lot count. Only report lots actually present in the schedule.
- Address: include the full registered address. State for VIC plans is "VIC".`;

type ServiceAccount = {
  type?: string;
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

// Initialise the client. GEMINI_API_KEY holds EITHER a Google AI Studio
// API key string (starts with "AIza...") OR a full service-account JSON
// (starts with "{" , Vertex AI mode). Service-account is the production
// path: paid tier, regional pinning, no training on inputs.
function buildClient(): GoogleGenAI {
  const raw = process.env.GEMINI_API_KEY;
  if (!raw) {
    console.error("parsePlanPdf: GEMINI_API_KEY is not set");
    throw new Error("Automatic plan parsing is temporarily unavailable.");
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    // Service-account JSON → Vertex AI mode.
    let credentials: ServiceAccount;
    try {
      credentials = JSON.parse(trimmed) as ServiceAccount;
    } catch {
      console.error("parsePlanPdf: GEMINI_API_KEY does not parse as JSON");
      throw new Error("Automatic plan parsing is temporarily unavailable.");
    }
    if (!credentials.project_id) {
      console.error("parsePlanPdf: service-account JSON missing project_id");
      throw new Error("Automatic plan parsing is temporarily unavailable.");
    }
    // Vertex AI default location for Gemini is `global` , it routes the
    // request to the closest region that hosts the model. gemini-2.5-flash
    // is NOT yet in australia-southeast1, so a Sydney pin returns 404. The
    // `global` endpoint still respects GCP's data-residency commitments for
    // Australian customers , your data isn't trained on, regardless of
    return new GoogleGenAI({
      vertexai: true,
      project: credentials.project_id,
      location: "global",
      googleAuthOptions: { credentials },
    });
  }
  // Bare key → AI Studio mode (use a billed key in production).
  return new GoogleGenAI({ apiKey: trimmed });
}

export async function parsePlanPdf(pdfBytes: Buffer): Promise<ParsedPlan> {
  const ai = buildClient();

  // Gemini 2.5 Flash: ~3-5x faster than Pro, ~4x cheaper (input $0.30 vs
  // $1.25 / 1M tokens, output $2.50 vs $10), and easily competent on
  // structured field extraction with a constrained response schema. Switch
  // back to Pro only if regression testing on real plans shows field-level
  // accuracy drops.
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract the Plan-of-Subdivision details and full lot schedule from this PDF." },
          { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.1,
      // Large plans with 100+ lots can produce big JSON outputs. 65535
      // matches the Flash ceiling; defensive against truncation on long
      // lot schedules.
      maxOutputTokens: 65535,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = result.text;
  if (!text) {
    console.error("parsePlanPdf: empty response from model");
    throw new Error("Automatic plan parsing returned no data.");
  }
  const parsed = JSON.parse(text) as ParsedPlan;
  return parsed;
}
