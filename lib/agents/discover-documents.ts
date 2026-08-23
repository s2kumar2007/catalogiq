import { callGroq } from "@/lib/groq";

const TAVILY_API_BASE = "https://api.tavily.com/search";

const DOCUMENT_TARGETS: { field: string; queryHint: string }[] = [
  { field: "Instruction/Installation Manual", queryHint: "installation instructions manual pdf" },
  { field: "Service Manual", queryHint: "service manual pdf" },
  { field: "Owners/User Manual", queryHint: "owners manual user guide pdf" },
  { field: "Line Drawing", queryHint: "line drawing dimensional diagram" },
  { field: "MTR", queryHint: "material test report MTR certification" },
  { field: "RoHS", queryHint: "RoHS compliance certificate" },
  { field: "Full Engineering Drawing", queryHint: "engineering drawing CAD spec sheet" },
  { field: "Energy Star Guide", queryHint: "Energy Star guide certification" },
  { field: "Technical Bulletin", queryHint: "technical bulletin spec sheet" },
  { field: "Submittal", queryHint: "submittal sheet" },
  { field: "Compatibility Chart", queryHint: "compatibility chart" },
  { field: "Size Chart", queryHint: "size chart dimensions" },
  { field: "Product Label/Insert", queryHint: "product label insert" },
];

function validateDomain(url: string, expectedDomain: string): boolean {
  try {
    const { hostname } = new URL(url);
    const clean = hostname.replace(/^www\./, "");
    return clean === expectedDomain || clean.endsWith(`.${expectedDomain}`);
  } catch {
    return false;
  }
}

export async function discoverDocumentLinks(
  domain: string,
  partNumber: string,
  manufacturerName: string
): Promise<{ links: Record<string, string>; videoLinks: string[] }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  const links: Record<string, string> = {};

  for (const target of DOCUMENT_TARGETS) {
    const query = `${manufacturerName} ${partNumber} ${target.queryHint} site:${domain}`;
    try {
      const res = await fetch(TAVILY_API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          include_domains: [domain],
          max_results: 1,
        }),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const hit = json?.results?.[0];
      if (hit?.url && validateDomain(hit.url, domain)) {
        links[target.field] = hit.url;
      }
    } catch {
      // leave blank on any error — never guess a URL
    }
  }

  const videoLinks: string[] = [];
  try {
    const onDomainRes = await fetch(TAVILY_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${manufacturerName} ${partNumber} product video`,
        search_depth: "basic",
        include_domains: [domain, "youtube.com"],
        max_results: 2,
      }),
    });
    if (onDomainRes.ok) {
      const json = await onDomainRes.json();
      for (const r of json?.results ?? []) {
        if (r?.url) videoLinks.push(r.url);
        if (videoLinks.length >= 2) break;
      }
    }
  } catch {
    // leave empty on error
  }

  return { links, videoLinks };
}
