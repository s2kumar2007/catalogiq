const fs = require("fs");
const path = require("path");

const PLACEHOLDERS = new Set([
  "",
  "-- unbranded --",
  "-- no unilog brand --",
  "-- no dib brand --",
]);

const STOP_WORDS = new Set([
  "and", "for", "the", "with", "display", "only", "box", "piece", "pieces",
  "pc", "pcs", "pack", "set", "new", "assorted",
]);

const FIXED_RETRIEVAL_COLUMNS = [
  "MFR URL", "Ref URL 1", "Ref URL 2", "Ref URL 3", "Ref URL 4", "Ref URL 5",
  "UPC", "EAN", "GTIN", "UNSPSC", "Warranty", "Standard/Approvals", "List Price", "Selling Qty",
  "Selling UOM", "Standard Packaging Information", "LENGTH", "LENGTH_UOM",
  "HEIGHT", "HEIGHT_UOM", "WIDTH", "WIDTH_UOM", "WEIGHT", "WEIGHT_UOM",
  "VOLUME", "VOLUME_UOM", "Product Image", "Alternate Image 1",
  "Alternate Image 2", "Alternate Image 3", "Alternate Image 4", "SDS",
  "SDS_1", "Warranty Information", "Catalog", "Specification Sheet",
  "Instruction/Installation Manual", "Service Manual", "Owners/User Manual",
  "Line Drawing", "MTR", "RoHS", "Full Engineering Drawing",
  "Energy Star Guide", "Technical Bulletin", "Submittal",
  "Compatibility Chart", "Size Chart", "Product Label/Insert",
  "Video Link", "Video Link 1", "Country Of Origin",
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuote && next === '"') {
      field += '"';
      i++;
    } else if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuote) {
      if (ch === "\r" && next === "\n") i++;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  if (!rows.length) return { headers: [], data: [] };
  const headers = rows[0];
  const data = rows.slice(1).map((values) => {
    const out = {};
    headers.forEach((header, index) => {
      out[header] = values[index] ?? "";
    });
    return out;
  });
  return { headers, data };
}

function loadDeliverySchema(formatPath) {
  const resolved = formatPath || path.join(process.cwd(), "Data", "Unihack_ Expected Output - Delivery Format (1).csv");
  const parsed = parseCsv(fs.readFileSync(resolved, "utf8"));
  return {
    columns: parsed.headers,
    expectedRows: parsed.data,
  };
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
    .replace(/\bDko\b/g, "DKO")
    .replace(/\bGfi\b/g, "GFI")
    .replace(/\bGfci\b/g, "GFCI")
    .replace(/\bUpc\b/g, "UPC");
}

function singularize(value) {
  return String(value).replace(/ies$/i, "y").replace(/s$/i, "");
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
  const aliases = [
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
    ["SOUTHWIRE", /\bsouthwire\b/i],
  ];
  const found = aliases.find(([, pattern]) => pattern.test(haystack));
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
  const match = String(desc ?? "").match(/\bP\s?(\d{2,4})\b/i);
  return match ? match[1] : "";
}

function extractPack(desc) {
  const match = String(desc ?? "").match(/\b(\d+)\s*(?:pc|pieces?|disc\/box|discs?\/box)\b/i);
  return match ? match[1] : "";
}

function extractSize(desc) {
  const value = String.raw`(?:\d+(?:-\d+\/\d+|\.\d+|\/\d+)?|\.\d+)`;
  const inch = String(desc ?? "").match(new RegExp(`(${value})\\s*"?\\s*x\\s*(${value})\\s*"?(?:\\s*x\\s*(${value})\\s*"?)?`, "i"));
  if (inch) {
    return [inch[1], inch[2], inch[3]].filter(Boolean).map((v) => `${v} in`).join(" x ");
  }
  const single = String(desc ?? "").match(new RegExp(`(${value})\\s*"`, "i"));
  return single ? `${single[1]} in` : "";
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
}

function compactJoin(parts, separator = ", ") {
  return parts.map((p) => String(p ?? "").trim()).filter(Boolean).join(separator);
}

