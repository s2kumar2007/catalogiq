/**
 * app/api/process-batch/route.ts
 * Batch Processing Orchestrator — CatalogIQ
 *
 * Full pipeline per item (mirrors process-product/route.ts):
 *   1. Classify   → Groq   (lib/agents/classify.ts)
 *   2. Extract    → Groq   (lib/agents/extract.ts)
 *   3. Validate   → Groq   (lib/agents/validate.ts)   [skipped if no known schema]
 *   4. Gap-Resolve → Groq  (lib/agents/gap-resolve.ts) [skipped if not static category]
 *   5. Enrich     → Gemini (lib/agents/enrich.ts)
 *   6. Normalize  → Groq   (lib/agents/normalize.ts)
 *   7. Format     → local  (lib/agents/format.ts)
 *
 * Concurrency is set to 1 to avoid Groq TPM limits on the free tier.
 */

import { NextRequest, NextResponse }  from "next/server";
import { runClassification }          from "@/lib/agents/classify";
import { runExtraction }              from "@/lib/agents/extract";
import { runValidation }              from "@/lib/agents/validate";
import { runGapResolution }           from "@/lib/agents/gap-resolve";
import { runEnrichment }              from "@/lib/agents/enrich";
import { runNormalization }           from "@/lib/agents/normalize";
import { runFormatting }              from "@/lib/agents/format";
import { resolveBrandForEnrichment, resolveMpnForEnrichment } from "@/lib/pipeline-utils";
import { discoverBrandFromMPN }               from "@/lib/agents/discover-brand";
import type { BrandDiscoveryResult }          from "@/lib/agents/discover-brand";
import type { ExtractedField }        from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StaticCategory = "fasteners" | "electrical_connectors";
type KnownCategory  = StaticCategory | "Built-In Dishwashers";

const STATIC_CATEGORIES: StaticCategory[] = ["fasteners", "electrical_connectors"];
const KNOWN_CATEGORIES:  KnownCategory[]  = ["fasteners", "electrical_connectors", "Built-In Dishwashers"];

function classpathToCategory(classpath: string): KnownCategory | null {
  const cp = classpath.toLowerCase();
  if (cp.includes("dishwasher")) return "Built-In Dishwashers";
  if (cp.includes("fastener") || cp.includes("bolt") || cp.includes("screw") || cp.includes("nut"))
    return "fasteners";
  if (cp.includes("connector") || cp.includes("terminal") || cp.includes("wiring"))
    return "electrical_connectors";
  return null;
}

function isKnownCategory(s: string): s is KnownCategory {
  return KNOWN_CATEGORIES.includes(s as KnownCategory);
}

function isStaticCategory(s: string): s is StaticCategory {
  return STATIC_CATEGORIES.includes(s as StaticCategory);
}

interface BatchProductInput {
  raw_text: string;
}

