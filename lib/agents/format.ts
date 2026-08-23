/**
 * lib/agents/format.ts
 * Stage 7: Unilog delivery formatting.
 *
 * This returns the full wide delivery shape, including ATTRIBUTE_LABEL/VALUE/UOM
 * slots and fixed retrieval columns. Official-source-only fields stay blank
 * unless a retrieval stage passes verified manufacturer data.
 *
 * Attribute generation is now fully dynamic:
 *  - The LLM classifier (classify.ts) returns schema_fields[] for the specific category.
 *  - The normalizer (normalize.ts) returns extracted field values keyed by field label.
 *  - This module maps schema_fields → extraAttributes using the normalized values,
 *    producing category-appropriate attributes (e.g., Wash Cycles for dishwashers,
 *    Thread Size for fasteners) instead of the old hardcoded 7-slot abrasives template.
 *
 *  - schemaMatch is passed through to buildUnilogDeliveryRecord() so that rows
 *    which never received category-specific schema fields (e.g. classification
 *    failed or was rate-limited, falling back to generic extraction) are reliably
 *    flagged needs_human_review downstream, instead of only being caught
 *    incidentally by the manufacturer/brand/source checks.
 */

import { DeliveryFormats, ExtractedField, UnilogDeliveryRecord } from "@/lib/types";
import type { ClassificationResult, SchemaField } from "@/lib/agents/classify";
import { callGroq, parseJsonResponse } from "@/lib/groq";
import { FORMATTING_SYSTEM_PROMPT } from "@/lib/prompts";

const {
  buildUnilogDeliveryRecord,
  loadDeliverySchema,
  rowFromFields,
} = require("@/lib/unilog-format");

export interface FormattingInput {
  /** Normalized extraction fields from normalize.ts */
  normalizedFields: Record<string, ExtractedField>;
  /** Full classification result from classify.ts (provides schema_fields and classpath) */
  classificationResult?: ClassificationResult;
  /** Official manufacturer source data (from enrich.ts) */
  officialSourceData?: Record<string, string>;
  /** The real brand filtered from distributors (from pipeline-utils.ts) */
  resolvedBrand?: { name: string; sourceKey: string } | null;
  /** The real manufacturer filtered from distributors (from pipeline-utils.ts) */
  resolvedManufacturer?: { name: string; sourceKey: string } | null;
  /** Source URL found during enrichment (from enrich.ts) */
  sourceUrl?: string;
  /** Additional candidate URLs from enrichment to populate Ref URL 2-5 */
  referenceUrls?: string[];
  /** Real manufacturer-hosted product image URL discovered during enrichment */
  productImageUrl?: string | null;
  /** Additional real manufacturer-hosted product image URLs discovered during enrichment */
  alternateImageUrls?: string[];
  /** Real manufacturer-hosted specification/datasheet PDF URL discovered during enrichment */
  specSheetUrl?: string | null;
}

export interface FormattingResult {
  delivery_formats: DeliveryFormats;
  delivery_record: UnilogDeliveryRecord;
  delivery_columns: string[];
  trace: Record<string, unknown>;
}

type AttributeSource = "extraction" | "normalization" | "enrichment";

interface AttributeCandidate {
  label: string;
  value: string;
  uom: string;
  confidence: number;
  source: AttributeSource;
}

export function rankAttributesForSlots<T extends {
  label: string;
  value: string;
  confidence: number;
  source: AttributeSource;
}>(attrs: T[]): T[] {
  const sourceWeight: Record<AttributeSource, number> = {
    extraction: 3,
    normalization: 2,
    enrichment: 1,
  };

  return [...attrs].sort((a, b) => {
    const sourceDiff = sourceWeight[b.source] - sourceWeight[a.source];
    if (sourceDiff !== 0) return sourceDiff;
    return b.confidence - a.confidence;
  });
}