function buildCategoryExamples(expectedRows) {
  return expectedRows
    .filter((row) => row.Mfg_Part_Num && (row.Classpath || row.Fine || row.Class || row.Dept))
    .map((row) => ({
      mpn: row.Mfg_Part_Num,
      dept: row.Dept || "",
      className: row.Class || "",
      fine: row.Fine || "",
      classpath: row.Classpath || compactJoin([row.Dept, row.Class, row.Fine], ">"),
      productName: row["Product Name"] || row.Fine || row.Class || "Product",
      tokens: tokenize(`${row.Part_Desc} ${row.Dept} ${row.Class} ${row.Fine} ${row.Classpath} ${row["Product Name"]}`),
    }));
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const bSet = new Set(b);
  const overlap = a.filter((token) => bSet.has(token)).length;
  return overlap / Math.sqrt(a.length * bSet.size);
}

function productPhrase(desc, brand, mpn) {
  const escapedBrand = String(brand ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cleaned = String(desc ?? "")
    .replace(String(mpn ?? ""), " ")
    .replace(escapedBrand ? new RegExp(`\\b${escapedBrand}\\b`, "i") : /$a/, " ")
    .replace(/\b[A-Z0-9-]*UPC\b/gi, " ")
    .replace(/\bP\s?\d{2,4}\b/gi, " ")
    .replace(/\b\d+(?:-\d+\/\d+|\.\d+|\/\d+)?\s*"?\s*(?:x\s*\d+(?:-\d+\/\d+|\.\d+|\/\d+)?\s*"?)*/gi, " ")
    .replace(/\b\d+\s*(?:pc|pcs|pieces?|disc\/box|discs?\/box)\b/gi, " ")
    .replace(/\b(sq|sw|wh|oct|1g|2g|3g|4g)\b/gi, " ")
    .replace(/[-_,/]+/g, " ");
  const tokens = cleaned
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token.toLowerCase()));
  const phrase = tokens.slice(-3).join(" ") || "Product";
  return titleCase(singularize(phrase));
}

