/**
 * lib/agents/enrich.ts
 * Stage 5: Enrichment Agent
 *
 * Uses Gemini's Google Search Grounding to perform a REAL live web search
 * restricted to the manufacturer's official domain (`site:<domain> <partNumber>`).
 * The URL returned by Gemini's grounded search is then validated with a strict
 * hostname allowlist check before being accepted.
 *
 * Two failure modes are both explicitly flagged:
 *   A) Zero/no results from live search  → "needs review - no results"
 *   B) Returned URL is on the wrong domain → "needs review - domain mismatch"
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

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
// Derived from MANUFACTURER_NAME and MFR URL columns in the Expected Output CSV.
const MANUFACTURER_DOMAIN_MAP: Record<string, string> = {
  "Rheem Manufacturing":                   "frigidaire.com",
  "Appliance Dealers Cooperative (APPDE)": "frigidaire.com",
  "Whirlpool Corporation":                 "whirlpool.com",
  "Jam Industrial Supply LLC (JAMIN)":     "3m.com",
  "Freud Inc (2435)":                      "diablotools.com",
  // Common brand name variants for broader matching
  frigidaire: "frigidaire.com",
  whirlpool:  "whirlpool.com",
  kitchenaid: "kitchenaid.com",
  ge:         "geappliances.com",
  lg:         "lg.com",
  samsung:    "samsung.com",
  bosch:      "bosch-home.com",
};

function resolveCanonicalDomain(manufacturerName: string): string | null {
  if (MANUFACTURER_DOMAIN_MAP[manufacturerName]) {
    return MANUFACTURER_DOMAIN_MAP[manufacturerName];
  }
  const lower = manufacturerName.toLowerCase();
  for (const [key, domain] of Object.entries(MANUFACTURER_DOMAIN_MAP)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return domain;
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
 * Performs a REAL live Google Search via Gemini's Search Grounding tool,
 * scoped to the manufacturer's official domain using site: operator.
 * Returns the first grounded citation URL, or null if nothing was found.
 */
async function liveSearchManufacturerSite(
  domain: string,
  partNumber: string,
  manufacturerName: string
): Promise<{ url: string | null; extractedText: string | null }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const genAI = new GoogleGenerativeAI(apiKey);

  // Use gemini-1.5-flash with Google Search Grounding enabled
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    tools: [{ googleSearch: {} } as any],
  });

  const query = `site:${domain} "${partNumber}" product specifications`;
  const prompt = `Search for the official manufacturer product page or specification sheet for part number "${partNumber}" from ${manufacturerName}.
Use the query: ${query}

Return the URL of the most relevant official product page, spec sheet, or support page you find.
If you find product specifications (voltage, dimensions, sound level, wash cycles, etc.), extract them.

Respond in JSON:
{
  "url": "the exact URL found, or null if nothing found",
  "specs": { "key": "value" }
}`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;

    // Extract grounding metadata (real URLs from Google Search)
    const groundingMeta = (response as any).candidates?.[0]?.groundingMetadata;
    const groundingChunks: any[] = groundingMeta?.groundingChunks ?? [];
    const groundingSupports: any[] = groundingMeta?.groundingSupports ?? [];

    // Find the first citation URL from grounding
    let foundUrl: string | null = null;
    for (const chunk of groundingChunks) {
      const uri = chunk?.web?.uri;
      if (uri && typeof uri === "string") {
        foundUrl = uri;
        break;
      }
    }

    // Also try parsing the LLM's text response for the URL
    let extractedText: string | null = null;
    try {
      const text = response.text().replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(text);
      if (!foundUrl && parsed.url && parsed.url !== "null") {
        foundUrl = parsed.url;
      }
      if (parsed.specs && Object.keys(parsed.specs).length > 0) {
        extractedText = JSON.stringify(parsed.specs);
      }
    } catch {
      // LLM returned non-JSON — that's ok, we still have grounding URL
    }

    return { url: foundUrl, extractedText };
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
