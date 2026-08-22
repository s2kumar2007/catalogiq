/**
 * app/api/process-batch/route.ts
 * Batch Processing Orchestrator — CatalogIQ
 */

import { NextRequest, NextResponse } from "next/server";
import { runExtraction } from "@/lib/agents/extract";
import { runValidation } from "@/lib/agents/validate";
import { runGapResolution } from "@/lib/agents/gap-resolve";
import type { SchemaCategory, ExtractedField } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type KnownCategory = "fasteners" | "electrical_connectors";
const KNOWN_CATEGORIES: KnownCategory[] = ["fasteners", "electrical_connectors"];

function isKnownCategory(s: string): s is KnownCategory {
  return KNOWN_CATEGORIES.includes(s as KnownCategory);
}

interface BatchProductInput {
  raw_text: string;
}

// ---------------------------------------------------------------------------
// Helper to execute single product pipeline
// ---------------------------------------------------------------------------
async function processSingleProduct(rawText: string, categoryHint: "fasteners" | "electrical_connectors" | "auto") {
  const pipelineWarnings: string[] = [];

  // 1. Extraction
  const extractionResult = await runExtraction({
    rawText,
    category: categoryHint,
  });

  // 2. Resolve Category
  let resolvedCategory: SchemaCategory = "none";
  if (categoryHint !== "auto" && isKnownCategory(categoryHint)) {
    resolvedCategory = categoryHint;
  } else {
    resolvedCategory = extractionResult.schema_match as SchemaCategory;
  }

  // 3. Validation
  const isUnverified = !isKnownCategory(resolvedCategory);
  let validationResult = null;

  if (!isUnverified) {
    try {
      validationResult = await runValidation(
        extractionResult.extracted_fields,
        resolvedCategory as KnownCategory
      );
    } catch (err) {
      pipelineWarnings.push(
        `Validation failed and was skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 4. Gap Resolution
  let gapResolutionResult = null;
  if (!isUnverified) {
    try {
      gapResolutionResult = await runGapResolution(
        extractionResult.extracted_fields,
        validationResult,
        resolvedCategory as KnownCategory
      );
    } catch (err) {
      pipelineWarnings.push(
        `Gap-resolution failed and was skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    schema_match: resolvedCategory,
    extracted_fields: extractionResult.extracted_fields,
    extraction_notes: extractionResult.notes ?? "",
    validation_result: validationResult,
    gap_resolution: gapResolutionResult,
    is_unverified: isUnverified,
    pipeline_warnings: pipelineWarnings,
  };
}

// ---------------------------------------------------------------------------
// Helper to parse required/optional schema flags for gap scoring
// ---------------------------------------------------------------------------
function getRequiredFields(category: SchemaCategory): Set<string> {
  void category;
  return new Set<string>();
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

  console.log("Backend received products in process-batch route:", JSON.stringify(products, null, 2));

  if (!products || !Array.isArray(products) || products.length === 0) {
    return NextResponse.json(
      { error: "Missing or empty products array." },
      { status: 400 }
    );
  }

  const results: any[] = [];
  const limit = 3;
  const queue = [...products];

  // Process the queue with max concurrency of 3
  const workers = Array(Math.min(limit, queue.length))
    .fill(null)
    .map(async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        const index = products.indexOf(item);

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
          const requiredFields = getRequiredFields(pipelineOut.schema_match);

          for (const ask of gapAsks) {
            if (requiredFields.has(ask.field)) {
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
            is_unverified: true,
            pipeline_warnings: [String(err)],
          });
        }
      }
    });

  await Promise.all(workers);

  // Sort results to align back to original order, then sort by health score ascending for summary list
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

  const avgHealthScore = results.length > 0 ? Math.round(totalHealth / results.length) : 100;

  // Make a shallow copy of success results sorted by health score ascending
  const sortedProducts = [...results].sort((a, b) => a.health_score - b.health_score);

  return NextResponse.json(
    {
      batch_id,
      products: results,
      summary: {
        avg_health_score: avgHealthScore,
        validation_status_counts: {
          valid: validCount,
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
