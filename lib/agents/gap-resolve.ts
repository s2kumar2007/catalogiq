/**
 * lib/agents/gap-resolve.ts
 * Shared gap-resolution agent logic — used by /api/gap-resolve and the orchestrator.
 *
 * Identifies missing required fields, low-confidence fields, and validation
 * errors, then calls Gemini to either fill them confidently or generate
 * specific supplier asks.
 */

import { callGemini, parseJsonResponse } from "@/lib/gemini";
import { GAP_RESOLUTION_SYSTEM_PROMPT } from "@/lib/prompts";
import type {
  ExtractedField,
  ValidationResult,
  GapAsk,
  SchemaCategory,
} from "@/lib/types";
import type { SchemaField } from "@/lib/agents/classify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single confident fill produced by the gap-resolution agent. */
export interface ConfidentFill {
  value: string | number;
  confidence: number;
  reasoning: string;
  extraction_method: "inferred";
}

/** Email draft bundling all gap asks for a product. */
export interface SupplierRequestDraft {
  subject: string;
  body: string;
}

/** Full output of the Gap-Resolution Agent. */
export interface GapResolutionResult {
  confident_fills: Record<string, ConfidentFill>;
  gap_asks: GapAsk[];
  supplier_request_draft: SupplierRequestDraft | null;
  summary: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Runs the Gap-Resolution Agent against extracted fields and validation output.
 *
 * @param extractedFields  The current extracted fields for this product.
 * @param validationResult The validation output (may be null if validation was skipped).
 * @param category         The resolved schema category.
 * @returns                GapResolutionResult — fills, asks, and supplier draft.
 * @throws                 On Gemini failure or JSON parse failure.
 */
export async function runGapResolution(
  extractedFields: Record<string, ExtractedField>,
  validationResult: ValidationResult | null,
  category: Exclude<SchemaCategory, "none">,
  llmSchemaFields?: SchemaField[]
): Promise<GapResolutionResult> {
  // ── Build schema string ───────────────────────────────────────────────────
  let schemaString = "No specific schema provided.";
  if (llmSchemaFields && llmSchemaFields.length > 0) {
    schemaString = llmSchemaFields
      .map((f) => `- ${f.key} (${f.label})${f.required ? " [required]" : ""}`)
      .join("\n");
  }

  // ── Build user content ────────────────────────────────────────────────────
  const userContent =
    `Category schema:\n${schemaString}\n\n` +
    `Extracted fields:\n${JSON.stringify(extractedFields, null, 2)}\n\n` +
    `Validation result:\n${JSON.stringify(validationResult, null, 2)}`;

  // ── Call Gemini ───────────────────────────────────────────────────────────
  const rawResponse = await callGemini(GAP_RESOLUTION_SYSTEM_PROMPT, userContent);

  // ── Parse ─────────────────────────────────────────────────────────────────
  const result = parseJsonResponse<GapResolutionResult>(rawResponse);

  // ── Normalise ─────────────────────────────────────────────────────────────
  // Clamp confidence on fills to [0, 85] (agent should already cap, but be safe)
  for (const fill of Object.values(result.confident_fills ?? {})) {
    fill.confidence = Math.min(85, Math.max(0, Math.round(fill.confidence)));
  }

  // Ensure arrays exist
  if (!Array.isArray(result.gap_asks)) {
    result.gap_asks = [];
  }

  // If no asks, supplier draft should be null
  if (result.gap_asks.length === 0) {
    result.supplier_request_draft = null;
  }

  return result;
}