function mergeEnrichmentSpecsIntoFields(
  normalizedFields: Record<string, ExtractedField>,
  enrichmentSpecs: Record<string, string> | undefined
): Record<string, ExtractedField> {
  if (!enrichmentSpecs) return normalizedFields;
  const merged = { ...normalizedFields };
  for (const [specKey, specValue] of Object.entries(enrichmentSpecs)) {
    if (!specValue) continue;
    const normKey = specKey.toLowerCase().replace(/\s+/g, "_");
    // Don't overwrite an existing extracted/normalized value - extraction 
    // from the actual product listing takes priority over enrichment, since 
    // enrichment is a fallback source, not the primary one
    if (merged[normKey] || merged[specKey]) continue;
    merged[specKey] = {
      value: specValue,
      confidence: 70, // enrichment-sourced values get moderate confidence
      source_location: "manufacturer_site_enrichment",
      extraction_method: "explicit",
    };
  }
  return merged;
}

function attributeSourceForField(field: ExtractedField): AttributeSource {
  return field.source_location === "manufacturer_site_enrichment"
    ? "enrichment"
    : "normalization";
}

function isResolvedAttributeValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return Boolean(normalized) && ![
    "n/a",
    "na",
    "not applicable",
    "none",
    "null",
    "unknown",
    "tbd",
    "-",
    "--",
    "unbranded",
    "-- unbranded --",
    "-- no unilog brand --",
    "-- no dib brand --",
  ].includes(normalized);
}

/**
 * Builds the extraAttributes array from LLM-generated schema fields and
 * normalized extraction results. Matches schema field labels to normalized
 * field keys using case-insensitive, whitespace-normalized comparison.
 *
 * Order: schema_fields order is preserved (category-specific ordering).
 * Any normalized fields not in schema_fields are appended at the end.
 */
function buildExtraAttributes(
  schemaFields: SchemaField[],
  normalizedFields: Record<string, ExtractedField>
): AttributeCandidate[] {
  const used = new Set<string>();
  const attrs: AttributeCandidate[] = [];

  // Normalize a string for matching: lowercase + collapse whitespace
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

  // Build a lookup from normalized key → [key, field] for normalized fields
  const normalizedIndex = new Map<string, [string, ExtractedField]>();
  for (const [key, field] of Object.entries(normalizedFields)) {
    normalizedIndex.set(norm(key), [key, field]);
  }

  // 1. Walk schema_fields in order — these define the category's attribute shape
  for (const sf of schemaFields) {
    const labelNorm = norm(sf.label);
    const keyNorm = norm(sf.key);

    // Try label match first, then key match
    const match = normalizedIndex.get(labelNorm) ?? normalizedIndex.get(keyNorm);
    if (match) {
      const [rawKey, field] = match;
      const value = String(field.value ?? "").trim();
      if (isResolvedAttributeValue(value)) {
        attrs.push({
          label: sf.label,
          value,
          uom: sf.unit ?? "",
          confidence: field.confidence,
          source: attributeSourceForField(field),
        });
        used.add(rawKey);
      }
    }
    // If no extracted value exists for this field, we skip it (don't emit blank attrs)
  }

  // 2. Append any normalized fields that weren't covered by schema_fields
  // (e.g., generic identifiers: brand, part_number that the LLM extracted
  // but aren't named in schema_fields)
  const SKIP_IN_ATTRS = new Set([
    "part_manuf", "manufacturer_name", "part_desc", "mfg_part_num",
    "manufacturer_part_number", "raw_description", "product_description",
    "part_number", "description", "brand", "manufacturer",
    "e1_brand", "unilog_brand", "dib_brand", "warranty", "standard/approvals",
    // These appear in dedicated top-level columns, not attribute slots
  ]);
  for (const [key, field] of Object.entries(normalizedFields)) {
    if (used.has(key)) continue;
    if (SKIP_IN_ATTRS.has(key.toLowerCase())) continue;
    const value = String(field.value ?? "").trim();
    if (!isResolvedAttributeValue(value)) continue;
    // Convert snake_case key to Title Case label for display
    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    attrs.push({
      label,
      value,
      uom: "",
      confidence: field.confidence,
      source: attributeSourceForField(field),
    });
  }

  return rankAttributesForSlots(attrs);
}

