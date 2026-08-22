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
 *  - Contains a parenthetical acronym like "(APPDE)", "(JAMIN)", etc.
 */
function looksLikeDistributor(name: string): boolean {
  const lower = name.toLowerCase();
  if (DISTRIBUTOR_SIGNALS.some((s) => lower.includes(s))) return true;
  // Parenthetical all-caps code: e.g. "(APPDE)", "(JAMIN)"
  if (/\([A-Z]{3,}\)/.test(name)) return true;
  return false;
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
 *  4. Fallback: whatever manufacturer-keyed field exists, even if it looks
 *     like a distributor (enrichment will fail gracefully with a clear status).
 *
 * Returns { name, sourceKey } so the caller can log which field was used.
 */
export function resolveBrandForEnrichment(
  fields: Record<string, ExtractedField>
): { name: string; sourceKey: string } | null {
  const keys = Object.keys(fields);

  // ── Priority 1: exact "brand" key ─────────────────────────────────────────
  const exactBrandKey = keys.find((k) => k.toLowerCase() === "brand");
  if (exactBrandKey) {
    const val = String(fields[exactBrandKey].value ?? "").trim();
    if (val) return { name: val, sourceKey: exactBrandKey };
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
    if (val && field.confidence >= 50) return { name: val, sourceKey: k };
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
    if (val && !looksLikeDistributor(val)) {
      return { name: val, sourceKey: k };
    }
  }

  // ── Priority 4: last resort — use whatever manufacturer key exists ─────────
  for (const k of manufKeys) {
    const val = String(fields[k].value ?? "").trim();
    if (val) return { name: val, sourceKey: k };
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
      if (val && val.toLowerCase() !== "unknown") return { mpn: val, sourceKey: k };
    }
  }

  // Heuristic: key contains "part_num" or "mpn"
  const heuristic = keys.find(
    (k) => k.toLowerCase().includes("part_num") || k.toLowerCase().includes("mpn")
  );
  if (heuristic) {
    const val = String(fields[heuristic].value ?? "").trim();
    if (val && val.toLowerCase() !== "unknown") return { mpn: val, sourceKey: heuristic };
  }

  return null;
}
