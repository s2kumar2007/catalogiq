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
import { isObviouslyBlocked, verifyOfficialManufacturerDomain } from "@/lib/blocklists";

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
  /** Additional candidate URLs from search results that weren't chosen as the
   *  primary official source, but are still real relevant pages (retailer
   *  listings, spec sheets, etc.) suitable for Ref URL 2-5 slots. */
  referenceUrls?: string[];
}

// In-memory cache: manufacturer name → discovered domain (or null = tried,
// nothing found). Avoids re-discovering the same brand's domain on every
// row within a single pipeline run.
const domainDiscoveryCache = new Map<string, string | null>();


/**
 * Discovers the manufacturer's official domain by:
 *   1. Fast-fail blocking on obviously-wrong domains (Amazon, eBay, etc.)
 *   2. Positive-verification via Groq for every candidate that passes step 1
 *      — only accepts domains where Groq confirms it's the manufacturer's own
 *        site at "high" or "medium" confidence
 *
 * This replaces the previous ever-growing blocklist approach.
 */
async function discoverManufacturerDomain(
  manufacturerName: string
): Promise<{ domain: string | null; candidateUrls: string[] }> {
  if (domainDiscoveryCache.has(manufacturerName)) {
    return { domain: domainDiscoveryCache.get(manufacturerName)!, candidateUrls: [] };
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
      return { domain: null, candidateUrls: [] };
    }

    const json = await response.json();
    const results: any[] = json?.results ?? [];

    // Track all non-blocked candidate URLs as potential reference material
    const candidateUrls: string[] = [];

    for (const r of results) {
      let hostname: string;
      try {
        hostname = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        continue; // malformed URL
      }

      // Step 1: fast-fail on obviously wrong domains (no Groq call wasted)
      if (isObviouslyBlocked(hostname)) {
        console.log(`  [enrich] domain check: ${hostname} REJECTED (fast-fail) — on obvious-reject list`);
        continue;
      }

      // Collect as a candidate reference URL before verifying officialness
      candidateUrls.push(r.url);

      // Step 2: positive-verification via Groq
      const pageSnippet = `${r.title ?? ""} ${r.content ?? ""}`;
      const verification = await verifyOfficialManufacturerDomain(hostname, manufacturerName, pageSnippet);
      const accepted = verification.isOfficial && verification.confidence !== "low";

      console.log(
        `  [enrich] domain check: ${hostname} ${
          accepted ? "ACCEPTED" : "REJECTED"
        } (${verification.confidence}) — ${verification.reasoning}`
      );

      if (accepted) {
        domainDiscoveryCache.set(manufacturerName, hostname);
        return { domain: hostname, candidateUrls };
      }
    }

    domainDiscoveryCache.set(manufacturerName, null);
    return { domain: null, candidateUrls };
  } catch (err) {
    console.error("[enrich] Domain discovery error:", err);
    domainDiscoveryCache.set(manufacturerName, null);
    return { domain: null, candidateUrls: [] };
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
): Promise<{ url: string | null; rawContent: string | null; extraUrls: string[] }> {
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
      return { url: null, rawContent: null, extraUrls: [] };
    }

    const best = results[0];
    // Collect remaining results as supplementary reference URLs
    const extraUrls = results.slice(1).map((r: any) => r.url).filter(Boolean);
    return { url: best?.url ?? null, rawContent: best?.content ?? null, extraUrls };
  } catch (err) {
    console.error("[enrich] Product search error:", err);
    return { url: null, rawContent: null, extraUrls: [] };
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
  const { domain: discoveredDomain, candidateUrls: discoveryCandidateUrls } =
    await discoverManufacturerDomain(normalizedManuf);

  // Failure mode A: no plausible official domain found
  if (!discoveredDomain) {
    return {
      officialDataFound: false,
      status: `needs review - could not discover an official domain for manufacturer: "${normalizedManuf}"`,
      referenceUrls: discoveryCandidateUrls.slice(0, 4),
    };
  }

  // 2. Search for the specific product page on that domain
  const { url: candidateUrl, rawContent, extraUrls: productExtraUrls } =
    await searchProductOnDomain(discoveredDomain, partNumber);

  // Failure mode B: zero product-page results
  if (!candidateUrl) {
    return {
      officialDataFound: false,
      status: `needs review - live search returned no results on ${discoveredDomain} for part "${partNumber}"`,
      discoveredDomain,
      referenceUrls: discoveryCandidateUrls.slice(0, 4),
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
  // Build reference URL list: remaining on-domain results + discovery candidates,
  // deduplicated and excluding the primary sourceUrl. Up to 4 total.
  const allCandidates = [...productExtraUrls, ...discoveryCandidateUrls]
    .filter((u) => u && u !== candidateUrl);
  const referenceUrls = [...new Set(allCandidates)].slice(0, 4);

  const result: EnrichmentResult = {
    officialDataFound: true,
    status: `success - official domain discovered and verified (${discoveredDomain})`,
    sourceUrl: candidateUrl,
    discoveredDomain,
    referenceUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
  };

  if (rawContent) {
    result.extractedAttributes = await parseSpecsFromContent(rawContent, partNumber);
  }

  return result;
}