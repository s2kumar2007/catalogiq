/**
 * app/api/process-product/route.ts
 * Main Orchestrator — CatalogIQ
 *
 * Single entry point for the full pipeline:
 *   1. Extract   → Gemini (lib/agents/extract.ts)
 *   2. Validate  → Groq   (lib/agents/validate.ts)  [skipped if schema_match = "none"]
 *
 * Accepts multipart/form-data (from the upload page) OR application/json.
 *
 * FormData fields:    text?, file?, category?
 * JSON body fields:   rawText?, fileContent?, categoryHint?
 *
 * Response:
 * {
 *   schema_match:       string,
 *   extracted_fields:   Record<string, ExtractedField>,
 *   extraction_notes:   string,
 *   validation_result:  ValidationResultExtended | null,
 *   is_unverified:      boolean,   // true when schema_match = "none"
 *   pipeline_warnings:  string[]   // non-fatal issues (e.g. validation failed but extraction OK)
 * }
 */

import { NextRequest, NextResponse }  from "next/server";
import { runExtraction }              from "@/lib/agents/extract";
import { runValidation }              from "@/lib/agents/validate";
import { runGapResolution }           from "@/lib/agents/gap-resolve";
import { runReconciliation }          from "@/lib/agents/reconcile";
import { runEnrichment }              from "@/lib/agents/enrich";
import { runClassification }          from "@/lib/agents/classify";
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
type KnownCategory = StaticCategory | "Built-In Dishwashers";
const STATIC_CATEGORIES: StaticCategory[] = ["fasteners", "electrical_connectors"];
const KNOWN_CATEGORIES: KnownCategory[] = ["fasteners", "electrical_connectors", "Built-In Dishwashers"];

/** Map a classification classpath string to a KnownCategory or return null */
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

interface SourcePayload {
  source_name: string;
  source_type: "manufacturer_pdf" | "ecommerce_listing" | "scraped_page";
  raw_text: string;
}

/**
 * Reads the request body regardless of whether it arrives as
 * multipart/form-data (upload page) or application/json (API callers).
 */
