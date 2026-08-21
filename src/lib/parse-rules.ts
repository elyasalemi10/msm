import "server-only";
import { GoogleGenAI, Type } from "@google/genai";

// Custom OC Rules PDF parser (Gemini 2.5 Pro).
//
// Input: a PDF of registered owners-corporation rules. Output: a flat list of
// numbered rules, each scoped to one of the OCs the document covers, with the
// rule's heading, the parent-section heading, body text, page number, and an
// optional bounding box.
//
// Multi-OC PDFs are common: a single plan of subdivision can register rules
// for BOTH the residential apartment OC and a separate commercial OC. The old
// schema merged them into one flat list, producing duplicate rule numbers
// across OCs (e.g. two "1.1.1"s with totally different content). Each rule
// now carries an `oc_scope` so the consumer can group by OC.
//
// Parent-section heading: rules like "8.2.1 Advertising Signage" sit under a
// top-level chapter "8. Commercial Lots". The chapter heading carries
// load-bearing context (without it you can't tell 8.2.1 is a commercial-lot
// rule). `parent_heading` retains that string so it can be rendered above
// the rule in viewer.

export type ParsedRule = {
  /** Identifier of the OC this rule belongs to within the document , e.g.
   *  "OC1", "Commercial OC", "Owners Corporation 2", or the literal label the
   *  document uses ("Owners Corporation No. 2 Plan of Subdivision PS812345X").
   *  When the document only registers rules for a single OC, every entry
   *  shares the same string. */
  oc_scope: string;
  /** Optional document-stated PS number for this OC's scope, if present. */
  oc_plan_number: string | null;
  /** Top-level / chapter heading the rule sits under (e.g. "8. Commercial
   *  Lots"). Null when the rule itself IS a top-level heading. Kept for
   *  backwards compatibility; prefer `chapter_*` + `section_*` for new code. */
  parent_heading: string | null;
  /** Chapter number , the top-level container, typically a single integer
   *  ("1", "2", …). Null only when the rule is itself a chapter heading. */
  chapter_number: string | null;
  /** Chapter heading text without the number (e.g. "Health Safety and
   *  Security" for chapter "1"). */
  chapter_heading: string | null;
  /** Section number , the middle tier inside a chapter, two-level dotted
   *  ("1.1", "1.2"). Null when no explicit section exists in the source. */
  section_number: string | null;
  /** Section heading text without the number (e.g. "General" for "1.1"). */
  section_heading: string | null;
  rule_number: string;
  heading: string | null;
  body: string;
  page_number: number | null;
};

export type ParsedRulesDocument = {
  /** Did Gemini decide this is a real OC-rules PDF? */
  is_oc_rules: boolean;
  /** Free-text guess of what the upload actually is. */
  document_type_guess: string;
  /** Every OC scope encountered in the document, in source order. Lets the UI
   *  render a per-OC selector + show the rule count under each scope. */
  oc_scopes: Array<{ label: string; plan_number: string | null; rule_count: number }>;
  rules: ParsedRule[];
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    is_oc_rules: {
      type: Type.BOOLEAN,
      description:
        "True ONLY if this PDF is a registered Victorian Owners Corporation rules document. False for plan-of-subdivision PDFs, insurance certs, levy notices, photos, contracts, or anything else.",
    },
    document_type_guess: { type: Type.STRING, description: "One-line guess of the upload's actual type." },
    oc_scopes: {
      type: Type.ARRAY,
      description: "Every distinct OC that the document defines rules for, in source order. Most documents have one; mixed-use plans can register rules for two or more OCs in the same file.",
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "The literal label the document uses for this OC (e.g. 'Owners Corporation 1', 'Commercial OC', 'OC2'). Preserve verbatim." },
          plan_number: { type: Type.STRING, nullable: true, description: "Plan-of-subdivision number for this OC if stated (format PS + 6 digits + 1 letter)." },
          rule_count: { type: Type.INTEGER, description: "Number of rules under this OC scope." },
        },
        required: ["label", "rule_count"],
      },
    },
    rules: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          oc_scope: {
            type: Type.STRING,
            description:
              "Which OC this rule belongs to. MUST be one of the labels in `oc_scopes` above. Critical for documents that register rules for multiple OCs in one file , without this, two OCs' rule '1.1.1' get merged with different content.",
          },
          parent_heading: {
            type: Type.STRING,
            nullable: true,
            description:
              "DEPRECATED , prefer chapter_heading + section_heading. Kept for back-compat. The combined chapter+section heading this rule sits under (e.g. '8. Commercial Lots' for rule 8.2.1, '9. Special Rules for the Developer' for rule 9.1.10).",
          },
          chapter_number: {
            type: Type.STRING,
            nullable: true,
            description:
              "Chapter number , the top-level numbered container (e.g. '1' for rule '1.1.1', '8' for rule '8.2.1'). Null only when the rule itself IS a chapter heading. Use the literal numeral verbatim from the document, no trailing period.",
          },
          chapter_heading: {
            type: Type.STRING,
            nullable: true,
            description:
              "Chapter heading text without the leading number (e.g. 'Health Safety and Security' for chapter '1', 'Commercial Lots' for chapter '8').",
          },
          section_number: {
            type: Type.STRING,
            nullable: true,
            description:
              "Section number , middle tier inside a chapter, two-level dotted (e.g. '1.1' for rule '1.1.1', '8.2' for rule '8.2.1'). Null when the document doesn't have an explicit section header between chapter and rule.",
          },
          section_heading: {
            type: Type.STRING,
            nullable: true,
            description:
              "Section heading text without the leading number (e.g. 'General' for section '1.1', 'Advertising Signage' for section '8.2').",
          },
          rule_number: {
            type: Type.STRING,
            description:
              "Rule identifier verbatim from the document , e.g. '1', '2.3', 'A.5'. Preserve sub-numbering exactly.",
          },
          heading: {
            type: Type.STRING,
            nullable: true,
            description: "Rule's own heading (e.g. 'Noise', 'Pets', 'Advertising Signage'). Null if the rule is just numbered text.",
          },
          body: {
            type: Type.STRING,
            description: "Full rule text. Strip leading/trailing whitespace; preserve internal punctuation.",
          },
          page_number: {
            type: Type.INTEGER,
            nullable: true,
            description: "1-indexed PDF page where the rule starts.",
          },
        },
        required: ["oc_scope", "rule_number", "body"],
      },
    },
  },
  required: ["is_oc_rules", "document_type_guess", "oc_scopes", "rules"],
};
// NOTE: bbox + confidence were dropped from the rules schema in May 2026
// after benchmarking showed long rules PDFs (10+ pages, 100+ rules) blew
// past Flash's output-token ceiling and got truncated mid-JSON. The fields
// were rarely useful in practice , bbox was almost always null and
// confidence didn't change downstream behaviour. Slimmer schema ≈ 15-20%
// smaller JSON, which makes the difference between a parsed and a
// truncated response.

