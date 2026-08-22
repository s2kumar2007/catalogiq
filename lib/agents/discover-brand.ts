/**
 * lib/agents/discover-brand.ts
 * Stage 4.5 (pre-Enrich): MPN-Based Brand Discovery
 *
 * Runs ONLY when resolveBrandForEnrichment() returns null — meaning the
 * extracted fields contain no usable manufacturer or brand at all (common
 * when Part_Manuf is a distributor and the description text doesn't include
 * the brand name explicitly).
 *
 * Strategy:
 *   1. Tavily search for `"<MPN>" manufacturer specifications` to find pages
 *      where the exact MPN string appears (manufacturer sites, spec sheets).
 *   2. Filter out known retailers/marketplaces (same blocklist as enrich.ts).
 *   3. Pass the surviving result titles, snippets, and domains to Groq and ask:
 *      "which manufacturer most plausibly makes a product with this MPN?"
 *   4. Compute a code-level confidence heuristic (not from the LLM):
 *       - "high"   : 2+ independent non-retailer domains agree on the same name
 *       - "medium" : 1 result from a domain that looks like the manufacturer's own site
 *       - "low"    : inferred from indirect context (review sites, forums, etc.)
 *
 * On any failure (API error, no results, Groq parse failure) the function
 * returns { discovered: false } — never throws — so the pipeline continues.
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";
import { isObviouslyBlocked, verifyOfficialManufacturerDomain } from "@/lib/blocklists";

const TAVILY_API_BASE = "https://api.tavily.com/search";

// In-memory cache keyed by MPN. Same pattern as enrich.ts domainDiscoveryCache.
const brandDiscoveryCache = new Map<string, BrandDiscoveryResult>();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrandDiscoveryInput {
  mpn: string;               // raw manufacturer part number, e.g. "PDSH4816AF"
  productDescription: string; // Part_Desc for context in the search query
}

export interface BrandDiscoveryResult {
  discovered: boolean;
  manufacturerName?: string;  // e.g. "Rheem Manufacturing"
  brandName?: string;         // e.g. "FRIGIDAIRE®" (if distinct from manufacturer)
  sourceUrl?: string;         // the page where this was found, for traceability
  confidence: "high" | "medium" | "low";
  method: "mpn_web_search";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



/** Returns the eTLD+1 portion of a hostname: "support.lg.com" → "lg.com" */
function rootDomain(hostname: string): string {
  const clean = hostname.replace(/^www\./, "");
  const parts = clean.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : clean;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

export async function discoverBrandFromMPN(
  input: BrandDiscoveryInput
): Promise<BrandDiscoveryResult> {
  const { mpn, productDescription } = input;
  const FAILED: BrandDiscoveryResult = { discovered: false, confidence: "low", method: "mpn_web_search" };

  if (!mpn || mpn.trim().length < 3) return FAILED;

  const cacheKey = mpn.trim().toUpperCase();
  if (brandDiscoveryCache.has(cacheKey)) {
    return brandDiscoveryCache.get(cacheKey)!;
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[discover-brand] TAVILY_API_KEY not set — skipping brand discovery");
    return FAILED;
  }

  try {
    // Step 1: Tavily search — exact MPN in quotes forces closer-to-exact matching
    const query = `"${mpn}" manufacturer specifications`;

    const response = await fetch(TAVILY_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 6,
      }),
    });

    if (!response.ok) {
      console.warn(`[discover-brand] Tavily error ${response.status} for MPN "${mpn}"`);
      brandDiscoveryCache.set(cacheKey, FAILED);
      return FAILED;
    }

    const json = await response.json();
    const allResults: any[] = json?.results ?? [];

    if (allResults.length === 0) {
      brandDiscoveryCache.set(cacheKey, FAILED);
      return FAILED;
    }

    // Step 2: Filter out blocklisted domains (fast-fail only)
    const cleanResults = allResults.filter((r) => {
      try {
        const hostname = new URL(r.url).hostname;
        return !isObviouslyBlocked(hostname);
      } catch {
        return false;
      }
    });

    if (cleanResults.length === 0) {
      brandDiscoveryCache.set(cacheKey, FAILED);
      return FAILED;
    }

    // Step 3: Pass top-5 surviving results to Groq for brand identification
    const snippets = cleanResults.slice(0, 5).map((r, idx) => {
      let hostname = "unknown";
      try { hostname = new URL(r.url).hostname; } catch {}
      return `[${idx + 1}] Domain: ${hostname}\n    Title: ${r.title ?? "(no title)"}\n    Snippet: ${(r.content ?? "").slice(0, 300)}`;
    }).join("\n\n");

    const systemPrompt = `You identify the manufacturer of a product given web search results. 
Return ONLY valid JSON. Never add explanation outside the JSON object.`;

    const userPrompt = `Product part number: "${mpn}"
Product description context: "${productDescription.slice(0, 200)}"

Web search results (already filtered to exclude retailers/marketplaces):
${snippets}

Task: Identify the manufacturer that makes a product with part number "${mpn}".

Rules:
- Only answer if you are reasonably confident — return discovered: false if results are ambiguous or don't clearly point to one company.
- Prefer results where the domain itself is plausibly the manufacturer's own site (domain name matches or relates to the company name).
- Extract MANUFACTURER_NAME (full/legal company name) and BRAND_NAME (consumer-facing brand, often the same but sometimes different, e.g. Rheem Manufacturing makes FRIGIDAIRE-branded dishwashers).
- If only one name is clearly known, set both manufacturer_name and brand_name to that value.
- result_index: the 1-based index of the most useful search result (or 0 if none were useful).

Respond with this exact JSON shape:
{
  "discovered": true or false,
  "manufacturer_name": "Company Legal Name" or null,
  "brand_name": "Consumer Brand" or null,
  "result_index": 1
}`;

    const groqResponse = await callGroq(systemPrompt, userPrompt, undefined, undefined, 512);

    let parsed: {
      discovered: boolean;
      manufacturer_name: string | null;
      brand_name: string | null;
      result_index: number;
    };

    try {
      parsed = parseJsonResponse(groqResponse);
    } catch {
      brandDiscoveryCache.set(cacheKey, FAILED);
      return FAILED;
    }

    if (!parsed.discovered || (!parsed.manufacturer_name && !parsed.brand_name)) {
      brandDiscoveryCache.set(cacheKey, FAILED);
      return FAILED;
    }

    // Step 4: Positive-verification of the discovered domain
    const resultIdx = (parsed.result_index ?? 1) - 1;
    const bestResult = cleanResults[resultIdx] ?? cleanResults[0];
    let bestHostname = "unknown";
    try { bestHostname = new URL(bestResult.url).hostname; } catch {}

    const manufacturerName = parsed.manufacturer_name ?? parsed.brand_name ?? "";
    const pageSnippet = `${bestResult.title ?? ""} ${bestResult.content ?? ""}`;

    const verification = await verifyOfficialManufacturerDomain(
      bestHostname,
      manufacturerName,
      pageSnippet
    );

    const accepted = verification.isOfficial && verification.confidence !== "low";
    
    console.log(
      `  [discover-brand] domain check: ${bestHostname} ${
        accepted ? "ACCEPTED" : "REJECTED"
      } (${verification.confidence}) — ${verification.reasoning}`
    );

    if (!accepted) {
      brandDiscoveryCache.set(cacheKey, FAILED);
      return FAILED;
    }

    const result: BrandDiscoveryResult = {
      discovered: true,
      manufacturerName: parsed.manufacturer_name ?? undefined,
      brandName: parsed.brand_name ?? undefined,
      sourceUrl: bestResult?.url ?? undefined,
      confidence: verification.confidence,
      method: "mpn_web_search",
    };

    brandDiscoveryCache.set(cacheKey, result);
    return result;

  } catch (err) {
    console.error("[discover-brand] Unexpected error:", err);
    brandDiscoveryCache.set(cacheKey, FAILED);
    return FAILED;
  }
}
