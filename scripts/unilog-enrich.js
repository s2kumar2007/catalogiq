const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "Data", "Unihack_ Sample Dataset - Input.csv");
const FORMAT = path.join(ROOT, "Data", "Unihack_ Expected Output - Delivery Format (1).csv");
const OUT_DIR = path.join(ROOT, "outputs");
const OUTPUT_CSV = path.join(OUT_DIR, "catalogiq_unilog_delivery.csv");
const REPORT_JSON = path.join(OUT_DIR, "catalogiq_unilog_report.json");

const PLACEHOLDERS = new Set([
  "",
  "-- unbranded --",
  "-- no unilog brand --",
  "-- no dib brand --",
]);

const BRAND_ALIASES = [
  ["FRIGIDAIRE", /frigidaire/i],
  ["DIABLO", /\bdiablo\b/i],
  ["3M", /\b3m\b/i],
  ["MIRKA", /\b(abranet|hiolit|mirka)\b/i],
  ["MILWAUKEE", /\b(milw|milwaukee)\b/i],
  ["NORTON", /\bnorton\b/i],
  ["DEWALT", /\bdewalt\b/i],
  ["MAKITA", /\bmakita\b/i],
  ["BOSCH", /\bbosch\b/i],
  ["KLEIN TOOLS", /\bklein\b/i],
];

const TYPE_RULES = [
  ["Sanding Belt", /\bsanding belt\b|\bbelt\b/i, "Abrasives & Finishing > Coated Abrasives > Sanding Belts"],
  ["Film Disc", /\b(stikit film|film disc|disc\/box)\b/i, "Abrasives & Finishing > Coated Abrasives > Sanding Discs"],
  ["Sanding Disc", /\b(abranet|hiolit|sanding disc)\b/i, "Abrasives & Finishing > Coated Abrasives > Sanding Discs"],
  ["Cut-Off Wheel", /\b(cut[\s-]?off|cutting wheel|metal cut off|steel demon|speed demon)\b/i, "Abrasives & Finishing > Bonded Abrasives > Cut-Off Wheels"],
  ["Grinding Wheel", /\bgrind|grinding wheel\b/i, "Abrasives & Finishing > Bonded Abrasives > Grinding Wheels"],
  ["Drill Bit", /\bdrill bit\b|\bbit\b/i, "Tools & Instruments > Cutting Tools > Drill Bits"],
  ["Saw Blade", /\bblade\b/i, "Tools & Instruments > Cutting Tools > Saw Blades"],
  ["Product", /./, "Industrial Supplies > Miscellaneous"],
];

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

function cleanPlaceholder(value) {
  const text = String(value ?? "").trim();
  return PLACEHOLDERS.has(text.toLowerCase()) ? "" : text;
}

function titleCase(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bX\b/g, "x")
    .replace(/\bDko\b/g, "DKO");
}

