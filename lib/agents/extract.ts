/**
 * lib/agents/extract.ts
 * Shared extraction agent logic — used by both /api/extract and /api/process-product.
 * Keeps route handlers thin and avoids route-to-route HTTP calls.
 */

import { callGemini, parseJsonResponse, GeminiContentPart } from "@/lib/gemini";
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

  // ── Build user parts ──────────────────────────────────────────────────────
  const userParts: GeminiContentPart[] = [];

  if (input.schemaFields && input.schemaFields.length > 0) {
    // Primary path: use LLM-generated schema fields from classify.ts.
    // These are category-specific and replace the static JSON schema files.
    const fieldList = input.schemaFields
      .map((f) => `- ${f.label}${f.unit ? ` (unit: ${f.unit})` : ""}${f.required ? " [required]" : ""}`)
      .join("\n");
    userParts.push({
      type: "text",
      data:
        `Extract ALL of the following category-specific attribute fields from the product input below.\n` +
        `Use these EXACT label names as your field keys:\n\n${fieldList}\n\n` +
        `Also extract: brand, manufacturer, part_number, and any other identifiable product identifiers.\n` +
        `Set schema_match to the product category classpath.\n\n` +
        `Product input:`,
    });
  } else {
    // Fallback path: No schema fields provided (e.g., classification failed due to rate limits).
    userParts.push({
      type: "text",
      data:
        `No specific schema was matched for this input. Extract all identifiable ` +
        `product fields generically (use descriptive key names), following the same ` +
        `output format. Set schema_match to "none".\n\n` +
        `Product input:`,
    });
  }

  if (rawText)     userParts.push({ type: "text",  data: rawText });
  if (imageBase64) userParts.push({ type: "image", data: imageBase64 });

  // ── Call Gemini ───────────────────────────────────────────────────────────
  const rawResponse = await callGemini(EXTRACTION_SYSTEM_PROMPT, userParts);

  // ── Parse ─────────────────────────────────────────────────────────────────
  const result = parseJsonResponse<ExtractionResult>(rawResponse);

  // Clamp confidence values
  for (const field of Object.values(result.extracted_fields ?? {})) {
    field.confidence = Math.min(99, Math.max(0, Math.round(field.confidence)));
  }

  return result;
}
