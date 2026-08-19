const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");
const {
  buildCategoryExamples,
  buildUnilogDeliveryRecord,
  loadDeliverySchema,
} = require("../lib/unilog-format");

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "Data", "Unihack_ Sample Dataset - Input.csv");
const FORMAT = path.join(ROOT, "Data", "Unihack_ Expected Output - Delivery Format (1).csv");
const OUT_DIR = path.join(ROOT, "outputs");
const OUTPUT_CSV = path.join(OUT_DIR, "catalogiq_unilog_delivery.csv");
const REPORT_JSON = path.join(OUT_DIR, "catalogiq_unilog_report.json");

function readCsv(file) {
  const parsed = Papa.parse(fs.readFileSync(file, "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    throw new Error(`${file}: ${parsed.errors[0].message}`);
  }
  return parsed;
}

function evaluate(records, expectedRows, fields) {
  const expectedByMpn = new Map(expectedRows.map((row) => [row.Mfg_Part_Num, row]));
  const comparable = records.filter(({ record }) => expectedByMpn.has(record.Mfg_Part_Num));
  const fieldScores = {};
  for (const field of fields) {
    let exact = 0;
    let filled = 0;
    for (const { record } of comparable) {
      const expected = String(expectedByMpn.get(record.Mfg_Part_Num)?.[field] ?? "").trim();
      const actual = String(record[field] ?? "").trim();
      if (actual) filled++;
      if (expected && actual && expected.toLowerCase() === actual.toLowerCase()) exact++;
    }
    fieldScores[field] = {
      exact_matches: exact,
      generated_non_blank: filled,
      comparable_rows: comparable.length,
    };
  }
  return { comparable_rows: comparable.length, field_scores: fieldScores };
}

function main() {
  const input = readCsv(INPUT);
  const schema = loadDeliverySchema(FORMAT);
  const categoryExamples = buildCategoryExamples(schema.expectedRows);
  const enriched = input.data.map((row, index) => (
    buildUnilogDeliveryRecord(row, {
      columns: schema.columns,
      categoryExamples,
      index,
    })
  ));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUTPUT_CSV,
    Papa.unparse(enriched.map((item) => item.record), { columns: schema.columns }),
    "utf8"
  );

  const report = {
    generated_at: new Date().toISOString(),
    input_rows: input.data.length,
    output_rows: enriched.length,
    output_columns: schema.columns.length,
    files: {
      input: path.relative(ROOT, INPUT),
      delivery_format: path.relative(ROOT, FORMAT),
      output_csv: path.relative(ROOT, OUTPUT_CSV),
    },
    validation: {
      schema_columns_preserved: enriched.every(({ record }) => (
        schema.columns.every((column) => Object.prototype.hasOwnProperty.call(record, column))
      )),
      invoice_desc_max_40: enriched.every(({ record }) => String(record.INVOICE_DESC).length <= 40),
      mobile_desc_max_80: enriched.every(({ record }) => String(record.MOBILE_DESC).length <= 80),
      attribute_slot_shape_present: schema.columns.includes("ATTRIBUTE_LABEL 50") &&
        schema.columns.includes("ATTRIBUTE_VALUE 50") &&
        schema.columns.includes("ATTRIBUTE_UOM 50"),
    },
    category_detection: {
      strategy: "learn exact/nearest category examples from expected-output rows; derive fallback labels from input text when no comparable example exists",
      learned_examples: categoryExamples.length,
      hardcoded_category_options: 0,
    },
    fixed_block_retrieval: {
      status: "not run in offline batch mode",
      policy: "UPC/EAN/GTIN/dimensions/images/docs/country-of-origin must come from official manufacturer sources; blank values are left blank rather than generated",
      columns: enriched[0]?.trace.fixed_block_columns_requiring_official_retrieval ?? [],
    },
    evaluation_against_available_expected_rows: evaluate(
      enriched,
      schema.expectedRows,
      ["MANUFACTURER_NAME", "BRAND_NAME", "MANUFACTURER_PART_NUMBER", "Classpath", "MOBILE_DESC", "INVOICE_DESC", "SHORT_DESC"]
    ),
    trace_sample: enriched.slice(0, 25).map((item) => item.trace),
    human_review_count: enriched.filter((item) => item.trace.needs_human_review).length,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf8");

  console.log(`Wrote ${enriched.length} delivery rows to ${OUTPUT_CSV}`);
  console.log(`Wrote report to ${REPORT_JSON}`);
}

main();
