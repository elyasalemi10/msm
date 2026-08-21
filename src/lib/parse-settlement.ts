import "server-only";
import { GoogleGenAI, Type } from "@google/genai";

// Section 32 / Notice of Acquisition settlement parser (Gemini 2.5 Flash).
//
// Triggered from the /lots Tools dropdown → Record settlement flow. The
// manager uploads a settlement-pack PDF and we extract the fields the
// review form needs: incoming transferee details, settlement date, sale
// price, contract date, conveyancer, plus any joint transferees.
//
// Output shape matches SettlementReview.parsed in src/lib/actions/settlements.ts
// so the two slot together without a translation layer.

export type ParsedSettlement = {
  /** Did Gemini decide this PDF is actually a settlement / Notice of
   *  Acquisition document? Set false for misfiles (insurance certs, OC
   *  rules, blank pages, contracts that are not for this lot, etc.) , the
   *  caller surfaces a "couldn't read this" toast and the manager
   *  falls back to manual entry. */
  is_settlement_document: boolean;
  document_type_guess: string;
  lot_number: number | null;
  plan_number: string | null;
  transferee: {
    name: string | null;
    email: string | null;
    phone: string | null;
    postal_address: string | null;
    // Date of birth was removed (2026-05). We intentionally do NOT
    // extract or store it , it's not required for strata correspondence
    // and minimises the PII footprint. Kept here as `null` for
    // downstream consumers that haven't migrated yet.
    date_of_birth: null;
  };
  settlement_date: string | null; // ISO yyyy-mm-dd
  sale_price_cents: number | null;
  contract_date: string | null;   // ISO yyyy-mm-dd
  conveyancer: {
    name: string | null;
    email: string | null;
  };
  additional_transferees: Array<{ name: string | null }>;
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_settlement_document: {
      type: Type.BOOLEAN,
      description:
        "True ONLY if this PDF is a property settlement / conveyancing / Notice of Acquisition document for a single lot. False for insurance certs, OC rules, levy notices, plans of subdivision, photos, blank pages, or anything else.",
    },
    document_type_guess: { type: Type.STRING, description: "One-line guess of the upload's actual type." },
    lot_number: {
      type: Type.NUMBER,
      nullable: true,
      description: "Lot number being transferred (integer from the title / plan). Null if not present.",
    },
    plan_number: {
      type: Type.STRING,
      nullable: true,
      description: "Plan-of-Subdivision number (format PS + 6 digits + 1 letter, e.g. 'PS812345X'). Null if not found.",
    },
    transferee: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, nullable: true, description: "Full legal name of the incoming owner. Use the first transferee if multiple are listed; emit the rest in additional_transferees." },
        email: { type: Type.STRING, nullable: true, description: "Email address of the incoming owner, if shown anywhere on the form. Null if not present." },
        phone: { type: Type.STRING, nullable: true, description: "Phone number of the incoming owner in +61 international format with no leading 0. Null if not present." },
        postal_address: { type: Type.STRING, nullable: true, description: "Postal / service address for the new owner (often different from the lot itself when the owner is non-resident). Null if not present." },
      },
      required: ["name", "email", "phone", "postal_address"],
    },
    settlement_date: {
      type: Type.STRING,
      nullable: true,
      description: "ISO yyyy-mm-dd. The day legal title transferred (settlement date), not the contract date. Australian forms use DD/MM/YYYY , convert carefully.",
    },
    sale_price_cents: {
      type: Type.NUMBER,
      nullable: true,
      description: "Sale price in AUD CENTS (so $850,000 → 85000000). Strip currency symbols and commas. Null if not present.",
    },
    contract_date: {
      type: Type.STRING,
      nullable: true,
      description: "ISO yyyy-mm-dd. Date the contract of sale was signed. Null if not present.",
    },
    conveyancer: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, nullable: true, description: "Conveyancer / solicitor / settlement agent name. Null if not present." },
        email: { type: Type.STRING, nullable: true, description: "Conveyancer email. Null if not present." },
      },
      required: ["name", "email"],
    },
    additional_transferees: {
      type: Type.ARRAY,
      description: "Joint owners beyond the primary transferee (e.g. spouses on title together). Empty array if none.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, nullable: true },
        },
        required: ["name"],
      },
    },
  },
  required: [
    "is_settlement_document",
    "document_type_guess",
    "lot_number",
    "plan_number",
    "transferee",
    "settlement_date",
    "sale_price_cents",
    "contract_date",
    "conveyancer",
    "additional_transferees",
  ],
};

