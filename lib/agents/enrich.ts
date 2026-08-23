import { callGroq, parseJsonResponse } from "@/lib/groq";
import { isObviouslyBlocked, verifyOfficialManufacturerDomain } from "@/lib/blocklists";

const TAVILY_API_BASE = "https://api.tavily.com/search";

export interface EnrichmentInput {
  manufacturerName: string;
  partNumber: string; // real MPN extracted from the product data
  productDescription?: string;
}

export interface EnrichmentResult {
  officialDataFound: boolean;
  status: string;
  sourceUrl?: string;
  discoveredDomain?: string;
  extractedAttributes?: Record<string, string>;
  productImageUrl?: string | null;
  alternateImageUrls?: string[];
  specSheetUrl?: string | null;
  referenceUrls?: string[];
}

const domainDiscoveryCache = new Map<string, string | null>();

interface TavilySearchOptions {
  includeImages?: boolean;
  includeDomains?: string[];
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
}

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
}

interface TavilyImageResult {
  url?: string;
}

interface TavilySearchResponse {
  results?: TavilyResult[];
  images?: Array<string | TavilyImageResult>;
}

async function searchTavily(
  query: string,
  options: TavilySearchOptions = {}
): Promise<TavilySearchResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  const response = await fetch(TAVILY_API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: options.searchDepth ?? "basic",
      include_domains: options.includeDomains,
      include_images: options.includeImages,
      max_results: options.maxResults ?? 5,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed with HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

async function discoverManufacturerDomain(
  manufacturerName: string
): Promise<{ domain: string | null; candidateUrls: string[] }> {
  if (domainDiscoveryCache.has(manufacturerName)) {
    return { domain: domainDiscoveryCache.get(manufacturerName)!, candidateUrls: [] };
  }

  try {
    const json = await searchTavily(`${manufacturerName} official website`, {
      searchDepth: "basic",
      maxResults: 5,
    });
    const results = json.results ?? [];

    const candidateUrls: string[] = [];

    for (const r of results) {
      if (!r.url) continue;
      let hostname: string;
      try {
        hostname = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }

      if (isObviouslyBlocked(hostname)) {
        console.log(`  [enrich] domain check: ${hostname} REJECTED (fast-fail) — on obvious-reject list`);
        continue;
      }

      candidateUrls.push(r.url);

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

async function searchProductOnDomain(
  domain: string,
  partNumber: string
): Promise<{ url: string | null; rawContent: string | null; extraUrls: string[] }> {
  const query = `${partNumber} product specifications site:${domain}`;

  try {
    const json = await searchTavily(query, {
      searchDepth: "advanced",
      includeDomains: [domain],
      maxResults: 3,
    });
    const results = json.results ?? [];

    if (results.length === 0) {
      return { url: null, rawContent: null, extraUrls: [] };
    }

    const best = results[0];
    const extraUrls = results.slice(1).map((r) => r.url).filter(Boolean) as string[];
    return { url: best?.url ?? null, rawContent: best?.content ?? null, extraUrls };
  } catch (err) {
    console.error("[enrich] Product search error:", err);
    return { url: null, rawContent: null, extraUrls: [] };
  }
}

async function discoverDigitalAssets(
  manufacturerDomain: string,
  mpn: string,
  productDescription: string
): Promise<{ productImageUrl: string | null; alternateImageUrls: string[]; specSheetUrl: string | null }> {
  const queries = [
    `"${mpn}" site:${manufacturerDomain}`,
    `"${mpn}" datasheet OR specification OR spec sheet site:${manufacturerDomain}`,
    `"${mpn}" product image site:${manufacturerDomain}`,
    `${productDescription} "${mpn}" filetype:pdf`,
  ];

  let productImageUrl: string | null = null;
  const alternateImageUrls: string[] = [];
  let specSheetUrl: string | null = null;

  for (const query of queries) {
    try {
      const results = await searchTavily(query, { includeImages: true });
      for (const r of results?.results ?? []) {
        if (!productImageUrl && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(r.url || "")) {
          productImageUrl = r.url!;
        } else if (alternateImageUrls.length < 4 && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(r.url || "") && r.url !== productImageUrl) {
          alternateImageUrls.push(r.url!);
        }
        if (!specSheetUrl && /\.pdf(\?|$)/i.test(r.url || "")) {
          specSheetUrl = r.url!;
        }
      }
      
      for (const img of results?.images ?? []) {
        const url = typeof img === "string" ? img : img.url;
        if (!url) continue;
        if (!productImageUrl) {
          productImageUrl = url;
        } else if (alternateImageUrls.length < 4 && url !== productImageUrl && !alternateImageUrls.includes(url)) {
          alternateImageUrls.push(url);
        }
      }

      if (productImageUrl && specSheetUrl) break; // stop early once both found
    } catch (err) {
      console.error(`[enrich] digital asset query failed: "${query}"`, err);
      continue; // try the next query variation rather than giving up entirely
    }
  }

  console.log(`[assets] MPN=${mpn} image=${!!productImageUrl} altImages=${alternateImageUrls.length} specSheet=${!!specSheetUrl}`);
  return { productImageUrl, alternateImageUrls, specSheetUrl };
}

async function extractWarrantyStatement(content: string, mpn: string): Promise<string | null> {
    const systemPrompt = `Extract ONLY the warranty statement from this text, verbatim if possible. Return null if genuinely not present. Return valid JSON: {"warranty": "string" | null}`;
    const userPrompt = `Extract warranty for "${mpn}":\n\n${content.slice(0, 4000)}`;
    try {
        const response = await callGroq(systemPrompt, userPrompt, undefined, undefined, 512);
        const parsed = parseJsonResponse<{warranty: string | null}>(response);
        return parsed.warranty || null;
    } catch {
        return null;
    }
}

async function extractApprovalsList(content: string, mpn: string): Promise<string[]> {
    const systemPrompt = `Extract a list of certifications, standards compliance, or regulatory approvals from this text. Return null if genuinely not present. Return valid JSON: {"approvals": ["string"] | null}`;
    const userPrompt = `Extract approvals for "${mpn}":\n\n${content.slice(0, 4000)}`;
    try {
        const response = await callGroq(systemPrompt, userPrompt, undefined, undefined, 512);
        const parsed = parseJsonResponse<{approvals: string[] | null}>(response);
        return parsed.approvals || [];
    } catch {
        return [];
    }
}

async function discoverComplianceInfo(
  manufacturerDomain: string,
  mpn: string
): Promise<{ warranty: string | null; approvals: string[] }> {
  let warranty: string | null = null;
  let approvals: string[] = [];

  try {
    const warrantyResults = await searchTavily(`"${mpn}" warranty site:${manufacturerDomain}`, { maxResults: 1 });
    if (warrantyResults?.results?.[0]?.content) {
      warranty = await extractWarrantyStatement(warrantyResults.results[0].content, mpn);
    }
  } catch (err) {
    console.error(`[enrich] warranty search failed for ${mpn}:`, err);
  }

  try {
    const certResults = await searchTavily(`"${mpn}" certified OR UL listed OR approvals OR compliance site:${manufacturerDomain}`, { maxResults: 1 });
    if (certResults?.results?.[0]?.content) {
      approvals = await extractApprovalsList(certResults.results[0].content, mpn);
    }
  } catch (err) {
    console.error(`[enrich] approvals search failed for ${mpn}:`, err);
  }

  console.log(`[compliance] MPN=${mpn} warranty=${!!warranty} approvals=${approvals.length}`);
  return { warranty, approvals };
}


async function parseSpecsFromContent(
  rawContent: string,
  partNumber: string
): Promise<Record<string, string>> {
  const systemPrompt = `You extract product specification key-value pairs from raw webpage text. Return ONLY valid JSON: a flat object mapping attribute names to their values, for example:
{"Voltage Rating": "120 V", "Country Of Origin": "USA", "Warranty": "5 Year Limited", "UPC": "078477012345", "EAN": "5012345678900", "GTIN": "00078477012345", "UNSPSC": "39121517"}.
Include "Country Of Origin" and "Warranty" ONLY if the text explicitly states them — do not infer a country from the manufacturer's headquarters, and do not infer a warranty term from category norms. If a field is not explicitly stated in the text, omit it entirely from the JSON. If no specs are found at all, return {}.

UPC, EAN, and GTIN are numeric identifier codes — only include them if the exact digit string appears in the text. Do not construct, pad, or guess a check digit. UNSPSC is an 8-digit classification code — only include it if explicitly labeled as UNSPSC in the source; do not infer it from the product category.

List Price must include the currency if stated (e.g. '$24.99'). Selling Qty, Selling UOM, Standard Packaging Information should also be extracted if present. Selling UOM must use the approved UOM abbreviations from the project's UOM standards (e.g. 'EA', 'BX', 'CS') — if the page states a unit that isn't in approved form, still extract it verbatim here; the normalize stage will convert it later, do not convert it yourself in this step.

For any physical dimension (length, height, width, weight, volume), extract the numeric value and its unit SEPARATELY as two fields, e.g. {"LENGTH": "24", "LENGTH_UOM": "in"}. Use the unit exactly as written in the source text — do not convert units yourself. If a dimension is given as a range or is ambiguous, leave both fields blank rather than guessing which value to use.

In addition to technical specifications, also extract these if genuinely present on the page:
- Standard/Approvals: any listed certifications, standards compliance, or regulatory approvals (e.g. 'UL Listed', 'ENERGY STAR Certified', 'NSF Certified', 'ASSE 1006'). If multiple are listed, return them as a single pipe-separated string matching this format: 'CERT1|CERT2|CERT3'. Only include certifications actually visible on the page - do not assume standard certifications for a product category.`;
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
  const { manufacturerName, partNumber, productDescription } = input;

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

  const { domain: discoveredDomain, candidateUrls: discoveryCandidateUrls } =
    await discoverManufacturerDomain(normalizedManuf);

  if (!discoveredDomain) {
    return {
      officialDataFound: false,
      status: `needs review - could not discover an official domain for manufacturer: "${normalizedManuf}"`,
      referenceUrls: discoveryCandidateUrls.slice(0, 4),
    };
  }

  const { url: candidateUrl, rawContent, extraUrls: productExtraUrls } =
    await searchProductOnDomain(discoveredDomain, partNumber);

  const digitalAssets = await discoverDigitalAssets(discoveredDomain, partNumber, productDescription || "");
  const compliance = await discoverComplianceInfo(discoveredDomain, partNumber);
  
  let extractedAttributes: Record<string, string> = {};
  if (rawContent) {
      extractedAttributes = await parseSpecsFromContent(rawContent, partNumber);
  }
  if (compliance.warranty) {
      extractedAttributes["Warranty"] = compliance.warranty;
  }
  if (compliance.approvals && compliance.approvals.length > 0) {
      extractedAttributes["Standard/Approvals"] = compliance.approvals.join("|");
  }

  if (!candidateUrl) {
    return {
      officialDataFound: false,
      status: `needs review - live search returned no results on ${discoveredDomain} for part "${partNumber}"`,
      discoveredDomain,
      referenceUrls: discoveryCandidateUrls.slice(0, 4),
      productImageUrl: digitalAssets.productImageUrl,
      alternateImageUrls: digitalAssets.alternateImageUrls,
      specSheetUrl: digitalAssets.specSheetUrl,
      extractedAttributes: Object.keys(extractedAttributes).length > 0 ? extractedAttributes : undefined
    };
  }

  if (!validateDomain(candidateUrl, discoveredDomain)) {
    let returnedHostname = "unknown";
    try {
      returnedHostname = new URL(candidateUrl).hostname;
    } catch {}
    return {
      officialDataFound: false,
      status: `needs review - domain mismatch: live search returned "${returnedHostname}", expected "${discoveredDomain}"`,
      discoveredDomain,
      productImageUrl: digitalAssets.productImageUrl,
      alternateImageUrls: digitalAssets.alternateImageUrls,
      specSheetUrl: digitalAssets.specSheetUrl,
      extractedAttributes: Object.keys(extractedAttributes).length > 0 ? extractedAttributes : undefined
    };
  }

  const allCandidates = [...productExtraUrls, ...discoveryCandidateUrls]
    .filter((u): u is string => Boolean(u && u !== candidateUrl));
  const referenceUrls = Array.from(new Set(allCandidates)).slice(0, 4);

  const result: EnrichmentResult = {
    officialDataFound: true,
    status: `success - official domain discovered and verified (${discoveredDomain})`,
    sourceUrl: candidateUrl,
    discoveredDomain,
    productImageUrl: digitalAssets.productImageUrl,
    alternateImageUrls: digitalAssets.alternateImageUrls,
    specSheetUrl: digitalAssets.specSheetUrl,
    referenceUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
    extractedAttributes: Object.keys(extractedAttributes).length > 0 ? extractedAttributes : undefined
  };

  return result;
}