/**
 * Converts up to 20 resolved attributes into short "Label: Value [UOM]" feature
 * strings for the ITEM_FEATURES_N delivery columns.
 * Duplication with SHORT_DESC/LONG_DESC1 is acceptable — these are a supplementary
 * structured list, not a deduplication target.
 */
function buildItemFeatures(
  attrs: { label: string; value: string; uom: string }[]
): string[] {
  return attrs
    .filter((a) => a.value)
    .slice(0, 20)
    .map((a) => a.uom ? `${a.label}: ${a.value} ${a.uom}` : `${a.label}: ${a.value}`);
}

/**
 * Runs delivery formatting for a single product.
 * Accepts the full pipeline context: normalized fields + classification result.
 */
export async function runFormatting(input: FormattingInput): Promise<FormattingResult>;
/** @deprecated Use the object-form overload instead */
export async function runFormatting(
  normalizedFields: Record<string, ExtractedField>,
  officialSourceData?: Partial<UnilogDeliveryRecord>
): Promise<FormattingResult>;

export async function runFormatting(
  inputOrFields: FormattingInput | Record<string, ExtractedField>,
  officialSourceDataLegacy?: Partial<UnilogDeliveryRecord>
): Promise<FormattingResult> {
  // Handle both call signatures for backwards compatibility
  let normalizedFields: Record<string, ExtractedField>;
  let classificationResult: ClassificationResult | undefined;
  let officialSourceData: Record<string, string> | undefined;
  let resolvedBrand: { name: string; sourceKey: string } | null | undefined;
  let resolvedManufacturer: { name: string; sourceKey: string } | null | undefined;
  let sourceUrl: string | undefined;
  let referenceUrls: string[] | undefined;
  let productImageUrl: string | null | undefined;
  let alternateImageUrls: string[] | undefined;
  let specSheetUrl: string | null | undefined;

  if (
    inputOrFields &&
    ("normalizedFields" in inputOrFields || "classificationResult" in inputOrFields)
  ) {
    // New object-form call
    const typed = inputOrFields as FormattingInput;
    normalizedFields = typed.normalizedFields;
    classificationResult = typed.classificationResult;
    officialSourceData = typed.officialSourceData;
    resolvedBrand = typed.resolvedBrand;
    resolvedManufacturer = typed.resolvedManufacturer;
    sourceUrl = typed.sourceUrl;
    referenceUrls = typed.referenceUrls;
    productImageUrl = typed.productImageUrl;
    alternateImageUrls = typed.alternateImageUrls;
    specSheetUrl = typed.specSheetUrl;
  } else {
    // Legacy positional call: runFormatting(fields, officialSourceData?)
    normalizedFields = inputOrFields as Record<string, ExtractedField>;
    officialSourceData = officialSourceDataLegacy as Record<string, string> | undefined;
  }

  const schema = loadDeliverySchema();
  const sourceRow = rowFromFields(normalizedFields);
  sourceRow.E1_Brand = resolvedBrand?.name ?? "";
  sourceRow.Unilog_Brand = resolvedBrand?.name ?? "";
  sourceRow.DIB_Brand = resolvedBrand?.name ?? "";
  sourceRow.Part_Manuf = resolvedManufacturer?.name ?? "";

  // Build dynamic, category-specific attribute list from LLM schema fields
  const schemaFields = classificationResult?.schema_fields ?? [];
  const fieldsForAttributes = mergeEnrichmentSpecsIntoFields(
    normalizedFields,
    officialSourceData
  );
  const extraAttributes = buildExtraAttributes(schemaFields, fieldsForAttributes);

  const formatted = buildUnilogDeliveryRecord(sourceRow, {
    columns: schema.columns,
    categoryExamples: [],   // No GT-peeking: category comes from classify.ts classpath
    extraAttributes,        // Fully dynamic, category-specific, from LLM
    officialSourceData,
    officialAssetsFound: Boolean(
      productImageUrl ||
      (alternateImageUrls?.length ?? 0) > 0 ||
      officialSourceData?.["Product Image"] ||
      officialSourceData?.["Alternate Image 1"]
    ),
    // Passed through so unilog-format.js can flag needs_human_review when
    // classification never produced real category-specific schema fields
    // (e.g. rate-limited / degraded to generic extraction) — see fix note above.
    schemaMatch: classificationResult?.classpath ?? "none",
  });

  const attributes: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const label = formatted.record[`ATTRIBUTE_LABEL ${i}`];
    const value = formatted.record[`ATTRIBUTE_VALUE ${i}`];
    const uom = formatted.record[`ATTRIBUTE_UOM ${i}`];
    if (label && value) {
      attributes.push(`${label} = ${value}${uom ? ` ${uom}` : ""}`);
    }
  }

  // Populate ITEM_FEATURES_N slots from the same extraAttributes list
  const features = buildItemFeatures(extraAttributes);
  features.forEach((f, i) => {
    formatted.record[`ITEM_FEATURES_${i + 1}`] = f;
  });

  // Derive TRADE_NAME: Brand + Series when available, Brand alone as fallback.
  // Fallback is a reasonable catalog default — brand name serves as trade name
  // when no distinct product series exists; not an invented value.
  if (formatted.record["BRAND_NAME"] && normalizedFields.series?.value) {
    formatted.record["TRADE_NAME"] = `${formatted.record["BRAND_NAME"]} ${normalizedFields.series.value}`;
  } else if (formatted.record["BRAND_NAME"]) {
    formatted.record["TRADE_NAME"] = formatted.record["BRAND_NAME"];
  }

  if (sourceUrl) {
    formatted.record["MFR URL"] = sourceUrl;
    formatted.record["Ref URL 1"] = sourceUrl;
  }

  if (productImageUrl) {
    formatted.record["Product Image"] = productImageUrl;
    formatted.record["Actual Image (Yes/No)"] = "Yes";
  }

  if (alternateImageUrls?.length) {
    alternateImageUrls.slice(0, 4).forEach((url, i) => {
      formatted.record[`Alternate Image ${i + 1}`] = url;
    });
  }

  if (specSheetUrl) {
    formatted.record["Specification Sheet"] = specSheetUrl;
  }

  // Populate Ref URL 2-5 from enrichment's additional candidate URLs.
  // These may be retailer listings or other pages — still useful reference
  // material even if not the official manufacturer source.
  if (referenceUrls?.length) {
    referenceUrls.slice(0, 4).forEach((url, i) => {
      formatted.record[`Ref URL ${i + 2}`] = url;
    });
  }

  // ── Generate marketing_description via LLM ──────────────────────────────
  // Uses the same FORMATTING_SYSTEM_PROMPT already shown to the formatting
  // agent, extended with the marketing_description requirement.
  // Only runs when ≥4 distinct field values are available (honesty threshold).
  let marketingDescription = "";
  const resolvedFieldCount = Object.values(fieldsForAttributes)
    .filter((f) => String(f.value ?? "").trim()).length;

  if (resolvedFieldCount >= 4) {
    try {
      const fieldSummary = Object.entries(fieldsForAttributes)
        .filter(([, f]) => String(f.value ?? "").trim())
        .map(([k, f]) => `${k}: ${f.value}`)
        .join("\n");

      const marketingPrompt = [
        FORMATTING_SYSTEM_PROMPT,
        "",
        "TASK: Generate ONLY the marketing_description field.",
        "Return JSON with a single key: { \"marketing_description\": \"...\" }",
        "",
        "PRODUCT FIELDS:",
        fieldSummary,
      ].join("\n");

      const raw = await callGroq(marketingPrompt, "");
      const parsed = parseJsonResponse<{ marketing_description?: string }>(raw);
      marketingDescription = String(parsed?.marketing_description ?? "").trim();
    } catch {
      // Non-fatal: marketing_description stays empty on failure
    }
  }

  if (marketingDescription) {
    formatted.record["MARKETING_DESCRIPTION"] = marketingDescription;
  }

  // Override regex-fallback classpath/brand/manufacturer with the correct 
  // LLM-derived and distributor-filtered values, when available. 
  // buildUnilogDeliveryRecord() computes its own versions of these using 
  // primitive placeholder-checking that doesn't have access to the real 
  // classification or brand-resolution results - those need to win here.
  
  if (classificationResult?.classpath && classificationResult.classpath !== "Unknown>Uncategorized") {
    formatted.record.Classpath = classificationResult.classpath;
    
    // Also split into Dept/Class/Fine if the schema expects those as 
    // separate columns - classpath format is "Dept>Class>Fine"
    const parts = classificationResult.classpath.split(">").map(p => p.trim());
    if (parts.length >= 1) formatted.record.Dept = parts[0];
    if (parts.length >= 2) formatted.record.Class = parts[1];
    if (parts.length >= 3) formatted.record.Fine = parts[2];
  } else {
    formatted.record.Classpath = "";
    formatted.record.Dept = "";
    formatted.record.Class = "";
    formatted.record.Fine = "";
  }
  
  if (resolvedBrand?.name) {
    formatted.record.BRAND_NAME = resolvedBrand.name;
    // Delivery brand columns must contain the resolved catalog brand, not the
    // placeholder values that arrived in the source feed.
    formatted.record.E1_Brand = resolvedBrand.name;
    formatted.record.Unilog_Brand = resolvedBrand.name;
    formatted.record.DIB_Brand = resolvedBrand.name;
  } else {
    formatted.record.BRAND_NAME = "";
    formatted.record.E1_Brand = "";
    formatted.record.Unilog_Brand = "";
    formatted.record.DIB_Brand = "";
  }
  
  if (resolvedManufacturer?.name) {
    formatted.record.MANUFACTURER_NAME = resolvedManufacturer.name;
  } else {
    formatted.record.MANUFACTURER_NAME = "";
  }

  // Copy document/asset links and data fields discovered by discoverDocumentLinks()
  // and Country Of Origin / Warranty extracted by parseSpecsFromContent() into
  // the delivery record. These keys must match the 252-column schema headers exactly.
  const docFields = [
    "Instruction/Installation Manual", "Service Manual", "Owners/User Manual",
    "Line Drawing", "MTR", "RoHS", "Full Engineering Drawing", "Energy Star Guide",
    "Technical Bulletin", "Submittal", "Compatibility Chart", "Size Chart",
    "Product Label/Insert", "Video Link", "Video Link 1", "Country Of Origin",
    "Warranty", "Warranty Information",
  ];
  if (officialSourceData) {
    for (const field of docFields) {
      if (officialSourceData[field]) {
        formatted.record[field] = officialSourceData[field];
      }
    }
  }

  return {
    delivery_formats: {
      mobile_desc: formatted.record.MOBILE_DESC,
      short_desc: formatted.record.SHORT_DESC,
      long_desc: formatted.record.LONG_DESC1,
      invoice_desc: formatted.record.INVOICE_DESC,
      retail_desc: formatted.record.RETAIL_DESC,
      marketing_description: formatted.record.MARKETING_DESCRIPTION || undefined,
      attributes,
      attributes_string: attributes.join("; "),
      fixed_block_status: formatted.trace.fixed_block_status,
    },
    delivery_record: formatted.record,
    delivery_columns: schema.columns,
    trace: {
      ...formatted.trace,
      schema_source: schemaFields.length > 0 ? "llm_classify" : "none",
      schema_field_count: schemaFields.length,
      attribute_count: extraAttributes.length,
    },
  };
}