const SYSTEM_PROMPT = `You extract structured fields from a Victorian / Australian property settlement document (Section 32 statement, Notice of Acquisition, Transfer of Land, or conveyancer's settlement statement).

Field-by-field rules:
- transferee = INCOMING owner (the buyer). NOT the seller / transferor.
- Names: STRIP any honorific / title prefix , "Mr", "Mrs", "Ms", "Miss", "Dr", "Prof", etc. We do NOT store gender or titles. "MR MARK JACKSON" → "Mark Jackson".
- Names: return in natural Title Case, NOT the document's ALL-CAPS. "MARK JACKSON" → "Mark Jackson", "MARY-ANNE O'BRIEN" → "Mary-Anne O'Brien". Preserve internal capitals in names like "McDonald" / "O'Brien".
- Multiple transferees on title: emit the first one as transferee.name; put the rest as objects in additional_transferees (same title-strip + Title-Case rules apply).
- settlement_date = day legal title transferred. This is usually labelled "Settlement Date", "Date of Settlement" or stamped/dated near the signatures , NOT the contract date.
- sale_price_cents is INTEGER CENTS. $850,000 → 85000000. $1.2M → 120000000. Null if absent.
- Dates: ISO yyyy-mm-dd. AU forms use DD/MM/YYYY; convert. If only a partial date is visible (e.g. month + year), return null rather than guess.
- lot_number and plan_number come from the title reference ("Lot 7 on PS812345X" → lot_number 7, plan_number "PS812345X"). Plan-of-Subdivision format: PS + 6 digits + 1 letter, upper-case.
- phone: return the incoming owner's Australian phone in international format starting with "+61" and NO leading 0 (e.g. "0412 345 678" → "+61412345678", "(03) 9876 5432" → "+61398765432"). Null if not present.
- postal_address is the new owner's CORRESPONDENCE address (often outside the building when they're a non-resident landlord). It may differ from the lot's address.
- conveyancer: the settlement agent acting for the BUYER. Name + email only. Null fields if you can't see them.

Document-type gate:
- BEFORE extracting fields, decide whether this PDF is actually a settlement / conveyancing document.
- Insurance certs, levy notices, plans of subdivision, OC rules, photos, blank pages → is_settlement_document=false, document_type_guess to a one-line description, every other field null / empty.
- When in doubt return false; the manager can fall back to manual entry.

Never invent data. If a field isn't visible, return null (or "" for fields the schema requires as required-strings , but our schema makes the human-fact fields nullable, so always prefer null over a guess).`;

type ServiceAccount = { project_id?: string; client_email?: string; private_key?: string };

function buildClient(): GoogleGenAI {
  const raw = process.env.GEMINI_API_KEY;
  if (!raw) {
    console.error("parseSettlementPdf: GEMINI_API_KEY missing");
    throw new Error("Automatic settlement parsing is temporarily unavailable.");
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let credentials: ServiceAccount;
    try {
      credentials = JSON.parse(trimmed) as ServiceAccount;
    } catch {
      throw new Error("Automatic settlement parsing is temporarily unavailable.");
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

export async function parseSettlementPdf(pdfBytes: Buffer): Promise<ParsedSettlement> {
  const ai = buildClient();
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract structured settlement fields from this property settlement document." },
          { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.1,
      maxOutputTokens: 65535,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  const text = result.text;
  if (!text) {
    console.error("parseSettlementPdf: empty response from model");
    throw new Error("Automatic settlement parsing returned no data.");
  }
  const parsed = JSON.parse(text) as Omit<ParsedSettlement, "transferee"> & {
    transferee: Omit<ParsedSettlement["transferee"], "date_of_birth"> & {
      date_of_birth?: null;
    };
  };
  // Pin date_of_birth to null regardless of what comes back , the schema
  // no longer asks for it, but defending against schema drift keeps
  // downstream consumers from seeing `undefined`.
  return {
    ...parsed,
    transferee: { ...parsed.transferee, date_of_birth: null },
  };
}
