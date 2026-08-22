/**
 * scripts/unilog-enrich.ts
 *
 * CatalogIQ — Full LLM Pipeline: Batch Enrichment & Demo Output Generator
 *
 * RUN:
 *   npx ts-node --project tsconfig.scripts.json scripts/unilog-enrich.ts
 *
 * What this does (one clear pipeline, no regex shortcut):
 *   For each input row from the Input CSV:
 *     1. classify.ts  → Groq: determine classpath + category-specific schema_fields
 *     2. extract.ts   → Groq: extract field values using those schema_fields
 *     3. normalize.ts → canonicalize names, fix UOM spacing, drop placeholders
 *     4. format.ts    → assemble Unilog delivery record with dynamic attributes
 *
 * The old unilog-enrich.js (regex-only, no LLM, no attributes) is replaced by this.
 * unilog-format.js is still used for delivery column assembly, CSV structure, and
 * description truncation — but attributeTriples() is gone; attributes come from step 1-3.
 *
 * Rate limiting: rows are processed sequentially with a short delay between LLM calls.
 * For 1000 rows this is slow (~3-5 min); the script logs progress per-row.
 *
 * NOTE: The expected output CSV is loaded ONLY for:
 *   a) Building the delivery column schema (column names, not values)
 *   b) Post-hoc evaluation scoring AFTER all pipeline runs complete
 * It is NEVER passed into the pipeline as input. Ground-truth MPNs are excluded
 * from the accuracy metric (see evaluation section at the bottom).
 */
import { runEnrichment } from "../lib/agents/enrich";
import * as fs from "fs";
import * as path from "path";
import { loadEnvConfig } from "@next/env";

// Load Next.js environment variables (.env.local) so GROQ_API_KEY is available
loadEnvConfig(process.cwd());

// ── LLM agent imports (TypeScript, resolved via tsconfig paths @/*) ──────────
import { runClassification } from "../lib/agents/classify";
import { runExtraction }     from "../lib/agents/extract";
import { runNormalization }  from "../lib/agents/normalize";
import { runFormatting }     from "../lib/agents/format";
import { resolveBrandForEnrichment, resolveMpnForEnrichment } from "../lib/pipeline-utils";

// ── unilog-format.js utility imports (CommonJS, required via moduleResolution) ─
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Papa = require("papaparse");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildUnilogDeliveryRecord,
  loadDeliverySchema,
  buildCategoryExamples,
} = require("../lib/unilog-format");

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT       = process.cwd();
const INPUT      = path.join(ROOT, "Data", "Unihack_ Sample Dataset - Input.csv");
const FORMAT     = path.join(ROOT, "Data", "Unihack_ Expected Output - Delivery Format (1).csv");
const OUT_DIR    = path.join(ROOT, "outputs");
const OUTPUT_CSV = path.join(OUT_DIR, "catalogiq_unilog_delivery.csv");
const REPORT_JSON= path.join(OUT_DIR, "catalogiq_unilog_report.json");

