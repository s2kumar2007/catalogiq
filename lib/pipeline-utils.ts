/**
 * lib/pipeline-utils.ts
 * Shared utilities for process-product and process-batch orchestrators.
 */

import type { ExtractedField } from "@/lib/types";

// ---------------------------------------------------------------------------
// Distributor / cooperative signal words
// ---------------------------------------------------------------------------
// These indicate a "Manufacturer:" field value is actually a distributor or
// purchasing cooperative name, not the product maker. No hardcoded brand list.
const DISTRIBUTOR_SIGNALS = [
  "cooperative",
  "co-op",
  "supply",
  "dealers",
  "group",
  "wholesale",
  "distribution",
  "distributor",
  "purchasing",
  "trading",
];

/**
 * Returns true if the given name looks like a distributor / purchasing
 * cooperative rather than a product manufacturer/brand.
 *
 * Detection is signal-based (no hardcoded brand list):
 *  - Contains any of the DISTRIBUTOR_SIGNALS words (case-insensitive)
 *  - Manufacturer codes in parentheses are deliberately ignored.  Many
 *    legitimate manufacturers in the source catalog use them (for example,
 *    "Freud Inc (2435)"), so treating every code as a distributor discarded
 *    good brand evidence.
 */
function looksLikeDistributor(name: string): boolean {
  const lower = name.toLowerCase();
  if (DISTRIBUTOR_SIGNALS.some((s) => lower.includes(s))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Placeholder signal detection
// ---------------------------------------------------------------------------
// These indicate a field was populated with a generic "blank" value instead
// of a real product identifier or brand name.
const PLACEHOLDER_VALUES = new Set([
  "unbranded",
  "-- unbranded --",
  "-- no unilog brand --",
  "-- no dib brand --",
  "no brand",
  "n/a",
  "none",
  "unknown",
]);

function isPlaceholderValue(value: string): boolean {
  const normalized = value.toLowerCase().trim();
  return PLACEHOLDER_VALUES.has(normalized);
}

/**
 * Detects a brand explicitly printed in the supplier description. This is a
 * deterministic first pass, so a placeholder source-brand value can never
 * hide a plainly stated brand such as "Diablo" or "Kitchen Aid".
 */
function resolveBrandFromDescription(
  fields: Record<string, ExtractedField>
): { name: string; sourceKey: string } | null {
  const description = Object.entries(fields)
    .filter(([key]) => /part[_ ]?desc|description/i.test(key))
    .map(([, field]) => String(field.value ?? ""))
    .join(" ")
    .toLowerCase();

  const signatures: Array<[RegExp, string]> = [
    [/\bkitchen\s*aid\b/i, "KitchenAid"],
    [/\bspeed\s*queen\b|\bsq\s+(?:elect|gas|washer|dryer)/i, "Speed Queen"],
    [/\bblack\s*(?:&|and)?\s*decker\b/i, "BLACK+DECKER"],
    [/\bdewalt\b|\bdeWlt\b/i, "DEWALT"],
    [/\bmilw(?:aukee)?\b/i, "Milwaukee"],
    [/\bdiablo\b/i, "Diablo"],
    [/\bwhirlpool\b/i, "Whirlpool"],
    [/\bfrigidaire\b/i, "Frigidaire"],
    [/\bge\s+(?:dishwasher|gas|elect|washer|dryer)/i, "GE Appliances"],
    [/\blg\s+(?:dishwasher|laundry|washer|dryer)/i, "LG"],
    [/\b3m\b/i, "3M"],
    [/\bmirka\b/i, "Mirka"],
    [/\bmakita\b/i, "Makita"],
    [/\bfestool\b/i, "Festool"],
    [/\bbosch\b/i, "Bosch"],
    [/\bkreg\b/i, "Kreg"],
    [/\bleviton\b/i, "Leviton"],
    [/\bsouthwire\b/i, "Southwire"],
    [/\bfeit\b/i, "Feit Electric"],
    [/\bhunter\b/i, "Hunter"],
    [/\bvelux\b/i, "VELUX"],
  ];

  for (const [pattern, name] of signatures) {
    if (pattern.test(description)) return { name, sourceKey: "Part_Desc" };
  }
  return null;
}

/**
 * Resolves the best manufacturer/brand name to use for enrichment (Gemini
 * search grounding).
 *
 * Priority order (highest → lowest):
 *  1. Any field whose key is exactly "brand" — this is what the extraction
 *     agent emits when it finds the brand token inside the description text,
 *     and it always has higher confidence than the labelled Manufacturer: line.
 *  2. Any other brand-keyed field (e.g. "E1_Brand", "BRAND_NAME", or any key
 *     containing "brand"), provided confidence ≥ 50.
 *  3. A manufacturer-keyed field (keys containing "manuf") — ONLY if the
 *     value does NOT look like a distributor/cooperative name.
 *
 * Returns { name, sourceKey } so the caller can log which field was used.
 */
export function resolveBrandForEnrichment(
  fields: Record<string, ExtractedField>
): { name: string; sourceKey: string } | null {
  const keys = Object.keys(fields);

  // The description is more trustworthy than a source column explicitly
  // saying "-- Unbranded --". Check it before falling back to manufacturer.
  const descriptionBrand = resolveBrandFromDescription(fields);
  if (descriptionBrand) return descriptionBrand;

  // ── Priority 1: exact "brand" key ─────────────────────────────────────────
  const exactBrandKey = keys.find((k) => k.toLowerCase() === "brand");
  if (exactBrandKey) {
    const val = String(fields[exactBrandKey].value ?? "").trim();
    if (val && !isPlaceholderValue(val)) return { name: val, sourceKey: exactBrandKey };
  }

  // ── Priority 2: any brand-ish key with confidence ≥ 50 ───────────────────
  const brandCandidates = keys.filter(
    (k) =>
      k !== exactBrandKey &&
      (k === "E1_Brand" ||
        k === "BRAND_NAME" ||
        k === "Unilog_Brand" ||
        k === "DIB_Brand" ||
        k.toLowerCase().includes("brand"))
  );
  for (const k of brandCandidates) {
    const field = fields[k];
    const val = String(field.value ?? "").trim();
    if (val && !isPlaceholderValue(val) && field.confidence >= 50) return { name: val, sourceKey: k };
  }

  // ── Priority 3: manufacturer key — but only if it's not a distributor ─────
  const manufKeys = keys.filter(
    (k) =>
      k === "MANUFACTURER_NAME" ||
      k === "Part_Manuf" ||
      k.toLowerCase().includes("manuf")
  );
  for (const k of manufKeys) {
    const val = String(fields[k].value ?? "").trim();
    if (val && !isPlaceholderValue(val) && !looksLikeDistributor(val)) {
      return { name: val.replace(/\s*\([^)]*\)\s*$/, "").trim(), sourceKey: k };
    }
  }

  return null;
}

/**
 * Resolves the best MPN (manufacturer part number) from extracted fields.
 * Tries exact known keys first, then key-name heuristics.
 */
export function resolveMpnForEnrichment(
  fields: Record<string, ExtractedField>
): { mpn: string; sourceKey: string } | null {
  const keys = Object.keys(fields);

  const EXACT = ["MANUFACTURER_PART_NUMBER", "Mfg_Part_Num", "mfg_part_num", "part_number"];
  for (const k of EXACT) {
    if (keys.includes(k)) {
      const val = String(fields[k].value ?? "").trim();
      if (val && !isPlaceholderValue(val)) return { mpn: val, sourceKey: k };
    }
  }

  // Heuristic: key contains "part_num" or "mpn"
  const heuristic = keys.find(
    (k) => k.toLowerCase().includes("part_num") || k.toLowerCase().includes("mpn")
  );
  if (heuristic) {
    const val = String(fields[heuristic].value ?? "").trim();
    if (val && !isPlaceholderValue(val)) return { mpn: val, sourceKey: heuristic };
  }

  return null;
}