const SYSTEM_PROMPT = `You extract every numbered rule from a registered Victorian Owners Corporation rules PDF.

Multi-OC documents:
- A single PDF can register rules for more than one OC (typical for mixed-use plans of subdivision where the residential and commercial OCs share a document). Detect EVERY distinct OC the document covers and list them in oc_scopes.
- Every rule MUST carry an oc_scope matching one of the labels in oc_scopes. If the document only defines rules for one OC, all rules share the same scope. Do NOT merge two OCs into a single rule list.
- A typical signal of an OC boundary is a heading like "Owners Corporation 1 , Rules", "Owners Corporation No. 2", a page break followed by a section reset back to "1.1.1", or an explicit "Special Rules for OC2" header.

Hierarchy (chapter → section → rule):
- Australian OC rules documents are typically three-tiered: a CHAPTER number with a heading (bold, e.g. "1. Health Safety and Security"), inside it a SECTION number with a heading (italic / indented, e.g. "1.1. General"), and inside that the actual numbered RULES (e.g. "1.1.1. An owner or occupier...").
- For EVERY rule, populate:
    chapter_number   = the leading integer of rule_number ("1" for "1.1.1", "8" for "8.2.1"). Verbatim, no trailing period.
    chapter_heading  = the chapter's heading text without the number ("Health Safety and Security", "Commercial Lots").
    section_number   = the two-level dotted prefix ("1.1" for "1.1.1", "8.2" for "8.2.1"). Null only if the document jumps straight from chapter to rule with no middle tier.
    section_heading  = the section heading text without the number ("General", "Advertising Signage"). Null if section_number is null.
- Also set parent_heading to a combined string ("1. Health Safety and Security , 1.1 General") for backwards compatibility with older consumers.
- When a numbered entry IS itself a chapter heading (e.g. the line is just "8. Commercial Lots" with no body text), emit it with section_number=null and rule_number = chapter_number, body = chapter_heading.

Rule mechanics:
- Return every rule the document defines, in source order.
- Preserve sub-numbering verbatim (e.g. "2.3.a" stays "2.3.a", NOT "2.3.1").
- Body text should be the full text of the rule, joined into one string. Drop only the leading rule number / rule's own heading.
- Use page_number to indicate where each rule starts (1-indexed).

Document-type gate:
- BEFORE extracting anything, decide whether this PDF actually IS a set of OC rules.
- If it's something else (plan of subdivision, insurance cert, levy notice, photo, contract, blank page, garbled OCR), set is_oc_rules=false, document_type_guess to your best one-line description, oc_scopes=[], and return rules=[].
- When in doubt return false. The manager can re-upload.`;

type ServiceAccount = { project_id?: string; client_email?: string; private_key?: string };

function buildClient(): GoogleGenAI {
  const raw = process.env.GEMINI_API_KEY;
  if (!raw) {
    console.error("parseRulesPdf: GEMINI_API_KEY missing");
    throw new Error("Automatic rules parsing is temporarily unavailable.");
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let credentials: ServiceAccount;
    try {
      credentials = JSON.parse(trimmed) as ServiceAccount;
    } catch {
      throw new Error("Automatic rules parsing is temporarily unavailable.");
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

export async function parseRulesPdf(pdfBytes: Buffer): Promise<ParsedRulesDocument> {
  const ai = buildClient();
  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract every numbered rule from this Owners Corporation rules PDF." },
          { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.1,
      // Long OC-rules documents (10+ pages with 100+ numbered rules) blow
      // through the 8K-token default and Gemini truncates the JSON mid-rule.
      // 65535 is the Flash ceiling and gives enough headroom for the longest
      // rules PDFs we've benchmarked. Cost-wise this only affects bills when
      // the model actually emits that many tokens , the limit is a cap, not
      // a target.
      maxOutputTokens: 65535,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });
  const text = result.text;
  if (!text) {
    console.error("parseRulesPdf: empty response from model");
    throw new Error("Automatic rules parsing returned no data.");
  }
  return JSON.parse(text) as ParsedRulesDocument;
}
