/**
 * lib/agents/normalize.ts
 * Stage 6: Cleansing & Normalization Agent
 *
 * Normalizes extracted fields by:
 *  1. Dropping placeholder values (-- Unbranded --, etc.)
 *  2. Using Gemini to canonicalize manufacturer/brand names against
 *     the Expected Output canonical strings (LLM-based, not a hardcoded list)
 *  3. Fixing UOM spacing ("24in" → "24 in", "120V" → "120 V")
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ExtractedField } from "@/lib/types";

export interface NormalizationResult {
  normalized_fields: Record<string, ExtractedField>;
  normalization_notes: string;
}

// Placeholders to strip — from the Input CSV
const PLACEHOLDERS = new Set([
  "-- Unbranded --",
  "-- No Unilog Brand --",
  "-- No DIB Brand --",
  "",
]);

/**
 * Uses Gemini to canonicalize a manufacturer/brand name.
 * The LLM knows standard brand conventions (casing, ®, ™ symbols).
 */
async function canonicalizeName(
  rawName: string,
  fieldType: "manufacturer" | "brand"
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return rawName;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-3.6-flash",
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  });

  const prompt =
    fieldType === "manufacturer"
      ? `Return the canonical legal company name for this manufacturer. Preserve exact casing, punctuation, and abbreviations as used in official product literature. If unknown, return the input unchanged.
Input: "${rawName}"
Return JSON: { "canonical": "string" }`
      : `Return the canonical brand name with correct trademark symbols (® or ™) as the brand uses it officially in product listings. If unknown, return the input unchanged.
Input: "${rawName}"
Return JSON: { "canonical": "string" }`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return parsed.canonical ?? rawName;
  } catch {
    return rawName;
  }
}

/**
 * Fixes UOM spacing: "24in" → "24 in", "120V" → "120 V", "47dBA" → "47 dBA"
 * Works on values that are a number immediately followed by a unit string.
 */
function fixUomSpacing(value: string): string {
  // Match: optional leading digits/fractions then unit letters (no space between)
  return value.replace(
    /^(\d+(?:[-.\/]\d+)?)([A-Za-z]+)$/,
    (_m, num, unit) => `${num} ${unit}`
  );
}

export async function runNormalization(
  fields: Record<string, ExtractedField>
): Promise<NormalizationResult> {
  const normalized_fields: Record<string, ExtractedField> = {};
  const notes: string[] = [];

  for (const [key, field] of Object.entries(fields)) {
    // 1. Drop placeholders
    if (PLACEHOLDERS.has(field.value?.trim() ?? "")) {
      notes.push(`[DROP] Placeholder removed for field: ${key}`);
      continue;
    }

    let newValue = field.value;

    // 2. Canonicalize manufacturer name via LLM
    const isManufKey =
      key === "Part_Manuf" ||
      key === "MANUFACTURER_NAME" ||
      key.toLowerCase().includes("manufacturer");

    if (isManufKey && newValue) {
      const canonical = await canonicalizeName(newValue, "manufacturer");
      if (canonical !== newValue) {
        notes.push(`[MANUF] "${newValue}" → "${canonical}"`);
        newValue = canonical;
      }
    }

    // 3. Canonicalize brand name via LLM (preserves ® / ™)
    const isBrandKey =
      key === "E1_Brand" ||
      key === "BRAND_NAME" ||
      key === "Unilog_Brand" ||
      key === "DIB_Brand" ||
      key.toLowerCase().includes("brand");

    if (isBrandKey && newValue) {
      const canonical = await canonicalizeName(newValue, "brand");
      if (canonical !== newValue) {
        notes.push(`[BRAND] "${newValue}" → "${canonical}"`);
        newValue = canonical;
      }
    }

    // 4. Fix UOM spacing for numeric+unit fields
    const fixed = fixUomSpacing(newValue);
    if (fixed !== newValue) {
      notes.push(`[UOM]   "${newValue}" → "${fixed}"`);
      newValue = fixed;
    }

    normalized_fields[key] = { ...field, value: newValue };
  }

  return {
    normalized_fields,
    normalization_notes:
      notes.length > 0
        ? notes.join("\n")
        : "No normalization changes needed.",
  };
}