// ── Rate limiting ─────────────────────────────────────────────────────────────
const DELAY_MS = 12000; // keep Groq free-tier TPM usage stable across multi-call rows
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── CSV reading ───────────────────────────────────────────────────────────────
function readCsv(file: string): { data: Record<string, string>[]; errors: unknown[] } {
  const parsed = Papa.parse(fs.readFileSync(file, "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    console.warn(`[csv] ${file}: ${parsed.errors.length} parse warnings`);
  }
  return parsed;
}

// ── Ground truth scoring helpers ──────────────────────────────────────────────
function extractGroundTruthAttributes(row: Record<string, string>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (let i = 1; i <= 50; i++) {
    const label = row[`ATTRIBUTE_LABEL ${i}`];
    const value = row[`ATTRIBUTE_VALUE ${i}`];
    const uom   = row[`ATTRIBUTE_UOM ${i}`];
    if (label && label.trim()) {
      attrs[label.trim()] = `${value ?? ""}${uom ? " " + uom : ""}`.trim();
    }
  }
  attrs["MOBILE_DESC"]  = row["MOBILE_DESC"]  ?? "";
  attrs["SHORT_DESC"]   = row["SHORT_DESC"]   ?? "";
  attrs["LONG_DESC1"]   = row["LONG_DESC1"]   ?? "";
  attrs["INVOICE_DESC"] = row["INVOICE_DESC"] ?? "";
  attrs["Classpath"]    = row["Classpath"]    ?? "";
  return attrs;
}

function fieldAccuracy(
  predicted: Record<string, string>,
  groundTruth: Record<string, string>
): { matched: number; total: number; mismatches: string[] } {
  let matched = 0;
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(groundTruth)) {
    if (!expected) continue;
    const got = predicted[key] ?? "";
    if (got.toLowerCase().trim() === expected.toLowerCase().trim()) {
      matched++;
    } else {
      mismatches.push(`  ${key}: expected "${expected}" | got "${got}"`);
    }
  }
  return {
    matched,
    total: Object.keys(groundTruth).filter((k) => groundTruth[k]).length,
    mismatches,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("==========================================");
  console.log("CatalogIQ — LLM Pipeline: Batch Enrichment");
  console.log("==========================================\n");

  if (!fs.existsSync(INPUT))  { console.error(`Missing input:  ${INPUT}`);  process.exit(1); }
  if (!fs.existsSync(FORMAT)) { console.error(`Missing format: ${FORMAT}`); process.exit(1); }

  // Load delivery schema for column names (NOT for GT values — only column headers used)
  const schema = loadDeliverySchema(FORMAT);
  const inputCsv = readCsv(INPUT);
  let inputRows: Record<string, string>[] = inputCsv.data;

  // Load expected output for (a) column names, (b) post-hoc scoring only
  const outputCsv = readCsv(FORMAT);
  const outputRows: Record<string, string>[] = outputCsv.data;

  // ── Parse CLI arguments (e.g., --mfr=frigidaire) ────────────────────────────
  const args = process.argv.slice(2);
  const mfrFilter = args.find((a) => a.startsWith("--mfr="))?.split("=")[1]?.toLowerCase();
  
  if (mfrFilter) {
    console.log(`\n[FILTER] Applying filter: --mfr="${mfrFilter}"`);
    inputRows = inputRows.filter((row) => {
      const manuf = (row["Part_Manuf"] ?? row["MANUFACTURER_NAME"] ?? "").toLowerCase();
      const brand = (row["E1_Brand"] ?? "").toLowerCase();
      const desc  = (row["Part_Desc"] ?? "").toLowerCase();
      return manuf.includes(mfrFilter) || brand.includes(mfrFilter) || desc.includes(mfrFilter);
    });
  }

  // Build ground-truth index: MPN → attributes
  // IMPORTANT: This is ONLY used for post-hoc scoring AFTER the pipeline runs.
  // It is never passed into runClassification, runExtraction, or runFormatting.
  const groundTruthByMPN: Record<string, Record<string, string>> = {};
  for (const row of outputRows) {
    const mpn = (row["Mfg_Part_Num"] ?? row["MANUFACTURER_PART_NUMBER"] ?? "").trim();
    if (mpn) groundTruthByMPN[mpn] = extractGroundTruthAttributes(row);
  }
  const knownMPNs = new Set(Object.keys(groundTruthByMPN));

  console.log(`Input rows:      ${inputRows.length}`);
  console.log(`Known GT MPNs:   ${knownMPNs.size} (excluded from accuracy metric; reported separately)`);
  console.log(`Delivery cols:   ${schema.columns.length}`);
  console.log(`\nStarting pipeline (sequential, ~${DELAY_MS}ms delay between rows)...\n`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const enriched: { record: Record<string, string>; trace: Record<string, unknown> }[] = [];

  // Track results for evaluation
  const blindResults:     { mpn: string; accuracy: number; mismatches: string[] }[] = [];
  const spotCheckResults: { mpn: string; accuracy: number; mismatches: string[] }[] = [];
  const errorRows:        { mpn: string; error: string }[] = [];

  for (let i = 0; i < inputRows.length; i++) {
    const row   = inputRows[i];
    const mpn   = (row["Mfg_Part_Num"] ?? "").trim();
    const desc  = (row["Part_Desc"]    ?? "").trim();
    const manuf = (row["Part_Manuf"]   ?? row["MANUFACTURER_NAME"] ?? "").trim();
    const brand = (row["E1_Brand"]     ?? "").trim();

    const isKnownMPN = knownMPNs.has(mpn);
    const flag = isKnownMPN ? " [SPOT-CHECK ONLY]" : "";
    console.log(`[${i + 1}/${inputRows.length}] ${mpn} — ${desc.slice(0, 55)}${flag}`);

    const rawText = [
      mpn   ? `Part Number: ${mpn}`   : null,
      desc  ? `Description: ${desc}`  : null,
      brand ? `Brand: ${brand}`       : null,
      manuf ? `Manufacturer: ${manuf}`: null,
    ].filter(Boolean).join("\n");

    try {
      // ── Stage 1: Classify (LLM) ─────────────────────────────────────────
      const classResult = await runClassification({ rawText });
      console.log(`  → classify: ${classResult.classpath} (${classResult.confidence}%, ${classResult.schema_fields.length} fields)`);

            // ── Stage 2: Extract using LLM-generated schema fields ───────────────
      const extractResult = await runExtraction({
        rawText,
        category: "auto",
        schemaFields: classResult.schema_fields,  // ← wired from classify
      });
      const fieldCount = Object.keys(extractResult.extracted_fields ?? {}).length;
      console.log(`  → extract: ${fieldCount} fields`);

      // ── Stage 3: Enrich (manufacturer-site-only live search) ─────────────
      const brandResolved = resolveBrandForEnrichment(extractResult.extracted_fields || {});
      const mpnResolved   = resolveMpnForEnrichment(extractResult.extracted_fields || {});
      const manufForEnrich = brandResolved?.name || manuf || "";
      const mpnForEnrich   = mpnResolved?.mpn || mpn;

      let enrichmentResult;
      try {
        if (!manufForEnrich || !mpnForEnrich) {
            throw new Error(`Enrichment skipped: missing brand or mpn`);
        }
        enrichmentResult = await runEnrichment({
          manufacturerName: manufForEnrich,
          partNumber: mpnForEnrich,
        });
        console.log(`  → enrich: ${enrichmentResult.officialDataFound ? "✓" : "✗"} ${enrichmentResult.status}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  → enrich: error — ${msg}`);
        enrichmentResult = { officialDataFound: false, status: `needs review - enrichment threw: ${msg}` };
      }

      // ── Stage 4: Normalize ───────────────────────────────────────────────
      const normResult = await runNormalization(extractResult.extracted_fields);

      // ── Stage 5: Format (dynamic attributes + official source data) ──────
      const fmtResult = await runFormatting({
        normalizedFields: normResult.normalized_fields,
        classificationResult: classResult,    // ← provides schema_fields for attribute mapping
        officialSourceData: enrichmentResult.officialDataFound
          ? enrichmentResult.extractedAttributes
          : undefined,
      });

      // Overlay the original input row fields for pass-through columns
      const deliveryRecord = {
        ...fmtResult.delivery_record,
        Mfg_Part_Num: row["Mfg_Part_Num"] ?? "",
        Part_Desc:    row["Part_Desc"]    ?? "",
        E1_Brand:     row["E1_Brand"]     ?? "",
        Unilog_Brand: row["Unilog_Brand"] ?? "",
        DIB_Brand:    row["DIB_Brand"]    ?? "",
        Part_Manuf:   row["Part_Manuf"]   ?? "",
      };

      enriched.push({
        record: deliveryRecord,
        trace: {
          ...fmtResult.trace,
          mpn,
          classpath: classResult.classpath,
          classify_confidence: classResult.confidence,
          schema_fields: classResult.schema_fields.map((f) => f.label),
          attribute_count: fmtResult.delivery_formats.attributes?.length ?? 0,
          is_known_mpn: isKnownMPN,
          enrichment_status: enrichmentResult.status,
          enrichment_source_url: enrichmentResult.sourceUrl ?? null,
        },
      });

      // ── Post-hoc scoring ─────────────────────────────────────────────────
      const predictedAttrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(normResult.normalized_fields)) {
        predictedAttrs[k] = String(v.value);
      }
      predictedAttrs["MOBILE_DESC"]  = fmtResult.delivery_formats.mobile_desc  ?? "";
      predictedAttrs["SHORT_DESC"]   = fmtResult.delivery_formats.short_desc   ?? "";
      predictedAttrs["LONG_DESC1"]   = fmtResult.delivery_formats.long_desc    ?? "";
      predictedAttrs["INVOICE_DESC"] = fmtResult.delivery_formats.invoice_desc ?? "";
      predictedAttrs["Classpath"]    = classResult.classpath;

      if (groundTruthByMPN[mpn]) {
        const score = fieldAccuracy(predictedAttrs, groundTruthByMPN[mpn]);
        const pct   = score.total > 0 ? ((score.matched / score.total) * 100).toFixed(1) : "N/A";
        console.log(`  → ${isKnownMPN ? "spot-check" : "blind"} score: ${pct}% (${score.matched}/${score.total})`);

        const entry = { mpn, accuracy: score.total > 0 ? score.matched / score.total : 0, mismatches: score.mismatches };
        if (isKnownMPN) {
          spotCheckResults.push(entry);
        } else {
          blindResults.push(entry);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ERROR: ${errMsg}`);
      errorRows.push({ mpn, error: errMsg });
      // Push a blank record so column count stays consistent
      const blankRecord = Object.fromEntries(schema.columns.map((c: string) => [c, ""]));
      blankRecord["Mfg_Part_Num"] = mpn;
      blankRecord["Part_Desc"]    = desc;
      enriched.push({ record: blankRecord, trace: { mpn, error: errMsg } });
    }

    // Rate limiting
    if (i < inputRows.length - 1) await sleep(DELAY_MS);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // ── Write delivery CSV ────────────────────────────────────────────────────
  const csvOut = Papa.unparse(enriched.map((e) => e.record), { columns: schema.columns });
  fs.writeFileSync(OUTPUT_CSV, csvOut, "utf8");
  console.log(`\n✓ Wrote ${enriched.length} delivery rows → ${OUTPUT_CSV}`);

  // ── Evaluation report ─────────────────────────────────────────────────────
  // Accuracy metric: BLIND rows only (MPNs not in ground truth)
  // Known MPNs: reported separately as spot-check examples, NOT as the accuracy number
  const blindAvg = blindResults.length > 0
    ? blindResults.reduce((s, r) => s + r.accuracy, 0) / blindResults.length
    : null;
  const spotAvg = spotCheckResults.length > 0
    ? spotCheckResults.reduce((s, r) => s + r.accuracy, 0) / spotCheckResults.length
    : null;

  const report = {
    generated_at: new Date().toISOString(),
    pipeline: "llm_full: classify → extract → normalize → format",
    pipeline_note: "unilog-format.js used for delivery column assembly only; attributes from LLM",
    input_rows: inputRows.length,
    output_rows: enriched.length,
    output_columns: schema.columns.length,
    error_rows: errorRows.length,
    files: {
      input:           path.relative(ROOT, INPUT),
      delivery_format: path.relative(ROOT, FORMAT),
      output_csv:      path.relative(ROOT, OUTPUT_CSV),
    },
    // ── Credibility-clean accuracy metric ─────────────────────────────────
    // Blind rows: MPNs the pipeline has never seen in the answer key.
    // This is the REAL accuracy metric. Do not conflate with spot-check rows.
    blind_evaluation: {
      note: "THESE are the accuracy numbers — pipeline never saw ground truth for these MPNs",
      n: blindResults.length,
      avg_field_accuracy: blindAvg !== null ? `${(blindAvg * 100).toFixed(1)}%` : "N/A",
      rows: blindResults.map((r) => ({
        mpn: r.mpn,
        accuracy: `${(r.accuracy * 100).toFixed(1)}%`,
        top_mismatches: r.mismatches.slice(0, 3),
      })),
    },
    spot_check_known_mpns: {
      note: "Known MPNs from the expected output — pipeline saw these in the delivery schema (column names), but NOT answer values. Reported separately to maintain scoring integrity.",
      n: spotCheckResults.length,
      avg_field_accuracy: spotAvg !== null ? `${(spotAvg * 100).toFixed(1)}%` : "N/A",
      rows: spotCheckResults.map((r) => ({
        mpn: r.mpn,
        accuracy: `${(r.accuracy * 100).toFixed(1)}%`,
        top_mismatches: r.mismatches.slice(0, 3),
      })),
    },
    // ── Category classification stats ─────────────────────────────────────
    category_detection: {
      strategy: "LLM classify (Groq) → classpath + schema_fields per product",
      gt_peek_removed: true,
      source_distribution: (() => {
        const counts: Record<string, number> = {};
        for (const e of enriched) {
          const src = String((e.trace as Record<string, unknown>)["category_source"] ?? "llm");
          counts[src] = (counts[src] ?? 0) + 1;
        }
        return counts;
      })(),
    },
    // ── Validation ────────────────────────────────────────────────────────
    validation: {
      schema_columns_preserved: enriched.every(({ record }) =>
        schema.columns.every((col: string) => Object.prototype.hasOwnProperty.call(record, col))
      ),
      invoice_desc_max_40: enriched.every(({ record }) =>
        String(record["INVOICE_DESC"] ?? "").length <= 40
      ),
      mobile_desc_max_80: enriched.every(({ record }) =>
        String(record["MOBILE_DESC"] ?? "").length <= 80
      ),
      no_expected_output_exact_mpn_source: enriched.every(({ trace }) => {
        const src = (trace as Record<string, unknown>)["category_source"];
        return src !== "expected_output_exact_mpn";
      }),
    },
    // ── Trace samples ────────────────────────────────────────────────────
    trace_sample: enriched.slice(0, 10).map((e) => e.trace),
    error_row_details: errorRows,
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf8");
  console.log(`✓ Wrote report → ${REPORT_JSON}`);

  // ── Summary to stdout ─────────────────────────────────────────────────────
  console.log("\n==========================================");
  console.log("RESULTS");
  console.log("==========================================");
  console.log(`\nBLIND ACCURACY (n=${blindResults.length} rows — the real metric):`);
  console.log(`  Avg field accuracy: ${blindAvg !== null ? (blindAvg * 100).toFixed(1) + "%" : "N/A (no blind rows with GT)"}`);
  console.log(`\nSPOT-CHECK / KNOWN MPNs (n=${spotCheckResults.length} rows — NOT the metric):`);
  console.log(`  Avg field accuracy: ${spotAvg !== null ? (spotAvg * 100).toFixed(1) + "%" : "N/A"}`);
  console.log(`\nErrors: ${errorRows.length} rows`);
  console.log(`\nGT-LEAK GUARD (no expected_output_exact_mpn):`, report.validation.no_expected_output_exact_mpn_source ? "✓ PASS" : "✗ FAIL — INVESTIGATE");
  console.log("\n==========================================");
  console.log("COMPLETE");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