// ---------------------------------------------------------------------------
// Full pipeline for a single product (mirrors process-product/route.ts)
// ---------------------------------------------------------------------------
async function processSingleProduct(
  rawText: string,
  categoryHint: "fasteners" | "electrical_connectors" | "auto"
) {
  const pipelineWarnings: string[] = [];

  let finalExtractedFields: Record<string, ExtractedField> = {};
  let resolvedCategory: KnownCategory | "none" = "none";
  let classificationResult = null;

  // ── 1. Classification ─────────────────────────────────────────────────────
  try {
    classificationResult = await runClassification({ rawText });
    const mapped = classpathToCategory(classificationResult.classpath);
    resolvedCategory = mapped ?? "none";
  } catch (err) {
    pipelineWarnings.push(
      `Classification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // ── 2. Extraction ─────────────────────────────────────────────────────────
  let extractionResult;
  try {
    extractionResult = await runExtraction({
      rawText,
      category: isStaticCategory(resolvedCategory) ? resolvedCategory : categoryHint,
    });
  } catch (err) {
    throw new Error(
      `Extraction failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  finalExtractedFields = extractionResult.extracted_fields;
  const extractionNotes = extractionResult.notes ?? "";

  // If classification didn't resolve a category, fall back to extraction's guess
  if (resolvedCategory === "none") {
    resolvedCategory = isKnownCategory(extractionResult.schema_match)
      ? extractionResult.schema_match
      : "none";
  }

  const isUnverified = !isKnownCategory(resolvedCategory);

  // ── 3. Validation (skipped if no known schema) ────────────────────────────
  let validationResult = null;
  if (isKnownCategory(resolvedCategory)) {
    try {
      validationResult = await runValidation(
        finalExtractedFields,
        resolvedCategory,
        classificationResult?.schema_fields ?? undefined
      );
    } catch (err) {
      pipelineWarnings.push(
        `Validation failed and was skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    pipelineWarnings.push(
      `schema_match is "${resolvedCategory}" — no schema available, validation skipped.`
    );
  }

  // ── 4. Gap Resolution (only for static categories) ───────────────────────
  let gapResolutionResult = null;
  if (isStaticCategory(resolvedCategory)) {
    try {
      gapResolutionResult = await runGapResolution(
        finalExtractedFields,
        validationResult,
        resolvedCategory
      );
    } catch (err) {
      pipelineWarnings.push(
        `Gap-resolution failed and was skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── 5. Brand Resolution + MPN-Based Discovery Fallback ────────────────
  let enrichmentResult = null;
  const brandResolved = resolveBrandForEnrichment(finalExtractedFields);
  const mpnResolved   = resolveMpnForEnrichment(finalExtractedFields);

  let finalBrand = brandResolved;
  let brandDiscoveryResult: BrandDiscoveryResult | null = null;

  if (!brandResolved) {
    brandDiscoveryResult = await discoverBrandFromMPN({
      mpn: mpnResolved?.mpn ?? rawText.slice(0, 20),
      productDescription: rawText,
    });
    if (brandDiscoveryResult.discovered && brandDiscoveryResult.confidence !== "low") {
      finalBrand = {
        name: brandDiscoveryResult.manufacturerName ?? brandDiscoveryResult.brandName ?? "",
        sourceKey: "mpn_web_search",
      };
    }
  }

  const manuf = finalBrand?.name;
  const mpn   = mpnResolved?.mpn;

  // ── 6. Enrichment ────────────────────────────────────────────────────
  if (manuf && mpn) {
    try {
      enrichmentResult = await runEnrichment({ manufacturerName: manuf, partNumber: mpn });
    } catch (err) {
      console.error(`[batch-enrich-error] MPN=${mpn} | Full error:`, err);
      pipelineWarnings.push(
        `Enrichment failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    pipelineWarnings.push(
      `Enrichment skipped: could not resolve brand (${finalBrand?.sourceKey ?? "none"}) or MPN (${mpnResolved?.sourceKey ?? "none"}) from extracted fields.`
    );
  }

  console.log(`[diag] MPN=${mpn} | resolveBrand=${brandResolved?.name ?? "null"} (${brandResolved?.sourceKey ?? "-"}) | discoveryRan=${!brandResolved} | discoveryResult=${brandDiscoveryResult?.discovered ?? "n/a"} (${brandDiscoveryResult?.confidence ?? "-"}) | finalBrand=${finalBrand?.name ?? "null"} | manufForEnrich="${manuf}" | enrichAttempted=${!!manuf && !!mpn} | officialDataFound=${enrichmentResult?.officialDataFound ?? "n/a"} | domainFound=${enrichmentResult?.discoveredDomain ?? "n/a"} | specsFound=${enrichmentResult?.extractedAttributes ? Object.keys(enrichmentResult.extractedAttributes).length : 0}`);

  // ── 6. Normalization ──────────────────────────────────────────────────────
  let normalizationResult = null;
  if (!isUnverified) {
    try {
      normalizationResult = await runNormalization(finalExtractedFields);
      finalExtractedFields = normalizationResult.normalized_fields;
    } catch (err) {
      pipelineWarnings.push(
        `Normalization failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── 7. Formatting ─────────────────────────────────────────────────────────
  let formattingResult = null;
  if (!isUnverified && normalizationResult) {
    try {
      formattingResult = await runFormatting({
        normalizedFields:     finalExtractedFields,
        classificationResult: classificationResult ?? undefined,
        officialSourceData:   enrichmentResult?.extractedAttributes ?? undefined,
        resolvedBrand:        finalBrand,
        resolvedManufacturer: finalBrand,
        sourceUrl:            enrichmentResult?.sourceUrl,
        referenceUrls:        enrichmentResult?.referenceUrls,
      });
      console.log(`[format-debug] MPN=${mpn} formatting SUCCEEDED - delivery_columns count: ${formattingResult?.delivery_columns?.length ?? 0}, delivery_record keys: ${Object.keys(formattingResult?.delivery_record ?? {}).length}`);
    } catch (err) {
      console.error(`[format-debug] MPN=${mpn} formatting FAILED:`, err);
      pipelineWarnings.push(
        `Formatting failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    schema_match:          resolvedCategory,
    extracted_fields:      finalExtractedFields,
    extraction_notes:      extractionNotes,
    validation_result:     validationResult,
    gap_resolution:        gapResolutionResult,
    enrichment_result:     enrichmentResult,
    classification_result: classificationResult,
    normalization_result:  normalizationResult,
    delivery_formats:      formattingResult?.delivery_formats ?? null,
    delivery_record:       formattingResult?.delivery_record   ?? null,
    delivery_columns:      formattingResult?.delivery_columns  ?? [],
    is_unverified:         isUnverified,
    pipeline_warnings:     pipelineWarnings,
    brand_discovery:       brandDiscoveryResult ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let body: {
    products?: BatchProductInput[];
    batch_id?: string;
    categoryHint?: "fasteners" | "electrical_connectors" | "auto";
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { products, batch_id = `batch-${Date.now()}`, categoryHint = "auto" } = body;

  console.log(`[batch-debug] TAVILY_API_KEY is loaded: ${!!process.env.TAVILY_API_KEY}`);

  console.log(
    "Backend received products in process-batch route:",
    JSON.stringify(products, null, 2)
  );

  if (!products || !Array.isArray(products) || products.length === 0) {
    return NextResponse.json(
      { error: "Missing or empty products array." },
      { status: 400 }
    );
  }

  const results: any[] = [];

  // Process sequentially (concurrency=1) to avoid Groq TPM limits
  for (let index = 0; index < products.length; index++) {
    const item = products[index];
    try {
      const pipelineOut = await processSingleProduct(item.raw_text, categoryHint);

      // Calculate Product Health Score
      let healthScore = 100;
      const flags = pipelineOut.validation_result?.flags ?? [];
      for (const flag of flags) {
        if (flag.severity === "error") {
          healthScore -= 15;
        } else if (flag.severity === "warning" || flag.severity === "missing") {
          healthScore -= 5;
        }
      }

      const gapAsks = pipelineOut.gap_resolution?.gap_asks ?? [];
      // Use schema_fields from classify to distinguish required vs optional gaps
      const requiredFieldKeys = new Set(
        (pipelineOut.classification_result?.schema_fields ?? [])
          .filter((f: any) => f.required)
          .map((f: any) => f.key as string)
      );
      for (const ask of gapAsks) {
        if (requiredFieldKeys.has(ask.field)) {
          healthScore -= 10;
        } else {
          healthScore -= 3;
        }
      }

      healthScore = Math.max(0, healthScore);

      results.push({
        index,
        input: item.raw_text,
        status: "success",
        health_score: healthScore,
        ...pipelineOut,
      });
    } catch (err) {
      results.push({
        index,
        input: item.raw_text,
        status: "error",
        health_score: 0,
        error: err instanceof Error ? err.message : String(err),
        schema_match: "none",
        extracted_fields: {},
        extraction_notes: "",
        validation_result: null,
        gap_resolution: null,
        enrichment_result: null,
        classification_result: null,
        normalization_result: null,
        delivery_formats: null,
        delivery_record: null,
        is_unverified: true,
        pipeline_warnings: [String(err)],
      });
    }
  }

  // Sort results back to original order
  results.sort((a, b) => a.index - b.index);

  // Compute Aggregates
  let totalHealth = 0;
  let validCount = 0;
  let flaggedCount = 0;
  let invalidCount = 0;
  let totalGapAsks = 0;

  for (const res of results) {
    totalHealth += res.health_score;
    const vStatus = res.validation_result?.overall_status ?? "valid";
    if (vStatus === "valid") validCount++;
    else if (vStatus === "flagged") flaggedCount++;
    else if (vStatus === "invalid") invalidCount++;

    totalGapAsks += res.gap_resolution?.gap_asks?.length ?? 0;
  }

  const avgHealthScore =
    results.length > 0 ? Math.round(totalHealth / results.length) : 100;

  // Sorted copy (worst-first) for the dashboard breakdown
  const sortedProducts = [...results].sort((a, b) => a.health_score - b.health_score);

  return NextResponse.json(
    {
      batch_id,
      products: results,
      summary: {
        avg_health_score: avgHealthScore,
        validation_status_counts: {
          valid:   validCount,
          flagged: flaggedCount,
          invalid: invalidCount,
        },
        total_gap_asks: totalGapAsks,
        sorted_products: sortedProducts,
      },
    },
    { status: 200 }
  );
}
