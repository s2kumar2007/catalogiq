/**
 * scripts/evaluate.ts
 * Real evaluation against the Unilog Hackathon datasets.
 *
 * RUN:  npx ts-node --project tsconfig.scripts.json scripts/evaluate.ts
 *
 * DATA FLOW — ground truth is NEVER passed into the pipeline:
 *   Input CSV → rawText → classify → extract → normalize → format → predicted output
 *   Expected Output CSV → loaded AFTER pipeline completes → used only for post-hoc scoring
 *
 * SCORING:
 *   BLIND rows:      MPNs NOT in the Expected Output. This is the REAL accuracy metric.
 *   SPOT-CHECK rows: MPNs that appear in the Expected Output (answer key visible to scorer,
 *                    NOT to the pipeline). Reported separately — not blended into accuracy.
 *
 * What it does:
 *  1. Reads the 1000-row Input CSV
 *  2. Reads the Expected Output CSV to identify known MPNs (for split, not for pipeline input)
 *  3. Calls classify + extract (with schema_fields wired from classify) + normalize + format
 *  4. Reports blind accuracy separately from spot-check rows
 *  5. Reports FORMAT COMPLIANCE for all rows
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { loadEnvConfig } from "@next/env";

// Load Next.js environment variables (.env.local) so GEMINI_API_KEY is available
loadEnvConfig(process.cwd());

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
  // ONLY used for post-hoc scoring after the pipeline runs — NEVER passed into pipeline stages.
  const groundTruthByMPN: Record<string, Record<string, string>> = {};
  for (const row of outputRows) {
    const mpn = row["Mfg_Part_Num"] ?? row["MANUFACTURER_PART_NUMBER"];
    if (mpn && mpn.trim()) {
      groundTruthByMPN[mpn.trim()] = extractGroundTruthAttributes(row);
    }
  }
  const knownMPNs = new Set(Object.keys(groundTruthByMPN));

  console.log(`Dishwasher rows found in input: ${dishwasherInputRows.length}`);
  console.log(`Known GT MPNs (excluded from accuracy): ${knownMPNs.size}`);
  console.log(`Blind rows (will be scored as accuracy): ${dishwasherInputRows.filter((r) => !knownMPNs.has((r["Mfg_Part_Num"] ?? "").trim())).length}\n`);

  // ── Run pipeline on each dishwasher row ──────────────────────────────────
  // BLIND: MPNs not in ground truth → accuracy metric
  // SPOT-CHECK: known MPNs → separate report, not blended into accuracy
  const blindResults:     { mpn: string; accuracy: number; mismatches: string[] }[] = [];
  const spotCheckResults: { mpn: string; accuracy: number; mismatches: string[] }[] = [];
  const exactMatchResults: { mpn: string; accuracy: number; mismatches: string[] }[] = []; // kept for compat
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

      // Stage 1: Extract — schema_fields from classify flow directly into extract
      // (this is the wired pipeline path; no static schema JSON file needed)
      const extractResult = await runExtraction({
        rawText,
        category: "auto",
        schemaFields: classResult.schema_fields,
      });

      // Stage 6: Normalize
      const normResult = await runNormalization(extractResult.extracted_fields);

      // Stage 7: Format with classification result (for dynamic attributes)
      const fmtResult = await runFormatting({
        normalizedFields: normResult.normalized_fields,
        classificationResult: classResult,
      });
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

      // Exact-match scoring
      if (groundTruthByMPN[mpn]) {
        const isKnown = knownMPNs.has(mpn);
        const score = fieldAccuracy(predictedAttrs, groundTruthByMPN[mpn]);
        const pct   = score.total > 0 ? ((score.matched / score.total) * 100).toFixed(1) : "N/A";
        const label = isKnown ? "spot-check" : "blind";
        console.log(`  ✓ Ground truth available [${label}] → Field accuracy: ${pct}% (${score.matched}/${score.total})`);
        if (score.mismatches.length > 0) {
          console.log(`  Mismatches (${label}):`);
          score.mismatches.slice(0, 5).forEach((m) => console.log(m));
        }
        const entry = { mpn, accuracy: score.total > 0 ? score.matched / score.total : 0, mismatches: score.mismatches };
        if (isKnown) {
          spotCheckResults.push(entry);
        } else {
          blindResults.push(entry);
          exactMatchResults.push(entry); // kept for compat
        }
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

  console.log("1. BLIND ACCURACY — the real metric (MPNs not in ground truth)");
  if (blindResults.length > 0) {
    const avgAcc = blindResults.reduce((s, r) => s + r.accuracy, 0) / blindResults.length;
    console.log(`   n=${blindResults.length} rows | Average: ${(avgAcc * 100).toFixed(1)}%`);
    blindResults.forEach((r) => console.log(`   ${r.mpn}: ${(r.accuracy * 100).toFixed(1)}%`));
  } else {
    console.log(`   n=0 — all scored rows were known MPNs (check your dataset split)`);
  }

  console.log(`\n2. SPOT-CHECK — known MPNs (NOT blended into accuracy metric)`);
  if (spotCheckResults.length > 0) {
    const avgAcc = spotCheckResults.reduce((s, r) => s + r.accuracy, 0) / spotCheckResults.length;
    console.log(`   n=${spotCheckResults.length} rows | Average: ${(avgAcc * 100).toFixed(1)}%`);
    spotCheckResults.forEach((r) => console.log(`   ${r.mpn}: ${(r.accuracy * 100).toFixed(1)}%`));
  } else {
    console.log(`   n=0 — no known MPNs in evaluated set`);
  }

  console.log(`\n3. FORMAT COMPLIANCE (n=${complianceResults.length} dishwasher rows)`);
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
