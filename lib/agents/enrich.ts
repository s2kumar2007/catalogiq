/**
 * lib/agents/enrich.ts
 * Stage 5: Enrichment Agent
 *
 * Dynamically discovers a manufacturer's official domain via Tavily Search
 * (no hardcoded manufacturer→domain list — scales to any brand in the dataset),
 * verifies the discovered domain isn't a known retailer/marketplace, then
 * performs a second, domain-restricted search for the actual product page.
 * Raw page content is then parsed by Groq into structured attribute values.
 *
 * Three failure modes are explicitly flagged:
 *   A) No plausible official domain could be discovered for the manufacturer
 *   B) Zero product-page results found on the discovered domain
 *   C) Returned product URL doesn't match the discovered domain (defense in depth)
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";

const TAVILY_API_BASE = "https://api.tavily.com/search";

export interface EnrichmentInput {
  manufacturerName: string;
  partNumber: string; // real MPN extracted from the product data
}

export interface EnrichmentResult {
  officialDataFound: boolean;
  status: string;
  sourceUrl?: string;
  discoveredDomain?: string;
  extractedAttributes?: Record<string, string>;
}

// Retailers/marketplaces/distributors that must never be accepted as an
// "official manufacturer domain," even if they rank highly in search.
const KNOWN_RETAILER_BLOCKLIST = [
  "amazon.com", "homedepot.com", "lowes.com", "walmart.com", "ebay.com",
  "wayfair.com", "target.com", "bestbuy.com", "grainger.com", "menards.com",
  "acehardware.com", "build.com", "ferguson.com", "supplyhouse.com",
  "alibaba.com", "aliexpress.com", "wikipedia.org", "youtube.com",
];

// In-memory cache: manufacturer name → discovered domain (or null = tried,
// nothing found). Avoids re-discovering the same brand's domain on every
// row within a single pipeline run.
const domainDiscoveryCache = new Map<string, string | null>();

function isBlockedDomain(hostname: string): boolean {
  const clean = hostname.replace(/^www\./, "");
  return KNOWN_RETAILER_BLOCKLIST.some(
    (bad) => clean === bad || clean.endsWith(`.${bad}`)
  );
}

/**
 * Searches for "<manufacturer> official website" and returns the first
 * result whose domain isn't a known retailer/marketplace. This replaces
 * a static manufacturer→domain map so any brand in the dataset can be
 * resolved, not just a pre-curated handful.
 */
async function discoverManufacturerDomain(
  manufacturerName: string
): Promise<string | null> {
  if (domainDiscoveryCache.has(manufacturerName)) {
    return domainDiscoveryCache.get(manufacturerName)!;
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  try {
    const response = await fetch(TAVILY_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${manufacturerName} official website`,
        search_depth: "basic",
        max_results: 5,
      }),
    });

    if (!response.ok) {
      domainDiscoveryCache.set(manufacturerName, null);
      return null;
    }

    const json = await response.json();
    const results: any[] = json?.results ?? [];

    for (const r of results) {
      try {
        const hostname = new URL(r.url).hostname.replace(/^www\./, "");
        if (!isBlockedDomain(hostname)) {
          domainDiscoveryCache.set(manufacturerName, hostname);
          return hostname;
        }
      } catch {
        // skip malformed URLs from search results
      }
    }

    domainDiscoveryCache.set(manufacturerName, null);
    return null;
  } catch (err) {
    console.error("[enrich] Domain discovery error:", err);
    domainDiscoveryCache.set(manufacturerName, null);
    return null;
  }
}

function validateDomain(url: string, expectedDomain: string): boolean {
  try {
    const { hostname } = new URL(url);
    const clean = hostname.replace(/^www\./, "");
    return clean === expectedDomain || clean.endsWith(`.${expectedDomain}`);
  } catch {
    return false;
  }
}

/**
 * Searches for the specific product page on the (already discovered and
 * verified) manufacturer domain. Returns the first result's URL and raw
 * page content, or nulls if nothing was found.
 */
async function searchProductOnDomain(
  domain: string,
  partNumber: string
): Promise<{ url: string | null; rawContent: string | null }> {
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
      return { url: null, rawContent: null };
    }

    const best = results[0];
    return { url: best?.url ?? null, rawContent: best?.content ?? null };
  } catch (err) {
    console.error("[enrich] Product search error:", err);
    return { url: null, rawContent: null };
  }
}

/**
 * Parses raw webpage text into structured attribute key-value pairs
 * using Groq. Returns {} on any failure — enrichment still succeeds
 * (URL was found and verified), just without extracted specs.
 */
async function parseSpecsFromContent(
  rawContent: string,
  partNumber: string
): Promise<Record<string, string>> {
  const systemPrompt = `You extract product specification key-value pairs from raw webpage text. Return ONLY valid JSON: a flat object mapping attribute names to their values (e.g. {"Voltage Rating": "120 V", "Sound Level": "47 dBA"}). If no specs are found, return {}.`;
  const userPrompt = `Extract product specifications for part number "${partNumber}" from this webpage text:\n\n${rawContent.slice(0, 4000)}`;

  try {
    const response = await callGroq(systemPrompt, userPrompt, undefined, undefined, 1024);
    return parseJsonResponse<Record<string, string>>(response);
  } catch (err) {
    console.warn("[enrich] Spec parsing failed:", err);
    return {};
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

  const normalizedManuf = manufacturerName.trim();
  const isPlaceholder = /^--\s*unbranded\s*--$|^unbranded$/i.test(normalizedManuf);
  if (!normalizedManuf || isPlaceholder) {
    return {
      officialDataFound: false,
      status: `needs review - no identifiable manufacturer/brand (value: "${manufacturerName}")`,
    };
  }

  // 1. Dynamically discover the manufacturer's official domain
  const discoveredDomain = await discoverManufacturerDomain(normalizedManuf);

  // Failure mode A: no plausible official domain found
  if (!discoveredDomain) {
    return {
      officialDataFound: false,
      status: `needs review - could not discover an official domain for manufacturer: "${normalizedManuf}"`,
    };
  }

  // 2. Search for the specific product page on that domain
  const { url: candidateUrl, rawContent } = await searchProductOnDomain(
    discoveredDomain,
    partNumber
  );

  // Failure mode B: zero product-page results
  if (!candidateUrl) {
    return {
      officialDataFound: false,
      status: `needs review - live search returned no results on ${discoveredDomain} for part "${partNumber}"`,
      discoveredDomain,
    };
  }

  // Failure mode C: defense in depth — confirm the returned URL really is
  // on the discovered domain (include_domains should already guarantee this,
  // but verify explicitly rather than trusting the API silently).
  if (!validateDomain(candidateUrl, discoveredDomain)) {
    let returnedHostname = "unknown";
    try {
      returnedHostname = new URL(candidateUrl).hostname;
    } catch {}
    return {
      officialDataFound: false,
      status: `needs review - domain mismatch: live search returned "${returnedHostname}", expected "${discoveredDomain}"`,
      discoveredDomain,
    };
  }

  // All checks passed — official URL discovered and verified
  const result: EnrichmentResult = {
    officialDataFound: true,
    status: `success - official domain discovered and verified (${discoveredDomain})`,
    sourceUrl: candidateUrl,
    discoveredDomain,
  };

  if (rawContent) {
    result.extractedAttributes = await parseSpecsFromContent(rawContent, partNumber);
  }

  return result;
}