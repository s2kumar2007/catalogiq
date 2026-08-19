/**
 * lib/agents/normalize.ts
 * Stage 6: Cleansing & Normalization Agent
 * 
 * Responsible for standardizing units, fractions/decimals, manufacturer/brands,
 * and filtering placeholders BEFORE description formatting.
 * CURRENTLY BLOCKED: Waiting for UOM and Decimal_Fraction datasets.
 */

import { NORMALIZATION_SYSTEM_PROMPT } from "@/lib/prompts";
import { ExtractedField } from "@/lib/types";

export interface NormalizationResult {
  normalized_fields: Record<string, ExtractedField>;
  normalization_notes: string;
}

export async function runNormalization(
  fields: Record<string, ExtractedField>
): Promise<NormalizationResult> {
  // TODO: Load UOM and Decimal_Fraction datasets
  // TODO: Load UniCat Manufacturer and Brand list
  // TODO: Apply rules or use Gemini via NORMALIZATION_SYSTEM_PROMPT
  
  throw new Error("Normalization Agent is blocked pending dataset uploads.");
}