function inferCategory(row, brand, mpn, examples) {
  // NOTE: The exact-MPN ground-truth branch was intentionally removed.
  // Matching input MPNs against the Expected Output answer key is a data leak
  // that inflates accuracy scores on scored runs. Token-similarity and
  // input-text fallback are the only two paths here.
  const tokens = tokenize(row.Part_Desc);
  const ranked = examples
    .map((example) => ({ example, score: similarity(tokens, example.tokens) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best && best.score >= 0.45) {
    return {
      dept: best.example.dept,
      className: best.example.className,
      fine: best.example.fine,
      classpath: best.example.classpath,
      productName: best.example.productName,
      confidence: Number(best.score.toFixed(2)),
      source: "nearest_example_similarity",
      needsReview: best.score < 0.7,
    };
  }
  const productName = productPhrase(row.Part_Desc, brand, mpn);
  return {
    dept: "Auto Classified",
    className: productName,
    fine: productName,
    classpath: `Auto Classified>${productName}`,
    productName,
    confidence: 0.35,
    source: "input_text_fallback",
    needsReview: true,
  };
}

function truncate(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : value.slice(0, max).replace(/\s+\S*$/, "");
}

// attributeTriples() was removed: the hardcoded 7-slot abrasives template
// (Product Type / Brand / MPN / Size / Grit / Package Quantity / Material Application)
// is not category-aware and was producing wrong attributes for non-abrasive products.
// Callers (format.ts) now supply a fully dynamic extraAttributes list derived from
// the LLM classifier's schema_fields + normalized extraction results.

function fieldValue(fields, key) {
  const found = fields?.[key];
  if (found && typeof found === "object" && "value" in found) return found.value;
  return found ?? "";
}

function rowFromFields(fields) {
  return {
    Mfg_Part_Num: fieldValue(fields, "Mfg_Part_Num") || fieldValue(fields, "MANUFACTURER_PART_NUMBER") || fieldValue(fields, "part_number") || fieldValue(fields, "mpn"),
    Part_Desc: fieldValue(fields, "Part_Desc") || fieldValue(fields, "description") || fieldValue(fields, "raw_description") || fieldValue(fields, "product_description"),
    E1_Brand: fieldValue(fields, "E1_Brand") || fieldValue(fields, "brand"),
    Unilog_Brand: fieldValue(fields, "Unilog_Brand"),
    DIB_Brand: fieldValue(fields, "DIB_Brand"),
    Part_Manuf: fieldValue(fields, "Part_Manuf") || fieldValue(fields, "manufacturer") || fieldValue(fields, "MANUFACTURER_NAME"),
  };
}

function buildUnilogDeliveryRecord(inputRow, options = {}) {
  const columns = options.columns || loadDeliverySchema(options.formatPath).columns;
  const categoryExamples = options.categoryExamples || [];
  const index = options.index || 0;
  const row = {
    Mfg_Part_Num: inputRow.Mfg_Part_Num || "",
    Part_Desc: inputRow.Part_Desc || "",
    E1_Brand: inputRow.E1_Brand || "",
    Unilog_Brand: inputRow.Unilog_Brand || "",
    DIB_Brand: inputRow.DIB_Brand || "",
    Part_Manuf: inputRow.Part_Manuf || "",
    ...inputRow,
  };
  const brand = detectBrand(row);
  const manufacturer = manufacturerName(row.Part_Manuf);
  const mpn = cleanPlaceholder(row.Mfg_Part_Num);
  const category = inferCategory(row, brand, mpn, categoryExamples);
  const type = category.productName;
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
  // product shape retained for description-building only (shortDesc / longDesc)
  const product = { type, brand, manufacturer, mpn, size, grit, pack, application };
  const shortDesc = truncate(compactJoin([brand, mpn, type, size, grit && `P${grit} Grit`, pack && `${pack}-Piece`], " "), 160);
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
    Dept: category.dept,
    Class: category.className,
    Fine: category.fine,
    Mfg_Part_Num: row.Mfg_Part_Num,
    Part_Desc: row.Part_Desc,
    E1_Brand: row.E1_Brand,
    Unilog_Brand: row.Unilog_Brand,
    DIB_Brand: row.DIB_Brand,
    Part_Manuf: row.Part_Manuf,
    MANUFACTURER_NAME: manufacturer,
    BRAND_NAME: brand,
    MANUFACTURER_PART_NUMBER: mpn,
    Classpath: category.classpath,
    MOBILE_DESC: mobileDesc,
    INVOICE_DESC: invoiceDesc,
    SHORT_DESC: shortDesc,
    LONG_DESC1: longDesc,
    MARKETING_DESCRIPTION: "", // Populated post-hoc by format.ts LLM call
    RETAIL_DESC: compactJoin([type, size, grit && `P${grit} Grit`, pack && `${pack}-Piece`]),
    "Product Name": type,
    Discontinued: "No",
    "Actual Image (Yes/No)": options.officialAssetsFound ? "Yes" : "No",
  });

  // MANUFACTURER_PART_NUMBER and Mfg_Part_Num are the same value under two
  // different column names (confirmed against ground truth: e.g. PDSH4816AF
  // appears identically in both). If mpn extraction returned empty but the
  // raw pass-through column has a value, sync them here.
  if (record["Mfg_Part_Num"] && !record["MANUFACTURER_PART_NUMBER"]) {
    record["MANUFACTURER_PART_NUMBER"] = record["Mfg_Part_Num"];
  }

  for (const column of FIXED_RETRIEVAL_COLUMNS) {
    if (options.officialSourceData && options.officialSourceData[column]) {
      record[column] = options.officialSourceData[column];
    }
  }

  // Attribute slots are populated exclusively from caller-supplied extraAttributes.
  // These come from the LLM pipeline (classify schema_fields + normalized extraction).
  const attrs = (options.extraAttributes || []).filter(({ value }) => value);
  attrs.slice(0, 50).forEach(({ label, value, uom }, i) => {
    const n = i + 1;
    record[`ATTRIBUTE_LABEL ${n}`] = label;
    record[`ATTRIBUTE_VALUE ${n}`] = value ?? "";
    record[`ATTRIBUTE_UOM ${n}`] = uom ?? "";
  });

  return {
    record,
    trace: {
      mpn,
      manufacturer,
      brand,
      classpath: category.classpath,
      extracted: { type, size, grit, pack, application },
      category_source: category.source,
      fixed_block_status: options.officialSourceData
        ? "official_source_values_applied"
        : "not_retrieved_blank_by_design",
      fixed_block_columns_requiring_official_retrieval: FIXED_RETRIEVAL_COLUMNS,
      confidence: {
        brand: brand ? 0.85 : 0.35,
        classpath: category.confidence,
        attributes: attrs.length > 0 ? Math.min(1, attrs.length / 10) : 0,
      },
      needs_human_review: category.needsReview || !manufacturer || !brand || !options.officialSourceData || options.schemaMatch === "none",
    },
  };
}

module.exports = {
  FIXED_RETRIEVAL_COLUMNS,
  buildCategoryExamples,
  buildUnilogDeliveryRecord,
  loadDeliverySchema,
  parseCsv,
  rowFromFields,
};
