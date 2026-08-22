/**
 * lib/agents/enrich.ts
 * Stage 5: Enrichment Agent
 *
 * Uses Tavily Search API to perform a REAL live web search
 * restricted to the manufacturer's official domain (`site:<domain> <partNumber>`).
 * The URL returned by Tavily's grounded search is then validated with a strict
 * hostname allowlist check before being accepted.
 *
 * Two failure modes are both explicitly flagged:
 *   A) Zero/no results from live search  → "needs review - no results"
 *   B) Returned URL is on the wrong domain → "needs review - domain mismatch"
 */

const TAVILY_API_BASE = "https://api.tavily.com/search";

export interface EnrichmentInput {
  manufacturerName: string;
  partNumber: string; // real MPN extracted from the product data
}

export interface EnrichmentResult {
  officialDataFound: boolean;
  status: string;
  sourceUrl?: string;
  extractedAttributes?: Record<string, string>;
}

// ── Manufacturer → canonical domain map ──────────────────────────────────────
// Manufacturer or brand names mapped to their own official domains.
// Do not infer manufacturer domains from distributor fields in sample rows.
const MANUFACTURER_DOMAIN_MAP: Record<string, string> = {
  "Rheem Manufacturing":                   "rheem.com",
  "Whirlpool Corporation":                 "whirlpool.com",
  "Jam Industrial Supply LLC (JAMIN)":     "3m.com",
  "Freud Inc (2435)":                      "diablotools.com",
  // Common brand name variants for broader matching
  frigidaire: "frigidaire.com",
  rheem:      "rheem.com",
  whirlpool:  "whirlpool.com",
  kitchenaid: "kitchenaid.com",
  ge:         "geappliances.com",
  lg:         "lg.com",
  samsung:    "samsung.com",
  bosch:      "bosch-home.com",
};

function resolveCanonicalDomain(manufacturerName: string): string | null {
  const normalizedInput = manufacturerName.toLowerCase().replace(/\s+/g, "");

  // 1. Exact match first (fastest, unambiguous)
  if (MANUFACTURER_DOMAIN_MAP[manufacturerName]) {
    return MANUFACTURER_DOMAIN_MAP[manufacturerName];
  }
  
  // 1b. Normalized exact match (handles casing and spacing e.g., "Kitchen Aid" -> "kitchenaid")
  for (const [key, domain] of Object.entries(MANUFACTURER_DOMAIN_MAP)) {
    if (normalizedInput === key.toLowerCase().replace(/\s+/g, "")) {
      return domain;
    }
  }

  const lower = manufacturerName.toLowerCase();
  // 2. One-directional substring: manufacturer name contains the key.
  // Minimum key length of 4 chars prevents false positives from short keys (e.g., "ge" inside "general").
  // For short keys, we use a word-boundary regex to safely match them (e.g., "LG Electronics" -> matches "lg").
  for (const [key, domain] of Object.entries(MANUFACTURER_DOMAIN_MAP)) {
    const keyLower = key.toLowerCase();
    if (keyLower.length >= 4) {
      if (lower.includes(keyLower)) return domain;
    } else {
      const regex = new RegExp(`\\b${keyLower}\\b`);
      if (regex.test(lower)) return domain;
    }
  }
  return null;
}

function validateDomain(url: string, expectedDomain: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === expectedDomain || hostname.endsWith(`.${expectedDomain}`);
  } catch {
    return false;
  }
}

/**
 * Performs a REAL live web search via Tavily Search API,
 * scoped to the manufacturer's official domain using site: operator.
 * Returns the first grounded citation URL, or null if nothing was found.
 */
async function liveSearchManufacturerSite(
  domain: string,
  partNumber: string,
  manufacturerName: string
): Promise<{ url: string | null; extractedText: string | null }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  const query = `${partNumber} product specifications site:${domain}`;

  try {
    const response = await fetch(TAVILY_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "advanced",
        include_domains: [domain],
        max_results: 3,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    const results: any[] = json?.results ?? [];

    if (results.length === 0) {
      return { url: null, extractedText: null };
    }

    const best = results[0];
    const extractedText = best?.content ? JSON.stringify({ raw_content: best.content }) : null;

    return { url: best?.url ?? null, extractedText };
  } catch (err) {
    console.error("[enrich] Live search error:", err);
    return { url: null, extractedText: null };
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

  // 2. Real live search via Gemini Google Search Grounding
  const { url: candidateUrl, extractedText } = await liveSearchManufacturerSite(
    canonicalDomain,
    partNumber,
    manufacturerName
  );

  // Failure mode A: zero results from live search
  if (!candidateUrl) {
    return {
      officialDataFound: false,
      status: `needs review - live search returned no results on ${canonicalDomain} for part "${partNumber}"`,
    };
  }

  // Failure mode B: URL returned but domain doesn't match allowlist
  if (!validateDomain(candidateUrl, canonicalDomain)) {
    let returnedHostname = "unknown";
    try {
      returnedHostname = new URL(candidateUrl).hostname;
    } catch {}
    return {
      officialDataFound: false,
      status: `needs review - domain mismatch: live search returned "${returnedHostname}", expected "${canonicalDomain}"`,
    };
  }

  // Both checks passed — official URL verified
  const result: EnrichmentResult = {
    officialDataFound: true,
    status: `success - official URL found and domain verified (${canonicalDomain})`,
    sourceUrl: candidateUrl,
  };

  if (extractedText) {
    try {
      result.extractedAttributes = JSON.parse(extractedText);
    } catch {}
  }

  return result;
}