function manufacturerName(partManuf) {
  return String(partManuf ?? "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\bInc\b\.?/gi, "Inc")
    .replace(/\bLlc\b/gi, "LLC")
    .trim();
}

function detectBrand(row) {
  const existing = [row.Unilog_Brand, row.DIB_Brand, row.E1_Brand].map(cleanPlaceholder).find(Boolean);
  if (existing) return existing;
  const haystack = `${row.Mfg_Part_Num} ${row.Part_Desc} ${row.Part_Manuf}`;
  const found = BRAND_ALIASES.find(([, pattern]) => pattern.test(haystack));
  return found ? found[0] : manufacturerName(row.Part_Manuf);
}

function normalizeUnits(text) {
  return String(text ?? "")
    .replace(/(\d)\s*"\s*x\s*(\d)/gi, "$1 in x $2")
    .replace(/(\d)\s*"/g, "$1 in")
    .replace(/(\d)x(\d)/gi, "$1 x $2")
    .replace(/\b(\d+)\s*pc\b/gi, "$1 Pieces")
    .replace(/\bdisc\/box\b/gi, "Discs per Box")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGrit(desc) {
  const match = desc.match(/\bP\s?(\d{2,4})\b/i);
  return match ? match[1] : "";
}

function extractPack(desc) {
  const match = desc.match(/\b(\d+)\s*(?:pc|pieces?|disc\/box|discs?\/box)\b/i);
  return match ? match[1] : "";
}

function extractSize(desc) {
  const value = String.raw`(?:\d+(?:-\d+\/\d+|\.\d+|\/\d+)?|\.\d+)`;
  const inch = desc.match(new RegExp(`(${value})\\s*"?\\s*x\\s*(${value})\\s*"?(?:\\s*x\\s*(${value})\\s*"?)?`, "i"));
  if (inch) {
    return [inch[1], inch[2], inch[3]].filter(Boolean).map((v) => `${v} in`).join(" x ");
  }
  const single = desc.match(new RegExp(`(${value})\\s*"`, "i"));
  return single ? `${single[1]} in` : "";
}

function detectType(desc) {
  return TYPE_RULES.find(([, pattern]) => pattern.test(desc)) || TYPE_RULES[TYPE_RULES.length - 1];
}

function compactJoin(parts, separator = ", ") {
  return parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(separator);
}

function truncate(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : value.slice(0, max).replace(/\s+\S*$/, "");
}

function attributeTriples(product) {
  const attrs = [
    ["Product Type", product.type, ""],
    ["Brand", product.brand, ""],
    ["Manufacturer Part Number", product.mpn, ""],
    ["Size", product.size, ""],
    ["Grit", product.grit, ""],
    ["Package Quantity", product.pack, ""],
    ["Material Application", product.application, ""],
  ].filter(([, value]) => value);
  return attrs.slice(0, 50);
}

function makeRecord(row, columns, index) {
  const [type, , classpath] = detectType(row.Part_Desc);
  const brand = detectBrand(row);
  const manufacturer = manufacturerName(row.Part_Manuf);
  const mpn = cleanPlaceholder(row.Mfg_Part_Num);
  const normalizedDesc = normalizeUnits(row.Part_Desc);
  const size = extractSize(row.Part_Desc);
  const grit = extractGrit(row.Part_Desc);
  const pack = extractPack(row.Part_Desc);
  const application = /metal|steel/i.test(row.Part_Desc)
    ? "Metal"
    : /wood/i.test(row.Part_Desc)
      ? "Wood"
      : /sand|abras|grit|film|stikit|abranet|hiolit|belt|disc/i.test(row.Part_Desc)
        ? "Sanding and Finishing"
        : "";

  const product = { type, brand, manufacturer, mpn, size, grit, pack, application };
  const titleBits = [brand, mpn, type, size, grit && `P${grit} Grit`, pack && `${pack}-Piece`];
  const shortDesc = truncate(compactJoin(titleBits, " "), 160);
  const longDesc = truncate(compactJoin([
    shortDesc,
    normalizedDesc && `Original supplier description: ${normalizedDesc}`,
    application && `Application: ${application}`,
  ]), 500);
  const mobileDesc = truncate(compactJoin([manufacturer, brand, type, mpn]), 80);
  const invoiceDesc = truncate(compactJoin([type, size, grit && `P${grit}`, pack && `${pack}PC`], " ").toUpperCase(), 40);

  const record = Object.fromEntries(columns.map((column) => [column, ""]));
  Object.assign(record, {
    PART_NUMBER: mpn || `CATALOGIQ-${index + 1}`,
    Mfg_Part_Num: row.Mfg_Part_Num,
    Part_Desc: row.Part_Desc,
    E1_Brand: row.E1_Brand,
    Unilog_Brand: row.Unilog_Brand,
    DIB_Brand: row.DIB_Brand,
    Part_Manuf: row.Part_Manuf,
    MANUFACTURER_NAME: manufacturer,
    BRAND_NAME: brand,
    MANUFACTURER_PART_NUMBER: mpn,
    Classpath: classpath,
    MOBILE_DESC: mobileDesc,
    INVOICE_DESC: invoiceDesc,
    SHORT_DESC: shortDesc,
    LONG_DESC1: longDesc,
    RETAIL_DESC: compactJoin([type, size, grit && `P${grit} Grit`, pack && `${pack}-Piece`]),
    "Product Name": type,
    Discontinued: "No",
    "Actual Image (Yes/No)": "No",
  });

  attributeTriples(product).forEach(([label, value, uom], i) => {
    const n = i + 1;
    record[`ATTRIBUTE_LABEL ${n}`] = label;
    record[`ATTRIBUTE_VALUE ${n}`] = value;
    record[`ATTRIBUTE_UOM ${n}`] = uom;
  });

  return {
    record,
    trace: {
      mpn,
      manufacturer,
      brand,
      classpath,
      extracted: { type, size, grit, pack, application },
      confidence: {
        brand: brand ? 0.85 : 0.35,
        classpath: classpath.includes("Miscellaneous") ? 0.35 : 0.75,
        attributes: attributeTriples(product).length / 7,
      },
      needs_human_review: classpath.includes("Miscellaneous") || !manufacturer || !brand,
    },
  };
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
  const format = readCsv(FORMAT);
  const columns = format.meta.fields;
  const enriched = input.data.map((row, index) => makeRecord(row, columns, index));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_CSV, Papa.unparse(enriched.map((item) => item.record), { columns }), "utf8");

  const report = {
    generated_at: new Date().toISOString(),
    input_rows: input.data.length,
    output_rows: enriched.length,
    output_columns: columns.length,
    files: {
      input: path.relative(ROOT, INPUT),
      delivery_format: path.relative(ROOT, FORMAT),
      output_csv: path.relative(ROOT, OUTPUT_CSV),
    },
    validation: {
      schema_columns_preserved: enriched.every(({ record }) => (
        columns.every((column) => Object.prototype.hasOwnProperty.call(record, column))
      )),
      invoice_desc_max_40: enriched.every(({ record }) => String(record.INVOICE_DESC).length <= 40),
      mobile_desc_max_80: enriched.every(({ record }) => String(record.MOBILE_DESC).length <= 80),
    },
    evaluation_against_available_expected_rows: evaluate(
      enriched,
      format.data,
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
