/**
 * lib/agents/format.ts
 * Stage 7: Description Building (Formatting) Agent
 * 
 * Generates delivery formats (mobile desc, long desc, attributes, etc.)
 * from normalized product data. MUST run after Stage 6 (Normalization).
 */

import { FORMATTING_SYSTEM_PROMPT } from "@/lib/prompts";
import { DeliveryFormats, ExtractedField } from "@/lib/types";

export interface FormattingResult {
  delivery_formats: DeliveryFormats;
}

export async function runFormatting(
  normalizedFields: Record<string, ExtractedField>
): Promise<FormattingResult> {
  // TODO: Call Gemini using FORMATTING_SYSTEM_PROMPT and normalizedFields
  // TODO: Validate character limits and exact attribute names
  // TODO: Return populated DeliveryFormats

  throw new Error("Formatting Agent is waiting for Normalization (Stage 6) to be implemented.");
}
