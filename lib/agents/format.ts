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
  officialSourceData?: Partial<UnilogDeliveryRecord>;
  /** The real brand filtered from distributors (from pipeline-utils.ts) */
  resolvedBrand?: { name: string; sourceKey: string } | null;
  /** The real manufacturer filtered from distributors (from pipeline-utils.ts) */
  resolvedManufacturer?: { name: string; sourceKey: string } | null;
}

export interface FormattingResult {
  delivery_formats: DeliveryFormats;
  delivery_record: UnilogDeliveryRecord;
  delivery_columns: string[];
  trace: Record<string, unknown>;
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
): { label: string; value: string; uom: string }[] {
  const used = new Set<string>();
  const attrs: { label: string; value: string; uom: string }[] = [];

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
      if (value) {
        attrs.push({ label: sf.label, value, uom: sf.unit ?? "" });
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
    "e1_brand", "unilog_brand", "dib_brand",
    // These appear in dedicated top-level columns, not attribute slots
  ]);
  for (const [key, field] of Object.entries(normalizedFields)) {
    if (used.has(key)) continue;
    if (SKIP_IN_ATTRS.has(key.toLowerCase())) continue;
    const value = String(field.value ?? "").trim();
    if (!value) continue;
    // Convert snake_case key to Title Case label for display
    const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    attrs.push({ label, value, uom: "" });
  }

  return attrs;
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
  let officialSourceData: Partial<UnilogDeliveryRecord> | undefined;
  let resolvedBrand: { name: string; sourceKey: string } | null | undefined;
  let resolvedManufacturer: { name: string; sourceKey: string } | null | undefined;

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
  } else {
    // Legacy positional call: runFormatting(fields, officialSourceData?)
    normalizedFields = inputOrFields as Record<string, ExtractedField>;
    officialSourceData = officialSourceDataLegacy;
  }

  const schema = loadDeliverySchema();
  const sourceRow = rowFromFields(normalizedFields);

  // Build dynamic, category-specific attribute list from LLM schema fields
  const schemaFields = classificationResult?.schema_fields ?? [];
  const extraAttributes = buildExtraAttributes(schemaFields, normalizedFields);

  const formatted = buildUnilogDeliveryRecord(sourceRow, {
    columns: schema.columns,
    categoryExamples: [],   // No GT-peeking: category comes from classify.ts classpath
    extraAttributes,        // Fully dynamic, category-specific, from LLM
    officialSourceData,
    officialAssetsFound: Boolean(
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
  }
  
  if (resolvedBrand?.name) {
    formatted.record.BRAND_NAME = resolvedBrand.name;
  }
  
  if (resolvedManufacturer?.name) {
    formatted.record.MANUFACTURER_NAME = resolvedManufacturer.name;
  }

  return {
    delivery_formats: {
      mobile_desc: formatted.record.MOBILE_DESC,
      short_desc: formatted.record.SHORT_DESC,
      long_desc: formatted.record.LONG_DESC1,
      invoice_desc: formatted.record.INVOICE_DESC,
      retail_desc: formatted.record.RETAIL_DESC,
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