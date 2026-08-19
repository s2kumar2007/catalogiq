/**
 * scripts/evaluate.ts
 * Real evaluation against the Unilog Hackathon datasets.
 *
 * RUN:  npx ts-node --project tsconfig.json scripts/evaluate.ts
 *
 * What it does:
 *  1. Reads the 1000-row Input CSV and filters to dishwasher rows (n≈10)
 *  2. Reads the Expected Output CSV to get ground-truth rows (n=2 confirmed)
 *  3. Calls the classification + extraction + normalization pipeline for each row
 *  4. Scores n=2 rows on EXACT field-level accuracy vs ground truth
 *  5. Scores all n≈10 rows on FORMAT COMPLIANCE (char limits, UOM spacing, etc.)
 *  6. Reports both numbers separately to stdout
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ── Imports from lib (ts-node resolves via tsconfig paths) ───────────────────
import { runClassification } from "../lib/agents/classify";
import { runExtraction }     from "../lib/agents/extract";
import { runNormalization }  from "../lib/agents/normalize";
import { runFormatting }     from "../lib/agents/format";

// ── CSV parsing ───────────────────────────────────────────────────────────────
function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Handle quoted fields with commas inside
  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let inQuote = false;
    let current = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === "," && !inQuote) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h.trim()] = (values[i] ?? "").trim();
    });
    return row;
  });
}

// ── Ground truth field extraction from Expected Output row ───────────────────
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
  // Also capture description fields
  attrs["MOBILE_DESC"]  = row["MOBILE_DESC"]  ?? "";
  attrs["SHORT_DESC"]   = row["SHORT_DESC"]   ?? "";
  attrs["LONG_DESC1"]   = row["LONG_DESC1"]   ?? "";
  attrs["INVOICE_DESC"] = row["INVOICE_DESC"] ?? "";
  return attrs;
}

// ── Scoring helpers ───────────────────────────────────────────────────────────
function fieldAccuracy(
  predicted: Record<string, string>,
  groundTruth: Record<string, string>
): { matched: number; total: number; mismatches: string[] } {
  let matched = 0;
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(groundTruth)) {
    if (!expected) continue; // skip empty ground truth fields
    const got = predicted[key] ?? "";
    if (got.toLowerCase().trim() === expected.toLowerCase().trim()) {
      matched++;
    } else {
      mismatches.push(`  ${key}: expected "${expected}" | got "${got}"`);
    }
  }
  return { matched, total: Object.keys(groundTruth).filter((k) => groundTruth[k]).length, mismatches };
}

function checkCompliance(deliveryFormats: Record<string, string>): {
  mobileLenOk: boolean;
  uomSpacingOk: boolean;
  noPlaceholders: boolean;
} {
  const mobile = deliveryFormats["mobile_desc"] ?? "";
  const all    = Object.values(deliveryFormats).join(" ");
  const BAD_PLACEHOLDERS = ["-- Unbranded --", "-- No Unilog Brand --", "-- No DIB Brand --"];

  return {
    mobileLenOk:    mobile.length <= 80,
    uomSpacingOk:   !/\d[A-Za-z]/.test(all), // no digit immediately followed by letter (bad UOM)
    noPlaceholders: BAD_PLACEHOLDERS.every((p) => !all.includes(p)),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("==========================================");
  console.log("CatalogIQ — Real Pipeline Evaluation");
  console.log("==========================================\n");

  const inputPath  = path.join(process.cwd(), "Data", "Unihack_ Sample Dataset - Input.csv");
  const outputPath = path.join(process.cwd(), "Data", "Unihack_ Expected Output - Delivery Format (1).csv");

  if (!fs.existsSync(inputPath))  { console.error(`Missing: ${inputPath}`);  process.exit(1); }
  if (!fs.existsSync(outputPath)) { console.error(`Missing: ${outputPath}`); process.exit(1); }

  const inputRows  = parseCSV(inputPath);
  const outputRows = parseCSV(outputPath);

  // Filter input to dishwasher rows only
  const dishwasherInputRows = inputRows.filter((r) => {
    const desc = (r["Part_Desc"] ?? "").toLowerCase();
    return desc.includes("dishwasher");
  });

  console.log(`Input CSV total rows: ${inputRows.length}`);
  console.log(`Dishwasher rows found in input: ${dishwasherInputRows.length}`);
  console.log(`Expected Output rows (ground truth): ${outputRows.length - 1} valid\n`);

  // Ground truth: rows from Expected Output matched by MPN
  const groundTruthByMPN: Record<string, Record<string, string>> = {};
  for (const row of outputRows) {
    const mpn = row["Mfg_Part_Num"] ?? row["MANUFACTURER_PART_NUMBER"];
    if (mpn && mpn.trim()) {
      groundTruthByMPN[mpn.trim()] = extractGroundTruthAttributes(row);
    }
  }

  // ── Run pipeline on each dishwasher row ──────────────────────────────────
  const exactMatchResults: { mpn: string; accuracy: number; mismatches: string[] }[] = [];
  const complianceResults: { mpn: string; mobileLenOk: boolean; uomOk: boolean; noPlaceholders: boolean }[] = [];

  for (const row of dishwasherInputRows) {
    const mpn      = row["Mfg_Part_Num"] ?? "";
    const partDesc = row["Part_Desc"]    ?? "";
    const manuf    = row["Part_Manuf"]   ?? row["MANUFACTURER_NAME"] ?? "";

    // Build raw text for the pipeline from the input columns
    const rawText = [
      `Part Number: ${mpn}`,
      `Description: ${partDesc}`,
      `Brand: ${row["E1_Brand"] ?? ""}`,
      `Manufacturer: ${manuf}`,
    ].filter((l) => !l.endsWith(": ")).join("\n");

    console.log(`\nProcessing: ${mpn} — ${partDesc.slice(0, 60)}`);

    try {
      // Stage 3: Classify + generate schema
      const classResult = await runClassification({ rawText });
      console.log(`  Classpath: ${classResult.classpath} (confidence: ${classResult.confidence}%)`);

      // Stage 1: Extract using LLM-generated schema fields as guidance
      const schemaHint =
        classResult.schema_fields.length > 0
          ? `\nRequired attribute fields for this category:\n${classResult.schema_fields.map((f) => `- ${f.label}`).join("\n")}`
          : "";

      const extractResult = await runExtraction({
        rawText: rawText + schemaHint,
        category: "auto",
      });

      // Stage 6: Normalize
      const normResult = await runNormalization(extractResult.extracted_fields);

      // Stage 7: Format (delivery descriptions)
      const fmtResult = await runFormatting(normResult.normalized_fields);
      const formats   = fmtResult.delivery_formats;

      // Build predicted attributes map from normalized fields
      const predictedAttrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(normResult.normalized_fields)) {
        predictedAttrs[k] = String(v.value);
      }
      // Add delivery format fields
      predictedAttrs["MOBILE_DESC"]  = formats.mobile_desc  ?? "";
      predictedAttrs["SHORT_DESC"]   = formats.short_desc   ?? "";
      predictedAttrs["LONG_DESC1"]   = formats.long_desc    ?? "";

      // Compliance check (all rows)
      const compliance = checkCompliance({
        mobile_desc: formats.mobile_desc ?? "",
        short_desc:  formats.short_desc  ?? "",
        long_desc:   formats.long_desc   ?? "",
      });
      complianceResults.push({
        mpn,
        mobileLenOk:    compliance.mobileLenOk,
        uomOk:          compliance.uomSpacingOk,
        noPlaceholders: compliance.noPlaceholders,
      });

      // Exact-match scoring (only for rows with ground truth)
      if (groundTruthByMPN[mpn]) {
        const score = fieldAccuracy(predictedAttrs, groundTruthByMPN[mpn]);
        const pct   = score.total > 0 ? ((score.matched / score.total) * 100).toFixed(1) : "N/A";
        console.log(`  ✓ Ground truth available → Field accuracy: ${pct}% (${score.matched}/${score.total})`);
        if (score.mismatches.length > 0) {
          console.log("  Mismatches:");
          score.mismatches.slice(0, 5).forEach((m) => console.log(m));
        }
        exactMatchResults.push({
          mpn,
          accuracy: score.total > 0 ? score.matched / score.total : 0,
          mismatches: score.mismatches,
        });
      } else {
        console.log(`  (no ground truth for ${mpn} — compliance only)`);
      }
    } catch (err) {
      console.error(`  ERROR processing ${mpn}: ${err instanceof Error ? err.message : String(err)}`);
      complianceResults.push({ mpn, mobileLenOk: false, uomOk: false, noPlaceholders: false });
    }
  }

  // ── Print final report ───────────────────────────────────────────────────
  console.log("\n==========================================");
  console.log("EVALUATION RESULTS");
  console.log("==========================================\n");

  if (exactMatchResults.length > 0) {
    const avgAcc = exactMatchResults.reduce((s, r) => s + r.accuracy, 0) / exactMatchResults.length;
    console.log(`1. EXACT-MATCH ACCURACY (n=${exactMatchResults.length} ground-truth rows)`);
    console.log(`   Average field accuracy: ${(avgAcc * 100).toFixed(1)}%`);
    exactMatchResults.forEach((r) => {
      console.log(`   ${r.mpn}: ${(r.accuracy * 100).toFixed(1)}%`);
    });
  } else {
    console.log("1. EXACT-MATCH ACCURACY: No ground-truth rows matched by MPN.");
  }

  console.log(`\n2. CATEGORY-LEVEL COMPLIANCE (n=${complianceResults.length} dishwasher rows)`);
  const mobilePct  = (complianceResults.filter((r) => r.mobileLenOk).length    / complianceResults.length * 100).toFixed(0);
  const uomPct     = (complianceResults.filter((r) => r.uomOk).length           / complianceResults.length * 100).toFixed(0);
  const placePct   = (complianceResults.filter((r) => r.noPlaceholders).length  / complianceResults.length * 100).toFixed(0);
  console.log(`   Mobile Desc ≤ 80 chars:  ${mobilePct}%`);
  console.log(`   UOM spacing correct:     ${uomPct}%`);
  console.log(`   No placeholder values:   ${placePct}%`);

  console.log("\n==========================================");
  console.log("Status: EVALUATION COMPLETE");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
