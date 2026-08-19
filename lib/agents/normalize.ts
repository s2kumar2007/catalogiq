/**
 * lib/agents/normalize.ts
 * Stage 6: Cleansing & Normalization Agent
 */

import { NORMALIZATION_SYSTEM_PROMPT } from "@/lib/prompts";
import { ExtractedField } from "@/lib/types";

export interface NormalizationResult {
  normalized_fields: Record<string, ExtractedField>;
  normalization_notes: string;
}

// Canonical Lists from Expected Output CSV
const CANONICAL_MANUFACTURERS = [
  "Rheem Manufacturing",
  "Whirlpool Corporation",
  "Appliance Dealers Cooperative (APPDE)",
  "Jam Industrial Supply LLC (JAMIN)",
  "Freud Inc (2435)"
];

const CANONICAL_BRANDS = [
  "FRIGIDAIRE®",
  "Whirlpool®",
  "Diablo",
  "3M"
];

function fuzzyMatch(input: string, list: string[]): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const item of list) {
    const itemNormalized = item.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes(itemNormalized) || itemNormalized.includes(normalized)) {
      return item;
    }
  }
  return input; // Fallback to raw if no match
}

export async function runNormalization(
  fields: Record<string, ExtractedField>
): Promise<NormalizationResult> {
  const normalized_fields: Record<string, ExtractedField> = {};
  const notes: string[] = [];

  for (const [key, field] of Object.entries(fields)) {
    // 1. Filter Placeholders
    if (
      field.value === "-- Unbranded --" ||
      field.value === "-- No Unilog Brand --" ||
      field.value === "-- No DIB Brand --"
    ) {
      notes.push(`Dropped placeholder for ${key}`);
      continue;
    }

    let newValue = field.value;

    // 2. Fuzzy Match Manufacturer and Brand
    if (key === "Part_Manuf" || key === "MANUFACTURER_NAME") {
      newValue = fuzzyMatch(newValue, CANONICAL_MANUFACTURERS);
      if (newValue !== field.value) {
        notes.push(`Normalized Manufacturer: ${field.value} -> ${newValue}`);
      }
    }

    if (key === "E1_Brand" || key === "BRAND_NAME" || key === "Unilog_Brand" || key === "DIB_Brand") {
      newValue = fuzzyMatch(newValue, CANONICAL_BRANDS);
      if (newValue !== field.value) {
        notes.push(`Normalized Brand: ${field.value} -> ${newValue}`);
      }
    }
    
    // 3. UOM Normalization (Adding Space if needed)
    // E.g. "24in" -> "24 in"
    const uomMatch = newValue.match(/^(\d+(?:\.\d+)?|\d+-\d+\/\d+)([a-zA-Z]+)$/);
    if (uomMatch) {
      newValue = `${uomMatch[1]} ${uomMatch[2]}`;
      notes.push(`Normalized UOM: ${field.value} -> ${newValue}`);
    }

    normalized_fields[key] = {
      ...field,
      value: newValue
    };
  }
  
  return {
    normalized_fields,
    normalization_notes: notes.length > 0 ? notes.join("\n") : "All fields normalized successfully."
  };
}
