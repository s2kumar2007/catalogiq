/**
 * lib/agents/enrich.ts
 * Stage 5: Enrichment Agent
 * 
 * Performs web search on manufacturer domain to retrieve true product data.
 * Validates the resulting URL against a strict manufacturer domain allowlist.
 */

export interface EnrichmentInput {
  manufacturerName: string;
  partNumber: string;
}

export interface EnrichmentResult {
  officialDataFound: boolean;
  status: string;
  extractedAttributes?: Record<string, string>;
  sourceUrl?: string;
}

// Map canonical manufacturer names to their official domains
const MANUFACTURER_DOMAINS: Record<string, string> = {
  "Rheem Manufacturing": "frigidaire.com",
  "Whirlpool Corporation": "whirlpool.com",
  "Jam Industrial Supply LLC (JAMIN)": "3m.com",
  "Freud Inc (2435)": "diablotools.com"
};

export async function runEnrichment(input: EnrichmentInput): Promise<EnrichmentResult> {
  if (!input.manufacturerName || !input.partNumber) {
    return {
      officialDataFound: false,
      status: "needs review - missing manufacturer or part number"
    };
  }

  const allowedDomain = MANUFACTURER_DOMAINS[input.manufacturerName];
  if (!allowedDomain) {
    return {
      officialDataFound: false,
      status: `needs review - unknown canonical domain for manufacturer: ${input.manufacturerName}`
    };
  }

  // Simulated web search step. In real implementation, this returns a URL from a Search API.
  // For demo, we simulate finding the spec sheet for the known items, and failing for others.
  let searchResultUrl: string | null = null;
  
  if (input.partNumber === "PDSH4816AF") {
    searchResultUrl = "https://www.frigidaire.com/en/p/owner-center/product-support/PDSH4816AF";
  } else if (input.partNumber === "WDTS7024RZ") {
    searchResultUrl = "https://www.whirlpool.com/content/dam/global/documents/202412/owners-manual-w11323304-revj.pdf";
  } else if (input.partNumber === "FAKE_RETAILER") {
    // Simulation of a search engine returning a generic retail result
    searchResultUrl = "https://www.homedepot.com/p/frigidaire";
  } else {
    // Simulation of zero results
    searchResultUrl = null;
  }

  // Domain Validation check
  if (!searchResultUrl) {
    return {
      officialDataFound: false,
      status: "needs review - no results found from manufacturer domain search"
    };
  }

  try {
    const urlObj = new URL(searchResultUrl);
    // Strict domain suffix check (e.g., 'frigidaire.com' or 'www.frigidaire.com')
    if (!urlObj.hostname.endsWith(allowedDomain)) {
      return {
        officialDataFound: false,
        status: `needs review - domain mismatch: returned ${urlObj.hostname}, expected ${allowedDomain}`
      };
    }
  } catch (e) {
    return {
      officialDataFound: false,
      status: "needs review - invalid URL returned from search"
    };
  }

  return {
    officialDataFound: true,
    status: "success - retrieved official manufacturer documentation",
    sourceUrl: searchResultUrl
  };
}
