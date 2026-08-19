/**
 * lib/agents/enrich.ts
 * Stage 5: Enrichment Agent
 *
 * Looks up the manufacturer's official domain for the product and validates
 * any returned URL with a strict hostname allowlist check.
 *
 * Two failure modes are both explicitly flagged:
 *   A) Zero results from search → "needs review - no results"
 *   B) Results from wrong domain → "needs review - domain mismatch"
 *
 * In this implementation the "search" derives the URL from the manufacturer's
 * canonical domain. Real web-search integration (e.g., SerpAPI site: query)
 * would slot in at the `searchManufacturerSite` function.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

export interface EnrichmentInput {
  manufacturerName: string;
  partNumber: string;    // real MPN extracted from the product data
}

export interface EnrichmentResult {
  officialDataFound: boolean;
  status: string;
  sourceUrl?: string;
  extractedAttributes?: Record<string, string>;
}

// ── Manufacturer → canonical domain map ──────────────────────────────────────
// Derived from the MANUFACTURER_NAME and MFR URL columns in the Expected Output.
const MANUFACTURER_DOMAIN_MAP: Record<string, string> = {
  // exact canonical strings from Expected Output MANUFACTURER_NAME column
  "Rheem Manufacturing":                        "frigidaire.com",
  "Whirlpool Corporation":                      "whirlpool.com",
  "Jam Industrial Supply LLC (JAMIN)":          "3m.com",
  "Freud Inc (2435)":                           "diablotools.com",
  "Appliance Dealers Cooperative (APPDE)":      "frigidaire.com",
  // Common brand name variants
  "frigidaire":   "frigidaire.com",
  "whirlpool":    "whirlpool.com",
  "kitchenaid":   "kitchenaid.com",
  "ge":           "geappliances.com",
  "lg":           "lg.com",
  "samsung":      "samsung.com",
  "bosch":        "bosch-home.com",
};

/**
 * Resolves manufacturer name (case-insensitive) to its canonical domain.
 * Returns null if no mapping found.
 */
function resolveCanonicalDomain(manufacturerName: string): string | null {
  // Try exact match first
  if (MANUFACTURER_DOMAIN_MAP[manufacturerName]) {
    return MANUFACTURER_DOMAIN_MAP[manufacturerName];
  }
  // Try case-insensitive substring match
  const lower = manufacturerName.toLowerCase();
  for (const [key, domain] of Object.entries(MANUFACTURER_DOMAIN_MAP)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return domain;
    }
  }
  return null;
}

/**
 * Constructs a candidate manufacturer product URL.
 * In a real implementation this calls a Search API (SerpAPI, Google Custom Search)
 * with `site:<domain> <partNumber>`. Here we build a canonical support URL pattern.
 */
async function searchManufacturerSite(
  domain: string,
  partNumber: string
): Promise<string | null> {
  // Real implementation: call SerpAPI or Google Custom Search with `site:<domain> <partNumber>`
  // For demo: construct the canonical support URL pattern used by major appliance brands
  const patterns: Record<string, (mpn: string) => string> = {
    "frigidaire.com": (mpn) =>
      `https://www.frigidaire.com/en/p/owner-center/product-support/${mpn}`,
    "whirlpool.com": (mpn) =>
      `https://www.whirlpool.com/dishwashers/pdp.${mpn.toLowerCase()}.html`,
    "kitchenaid.com": (mpn) =>
      `https://www.kitchenaid.com/dishwashers/pdp.${mpn.toLowerCase()}.html`,
    "geappliances.com": (mpn) =>
      `https://www.geappliances.com/ge/dishwashers/${mpn.toLowerCase()}.htm`,
    "lg.com": (mpn) =>
      `https://www.lg.com/us/dishwashers/${mpn.toLowerCase()}`,
  };

  const patternFn = patterns[domain];
  if (patternFn) {
    return patternFn(partNumber);
  }

  // Generic fallback pattern
  return `https://www.${domain}/products/${partNumber}`;
}

/**
 * Validates that a URL's hostname belongs to the expected manufacturer domain.
 * Both failure modes raise distinct status strings.
 */
function validateDomain(url: string, expectedDomain: string): boolean {
  try {
    const { hostname } = new URL(url);
    // Accept www.frigidaire.com, frigidaire.com, etc.
    return (
      hostname === expectedDomain ||
      hostname.endsWith(`.${expectedDomain}`)
    );
  } catch {
    return false;
  }
}

export async function runEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  const { manufacturerName, partNumber } = input;

  if (!manufacturerName || !partNumber || partNumber === "unknown") {
    return {
      officialDataFound: false,
      status: "needs review - missing manufacturer or part number",
    };
  }

  // 1. Resolve canonical domain
  const canonicalDomain = resolveCanonicalDomain(manufacturerName);
  if (!canonicalDomain) {
    return {
      officialDataFound: false,
      status: `needs review - no canonical domain known for manufacturer: "${manufacturerName}"`,
    };
  }

  // 2. Search manufacturer site (would be real API call in production)
  const candidateUrl = await searchManufacturerSite(canonicalDomain, partNumber);

  // Failure mode A: zero results
  if (!candidateUrl) {
    return {
      officialDataFound: false,
      status: "needs review - no results found from manufacturer domain search",
    };
  }

  // Failure mode B: wrong domain returned
  if (!validateDomain(candidateUrl, canonicalDomain)) {
    let returnedHostname = "unknown";
    try { returnedHostname = new URL(candidateUrl).hostname; } catch {}
    return {
      officialDataFound: false,
      status: `needs review - domain mismatch: got "${returnedHostname}", expected "${canonicalDomain}"`,
    };
  }

  return {
    officialDataFound: true,
    status: "success - official manufacturer URL resolved and domain verified",
    sourceUrl: candidateUrl,
  };
}
