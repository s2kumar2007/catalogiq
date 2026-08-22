/**
 * lib/agents/extract.ts
 * Shared extraction agent logic — used by both /api/extract and /api/process-product.
 * Keeps route handlers thin and avoids route-to-route HTTP calls.
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";
import { EXTRACTION_SYSTEM_PROMPT } from "@/lib/prompts";
import type { ExtractionResult, SchemaCategory } from "@/lib/types";
import type { SchemaField } from "@/lib/agents/classify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractInput {
  rawText?: string;
  imageBase64?: string;
  /** Hint from the caller. "auto" triggers keyword detection first. */
  category: "fasteners" | "electrical_connectors" | "auto";
  /**
   * LLM-generated schema fields from classify.ts.
   * When provided, these are injected into the extraction prompt directly,
   * replacing the static schema JSON files for the resolved category.
   * This is the primary pipeline path; static JSON files are the fallback.
   */
  schemaFields?: SchemaField[];
}


// ---------------------------------------------------------------------------
// Core extraction function
// ---------------------------------------------------------------------------

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.substring(start, end + 1);
  }
  return text;
}

function fallbackExtraction(rawText?: string): ExtractionResult {
  const text = rawText ?? "";
  const fields: ExtractionResult["extracted_fields"] = {};
  const add = (key: string, value: string, source: string) => {
    const cleaned = value.trim();
    if (!cleaned) return;
    fields[key] = {
      value: cleaned,
      confidence: 80,
      source_location: source,
      extraction_method: "explicit",
    };
  };

  const lineValue = (label: string) => {
    const match = text.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
    return match?.[1]?.trim() ?? "";
  };

  add("part_number", lineValue("Part Number"), "input_part_number");
  add("description", lineValue("Description"), "input_description");
  add("brand", lineValue("Brand"), "input_brand");
  add("manufacturer", lineValue("Manufacturer"), "input_manufacturer");

  return {
    schema_match: "none",
    extracted_fields: fields,
    notes: "Fallback extraction used because Groq returned malformed or incomplete JSON.",
  };
}

/**
 * Runs the Extraction Agent for a single product input.
 * Returns a typed ExtractionResult with confidence values clamped to [0, 99].
 * Throws on LLM or parse failure — callers decide how to surface the error.
 */
export async function runExtraction(input: ExtractInput): Promise<ExtractionResult> {
  const { rawText, imageBase64, category } = input;

  if (!rawText && !imageBase64) {
    throw new Error("Provide either rawText or imageBase64.");
  }

  // ── Build user content ────────────────────────────────────────────────────
  let userContent = "";

  if (input.schemaFields && input.schemaFields.length > 0) {
    // Primary path: use LLM-generated schema fields from classify.ts.
    // These are category-specific and replace the static JSON schema files.
    const fieldList = input.schemaFields
      .map((f) => `- ${f.label}${f.unit ? ` (unit: ${f.unit})` : ""}${f.required ? " [required]" : ""}`)
      .join("\n");
    userContent +=
      `Extract ALL of the following category-specific attribute fields from the product input below.\n` +
      `Use these EXACT label names as your field keys:\n\n${fieldList}\n\n` +
      `Also extract: brand, manufacturer, part_number, and any other identifiable product identifiers.\n` +
      `Set schema_match to the product category classpath.\n\n` +
      `Product input:\n`;
  } else {
    // Fallback path: No schema fields provided (e.g., classification failed due to rate limits).
    userContent +=
      `No specific schema was matched for this input. Extract all identifiable ` +
      `product fields generically (use descriptive key names), following the same ` +
      `output format. Set schema_match to "none".\n\n` +
      `Product input:\n`;
  }

  if (rawText) {
    userContent += rawText;
  }
  if (imageBase64) {
    userContent += `\n[Image Data Provided: Base64 string length ${imageBase64.length}]`;
  }

  // ── Call Groq ─────────────────────────────────────────────────────────────
  const rawResponse = await callGroq(EXTRACTION_SYSTEM_PROMPT, userContent, undefined, undefined, 2048);

  // ── Parse ─────────────────────────────────────────────────────────────────
  let result: ExtractionResult;
  try {
    result = parseJsonResponse<ExtractionResult>(extractJson(rawResponse));
  } catch (err) {
    console.warn(`[extract] Groq JSON parse failed; using fallback extraction: ${err instanceof Error ? err.message : String(err)}`);
    result = fallbackExtraction(rawText);
  }

  // Clamp confidence values
  for (const field of Object.values(result.extracted_fields ?? {})) {
    field.confidence = Math.min(99, Math.max(0, Math.round(field.confidence)));
  }

  return result;
}