async function parseRequest(req: NextRequest): Promise<{
  rawText?: string;
  imageBase64?: string;
  categoryHint: "fasteners" | "electrical_connectors" | "auto";
  sources?: SourcePayload[];
}> {
  const contentType = req.headers.get("content-type") ?? "";

  // ── FormData (from the upload page) ────────────────────────────────────
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();

    const textField     = form.get("text");
    const categoryField = form.get("category");
    const fileField     = form.get("file");

    let rawText: string | undefined = undefined;
    let imageBase64: string | undefined = undefined;

    // Text input
    if (typeof textField === "string" && textField.trim()) {
      rawText = textField.trim();
    }

    // File input
    if (fileField instanceof File) {
      const mimeType = fileField.type;

      if (mimeType.startsWith("image/")) {
        // Convert to base64 data URL for Gemini multimodal
        const arrayBuffer = await fileField.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        imageBase64 = `data:${mimeType};base64,${base64}`;
      } else {
        // Plain text / PDF: read as text
        rawText = await fileField.text();
      }
    }

    const rawCategory = typeof categoryField === "string" ? categoryField : "auto";
    const categoryHint =
      rawCategory === "fasteners" || rawCategory === "electrical_connectors"
        ? rawCategory
        : "auto";

    return { rawText, imageBase64, categoryHint };
  }

  // ── JSON body (API callers, tests) ──────────────────────────────────────
  const body: {
    rawText?: string;
    fileContent?: string;
    categoryHint?: string;
    sources?: SourcePayload[];
  } = await req.json();

  const categoryHint =
    body.categoryHint === "fasteners" || body.categoryHint === "electrical_connectors"
      ? body.categoryHint
      : "auto";

  return {
    rawText: body.rawText ?? body.fileContent,
    categoryHint,
    sources: body.sources,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const pipelineWarnings: string[] = [];

  // ── 1. Parse request ──────────────────────────────────────────────────────
  let rawText: string | undefined;
  let imageBase64: string | undefined;
  let categoryHint: "fasteners" | "electrical_connectors" | "auto";
  let sources: SourcePayload[] | undefined;

  try {
    ({ rawText, imageBase64, categoryHint, sources } = await parseRequest(req));
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to parse request: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }

  const isMultiSource = sources && Array.isArray(sources) && sources.length > 0;

  if (!rawText && !imageBase64 && !isMultiSource) {
    return NextResponse.json(
      { error: "No content provided. Send text, fileContent, a file upload, or sources." },
      { status: 400 }
    );
  }

  let finalExtractedFields: Record<string, ExtractedField> = {};
  let finalNotes = "";
  let resolvedCategory: KnownCategory | "none" = "none";
  let reconciliationResult = null;
  let classificationResult = null;

  // ── 2. Classification (Stage 3) ─────────────────────────────────────────────
  // Run Classification FIRST to determine the correct schema
  if (rawText) {
    try {
      classificationResult = await runClassification({ rawText });
      const mapped = classpathToCategory(classificationResult.classpath);
      if (mapped) {
        resolvedCategory = mapped;
      } else {
        // Organic fallback — category unknown, validation will be skipped
        resolvedCategory = "none";
      }
    } catch (err) {
      pipelineWarnings.push(`Classification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 3. Extraction & Optional Reconciliation ──────────────────────────────
  if (isMultiSource && sources) {
    try {
      // Parallel extraction calls for speed
      const extractionPromises = sources.map(async (src) => {
        const ext = await runExtraction({
          rawText: src.raw_text,
          category: categoryHint,
        });
        return {
          source_name: src.source_name,
          source_type: src.source_type,
          extraction_result: ext,
        };
      });

      const extractedSources = await Promise.all(extractionPromises);

      // Perform source reconciliation
      const runReconciliationResult = await runReconciliation(extractedSources);
      reconciliationResult = runReconciliationResult;

      // Extract resolved category from first successful match, or fallback
      const matchedCategories = extractedSources
        .map((s) => s.extraction_result.schema_match)
        .filter((c) => c !== "none");
      const firstMatch = matchedCategories[0] ?? "none";
      resolvedCategory = isKnownCategory(firstMatch) ? firstMatch : "none";

      // Map reconciled_fields to match the standard extracted_fields format
      finalExtractedFields = Object.entries(runReconciliationResult.reconciled_fields).reduce(
        (acc, [key, f]: [string, any]) => {
          acc[key] = {
            value: f.value,
            confidence: f.confidence,
            source_location: f.source_location,
            extraction_method: f.resolution_type === "single_source" ? "explicit" : "inferred",
          };
          return acc;
        },
        {} as Record<string, ExtractedField>
      );

      finalNotes = runReconciliationResult.summary;
    } catch (err) {
      return NextResponse.json(
        {
          error: `Multi-source pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
          stage: "reconciliation",
        },
        { status: 502 }
      );
    }
  } else {
    // ── Single-Source Flow ──────────────────────────────────────────────────
    let extractionResult;
    try {
      // Use the dynamically resolved category from Classification, not the static hint
      extractionResult = await runExtraction({
        rawText,
        imageBase64,
        category: isStaticCategory(resolvedCategory) ? resolvedCategory : categoryHint,
      });
    } catch (err) {
      return NextResponse.json(
        {
          error: `Extraction failed: ${err instanceof Error ? err.message : String(err)}`,
          stage: "extraction",
        },
        { status: 502 }
      );
    }

    finalExtractedFields = extractionResult.extracted_fields;
    finalNotes = extractionResult.notes ?? "";

    // If classification found a category, we already have resolvedCategory. 
    // If not, we fall back to what extraction guessed.
    if (resolvedCategory === "none") {
      resolvedCategory = isKnownCategory(extractionResult.schema_match)
        ? extractionResult.schema_match
        : "none";
    }
  }

  // ── 4. Validation (skipped if no known schema) ────────────────────────────
  const isUnverified = !isKnownCategory(resolvedCategory);
  let validationResult = null;

  if (isKnownCategory(resolvedCategory)) {
    try {
      validationResult = await runValidation(
        finalExtractedFields,
        resolvedCategory,
        // Pass LLM-generated schema fields (used for dishwasher; fasteners/connectors use static files)
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

  // ── 5. Gap Resolution ─────────────────────────────────────────────────────
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
        `Gap resolution failed and was skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── 6. Brand Resolution + MPN-Based Discovery Fallback ────────────────
  let enrichmentResult = null;
  const brandResolved = resolveBrandForEnrichment(finalExtractedFields);
  const mpnResolved   = resolveMpnForEnrichment(finalExtractedFields);

  let finalBrand = brandResolved;
  let finalBrandName = brandResolved?.name;
  let finalManufacturerName = brandResolved?.name;
  let brandDiscoveryResult: BrandDiscoveryResult | null = null;

  if (!brandResolved) {
    brandDiscoveryResult = await discoverBrandFromMPN({
      mpn: mpnResolved?.mpn ?? (rawText ?? "").slice(0, 20),
      productDescription: rawText ?? "",
    });
    if (brandDiscoveryResult.discovered && brandDiscoveryResult.confidence !== "low") {
      finalBrand = {
        name: brandDiscoveryResult.brandName ?? brandDiscoveryResult.manufacturerName ?? "",
        sourceKey: "mpn_web_search",
      };
      finalBrandName = brandDiscoveryResult.brandName ?? brandDiscoveryResult.manufacturerName;
      finalManufacturerName = brandDiscoveryResult.manufacturerName ?? brandDiscoveryResult.brandName;
    }
  }

  const manuf = finalBrand?.name;
  const mpn   = mpnResolved?.mpn;

  if (manuf && mpn) {
    try {
      enrichmentResult = await runEnrichment({ manufacturerName: manuf, partNumber: mpn });
    } catch (err) {
      pipelineWarnings.push(`Enrichment failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    pipelineWarnings.push(
      `Enrichment skipped: could not resolve brand (${finalBrand?.sourceKey ?? "none"}) or MPN (${mpnResolved?.sourceKey ?? "none"}) from extracted fields.`
    );
  }

  // (Classification moved to Stage 2)

  // ── 8. Normalization (Stage 6) ──────────────────────────────────────────────
  let normalizationResult = null;
  if (!isUnverified) {
    try {
      normalizationResult = await runNormalization(finalExtractedFields);
      // Update final fields with normalized values
      finalExtractedFields = normalizationResult.normalized_fields;
    } catch (err) {
      pipelineWarnings.push(`Normalization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 9. Formatting (Stage 7) ────────────────────────────────────────────────
  let formattingResult = null;
  if (!isUnverified && normalizationResult) {
    try {
      formattingResult = await runFormatting({
        normalizedFields: finalExtractedFields,
        classificationResult: classificationResult || undefined,
        officialSourceData: enrichmentResult?.officialDataFound ? enrichmentResult.extractedAttributes : undefined,
        resolvedBrand: finalBrand,
        resolvedManufacturer: finalManufacturerName
          ? { name: finalManufacturerName, sourceKey: finalBrand?.sourceKey ?? "resolved" }
          : null,
        sourceUrl: enrichmentResult?.sourceUrl,
        referenceUrls: enrichmentResult?.referenceUrls,
        productImageUrl: enrichmentResult?.productImageUrl,
        alternateImageUrls: enrichmentResult?.alternateImageUrls,
        specSheetUrl: enrichmentResult?.specSheetUrl,
      });
    } catch (err) {
      pipelineWarnings.push(`Formatting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 10. Return combined response ───────────────────────────────────────────
  return NextResponse.json(
    {
      schema_match:         resolvedCategory,
      extracted_fields:     finalExtractedFields,
      extraction_notes:     finalNotes,
      validation_result:    validationResult,
      gap_resolution:       gapResolutionResult,
      reconciliation_result: reconciliationResult,
      enrichment_result:    enrichmentResult,
      classification_result: classificationResult,
      normalization_result: normalizationResult,
      formatting_result:    formattingResult,
      delivery_formats:     formattingResult?.delivery_formats ?? null,
      delivery_record:      formattingResult?.delivery_record ?? null,
      delivery_columns:     formattingResult?.delivery_columns ?? [],
      brand_discovery:      brandDiscoveryResult ?? null,
      resolved_brand: {
        brand_name: finalBrandName ?? null,
        manufacturer_name: finalManufacturerName ?? null,
        source: finalBrand?.sourceKey ?? null,
      },
      is_unverified:        isUnverified,
      pipeline_warnings:    pipelineWarnings,
    },
    { status: 200 }
  );
}
