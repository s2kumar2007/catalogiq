/**
 * lib/agents/validate.ts
 * Shared validation agent logic — used by both /api/validate and /api/process-product.
 * Keeps route handlers thin and avoids route-to-route HTTP calls.
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";
import { VALIDATION_SYSTEM_PROMPT } from "@/lib/prompts";
import { loadSchemaJson } from "@/lib/agents/extract";
import type { ExtractedField, ValidationResult, ValidationFlag } from "@/lib/types";

// ---------------------------------------------------------------------------
// Extended types (exported so the orchestrator and route can share them)
// ---------------------------------------------------------------------------

export interface ValidationFlagExtended extends ValidationFlag {
  rule_type: "schema_rule" | "cross_field_rule" | "inferred_check";
  current_value: string | null;
}

export interface ValidationResultExtended extends ValidationResult {
  flags: ValidationFlagExtended[];
  /** Plain-language summary of overall data quality from the agent. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Core validation function
// ---------------------------------------------------------------------------

/**
 * Runs the Validation Agent against already-extracted fields and the
 * schema for a known category.
 *
 * @param extractedFields  Output of runExtraction().extracted_fields
 * @param category         Resolved category — must NOT be "none" or "auto"
 * @returns                ValidationResultExtended with normalised overall_status
 * @throws                 On Groq failure or JSON parse failure
 */
export async function runValidation(
  extractedFields: Record<string, ExtractedField>,
  category: "fasteners" | "electrical_connectors"
): Promise<ValidationResultExtended> {
  // ── Load and parse schema to trim it ─────────────────────────────────────
  const schemaRaw = loadSchemaJson(category);
  let parsedSchema: any;
  try {
    parsedSchema = JSON.parse(schemaRaw);
  } catch {
    parsedSchema = null;
  }

  let trimmedSchema: any = null;
  if (parsedSchema) {
    const fieldsToKeep = parsedSchema.fields?.filter((f: any) => 
      Object.prototype.hasOwnProperty.call(extractedFields, f.key)
    ).map((f: any) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      unit: f.unit,
      required: f.required,
      validation: f.validation,
    })) ?? [];

    trimmedSchema = {
      category: parsedSchema.category,
      fields: fieldsToKeep,
      crossFieldRules: parsedSchema.crossFieldRules ?? [],
    };
  }

  // ── Trim extracted fields payload (drop source_location) ─────────────────
  const trimmedExtractedFields = Object.entries(extractedFields).reduce(
    (acc, [key, f]) => {
      acc[key] = {
        value: f.value,
        confidence: f.confidence,
        extraction_method: f.extraction_method,
      } as any;
      return acc;
    },
    {} as Record<string, any>
  );

  // ── Build Groq user message ───────────────────────────────────────────────
  const userContent =
    `Category schema:\n${JSON.stringify(trimmedSchema || schemaRaw, null, 2)}\n\n` +
    `Extracted fields to validate:\n${JSON.stringify(trimmedExtractedFields, null, 2)}`;

  // ── Token estimate check ──────────────────────────────────────────────────
  const totalLength = VALIDATION_SYSTEM_PROMPT.length + userContent.length;
  if (totalLength > 4000) {
    console.warn(
      `[validation-agent] WARNING: Combined prompt length (${totalLength} chars) exceeds 4000 characters limit warning threshold.`
    );
  }

  // ── Call Groq ─────────────────────────────────────────────────────────────
  const rawResponse = await callGroq(VALIDATION_SYSTEM_PROMPT, userContent);


  // ── Parse ─────────────────────────────────────────────────────────────────
  const result = parseJsonResponse<ValidationResultExtended>(rawResponse);

  // ── Normalise overall_status ──────────────────────────────────────────────
  const flags      = result.flags ?? [];
  const hasError   = flags.some((f) => f.severity === "error");
  const hasWarning = flags.some(
    (f) => f.severity === "warning" || f.severity === "missing"
  );

  const derivedStatus = hasError ? "invalid" : hasWarning ? "flagged" : "valid";

  const validStatuses = ["valid", "flagged", "invalid"];
  const finalStatus = validStatuses.includes(result.overall_status)
    ? result.overall_status
    : derivedStatus;

  return { ...result, overall_status: finalStatus, flags };
}
