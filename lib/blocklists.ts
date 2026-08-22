/**
 * lib/blocklists.ts
 * Domain filtering utilities for the CatalogIQ enrichment pipeline.
 *
 * Strategy: positive verification first, blocklist as a fast-fail short-circuit.
 *
 * The primary guard is verifyOfficialManufacturerDomain(), which uses Groq to
 * reason about whether a domain is the manufacturer's own site based on the
 * domain name and page snippet — this generalises to any unknown domain without
 * needing an ever-growing list.
 *
 * QUICK_REJECT_DOMAINS is a tiny blocklist of extremely common false-positives
 * (mostly the top 5-6 sites that every brand-name search returns). It's only a
 * fast-path short-circuit so we don't burn a Groq call on an obvious Amazon result.
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";

// ---------------------------------------------------------------------------
// Fast-fail short-circuit blocklist (keep this SHORT — 10 entries max).
// The real filter is verifyOfficialManufacturerDomain() below.
// ---------------------------------------------------------------------------
export const QUICK_REJECT_DOMAINS: readonly string[] = [
  "amazon.com", "ebay.com", "walmart.com", "youtube.com", "wikipedia.org",
  "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com",
];

/**
 * Fast-path check — returns true if the hostname is on the tiny quick-reject
 * list. Caller should still run verifyOfficialManufacturerDomain() for anything
 * that passes this check.
 */
export function isObviouslyBlocked(hostname: string): boolean {
  const clean = hostname.replace(/^www\./, "");
  return QUICK_REJECT_DOMAINS.some(
    (bad) => clean === bad || clean.endsWith(`.${bad}`)
  );
}

// Keep the old export name as an alias so existing call sites don't break
// while we migrate callers to the new positive-verification approach.
export const isBlockedDomain = isObviouslyBlocked;

// ---------------------------------------------------------------------------
// Positive-verification (the real guard)
// ---------------------------------------------------------------------------

export interface DomainVerificationResult {
  isOfficial: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

/**
 * Uses Groq to decide whether a candidate domain is the manufacturer's own
 * official site, rather than a retailer, aggregator, directory, or any other
 * third-party.
 *
 * This generalises to any domain without needing a maintained blocklist:
 *   - Signals considered: domain-name/brand-name alignment, page snippet content
 *   - Only returns isOfficial=true at confidence "high" or "medium"
 *   - On any parse/API error returns { isOfficial: false, confidence: "low" }
 *
 * Exported so both enrich.ts and discover-brand.ts call the same function.
 */
export async function verifyOfficialManufacturerDomain(
  domain: string,
  manufacturerName: string,
  pageSnippet: string
): Promise<DomainVerificationResult> {
  const REJECT: DomainVerificationResult = {
    isOfficial: false,
    confidence: "high",
    reasoning: "verification failed — defaulting to reject",
  };

  const systemPrompt =
    `You are verifying whether a website is a manufacturer's own official domain, \
as opposed to a retailer, marketplace, business directory, data aggregator, review site, \
or any other third party. Return ONLY valid JSON — no explanation outside the object.`;

  const userPrompt =
    `Manufacturer being verified: "${manufacturerName}"
\
Candidate domain: "${domain}"
\
Page title/snippet from search: "${pageSnippet.slice(0, 400)}"
\
Consider these signals:
\
- Does the domain name relate directly to the manufacturer/brand name? \
(e.g. frigidaire.com for Frigidaire is a strong positive; a generic business-sounding \
domain unrelated to the brand is negative)
\
- Does the page snippet describe products, specifications, or a product catalog \
(positive), or company contact info, employee counts, revenue data, reviews, or a \
marketplace listing (negative)?
\
- Official manufacturer sites typically have the brand name as or very near the \
start of the domain. Directories/aggregators have their OWN brand as the domain \
(zoominfo.com, crunchbase.com, bloomberg.com) regardless of which company they describe \
— if the domain name doesn't relate to the manufacturer at all, that is a strong \
negative signal regardless of what the specific site is.
\
Return ONLY this JSON shape, nothing else:
\
{ "isOfficial": true_or_false, "confidence": "high"|"medium"|"low", "reasoning": "one sentence" }`;

  try {
    const raw = await callGroq(systemPrompt, userPrompt, undefined, undefined, 256);
    const parsed = parseJsonResponse<{ isOfficial: boolean; confidence: string; reasoning: string }>(raw);

    const confidence = (["high", "medium", "low"].includes(parsed.confidence)
      ? parsed.confidence
      : "low") as "high" | "medium" | "low";

    return {
      isOfficial: Boolean(parsed.isOfficial),
      confidence,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return REJECT;
  }
}
