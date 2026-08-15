// =============================================================================
// CatalogIQ — TypeScript Types
// Derived from schemas/fasteners.json and schemas/connectors.json
// =============================================================================

// ---------------------------------------------------------------------------
// 1. ProductSchema — mirrors the shape of any *.json file in /schemas
// ---------------------------------------------------------------------------

/** Validation rules attached to a single field (any subset may be present). */
export interface FieldValidation {
  /** Exhaustive list of allowed string values for enum / array fields. */
  allowedValues?: string[];
  /** Inclusive minimum for numeric fields. */
  min?: number;
  /** Inclusive maximum for numeric fields. */
  max?: number;
  /** Regex pattern description for string fields (human-readable hint). */
  pattern?: string;
  /** Free-text note for the agent to consider during validation. */
  note?: string;
}

/** A single field definition inside a ProductSchema. */
export interface SchemaField {
  /** Unique machine key, e.g. "diameter_mm" */
  key: string;
  /** Human-readable label, e.g. "Diameter" */
  label: string;
  /** JSON-compatible data type */
  type: "string" | "number" | "enum" | "array" | "boolean";
  /** Physical unit string when applicable, e.g. "mm", "V", "A" */
  unit?: string;
  /** Whether absence of this field should be treated as a hard gap. */
  required: boolean;
  /** Validation rules; null means no constraints beyond type. */
  validation: FieldValidation | null;
}

/** A cross-field business rule that cannot be expressed as a single-field constraint. */
export interface CrossFieldRule {
  /** Short machine-readable identifier, e.g. "material_vs_corrosion" */
  rule: string;
  /** Agent-readable description of what constitutes a violation. */
  description: string;
  /** How seriously the agent should treat a violation. */
  severity: "error" | "warning" | "info";
}

/**
 * The top-level shape of any JSON file placed in /schemas.
 * Both fasteners.json and connectors.json conform to this type.
 */
export interface ProductSchema {
  /** Machine category key — used as the schema_match discriminator. */
  category: SchemaCategory;
  /** Human-readable display name. */
  displayName: string;
  /** Brief description of what this schema covers. */
  description: string;
  /** Ordered list of field definitions for this product category. */
  fields: SchemaField[];
  /** Cross-field validation rules to be run after individual field checks. */
  crossFieldRules: CrossFieldRule[];
}

// ---------------------------------------------------------------------------
// 2. ExtractedField — one field extracted from a raw product document
// ---------------------------------------------------------------------------

/**
 * A single field value extracted from a product document, with provenance.
 */
export interface ExtractedField {
  /** The extracted value — string for text/enum, number for quantitative fields. */
  value: string | number;
  /**
   * Agent's confidence in this extraction, in [0, 1].
   * 1.0 = unambiguous verbatim match; 0.0 = pure guess.
   */
  confidence: number;
  /**
   * Where in the source document the value was found.
   * Examples: "title", "bullet_point_3", "table_row_dimensions", "description_paragraph_2"
   */
  source_location: string;
  /**
   * How the value was obtained:
   * - "explicit"  → value was stated literally in the document.
   * - "inferred"  → value was derived from context, units conversion, or cross-reference.
   */
  extraction_method: "explicit" | "inferred";
}

// ---------------------------------------------------------------------------
// 3. ExtractionResult — full output of the extraction agent for one product
// ---------------------------------------------------------------------------

/**
 * All schema categories currently supported.
 * "none" means the agent could not match the product to any known schema.
 */
export type SchemaCategory = "fasteners" | "electrical_connectors" | "none";

/**
 * The structured output returned by POST /api/extract for a single product.
 */
export interface ExtractionResult {
  /** Which schema the agent matched this product against. */
  schema_match: SchemaCategory;
  /**
   * Map of schema field keys → extracted field objects.
   * Keys correspond to SchemaField.key values from the matched schema.
   * Fields not found in the document are simply absent from this map.
   */
  extracted_fields: Record<string, ExtractedField>;
  /** Free-text agent notes, e.g. ambiguities, unusual formatting, caveats. */
  notes: string;
}

// ---------------------------------------------------------------------------
// 4. ValidationFlag — one issue raised by the validation agent
// ---------------------------------------------------------------------------

/**
 * A single validation problem found during schema checking.
 */
export interface ValidationFlag {
  /** The schema field key this flag relates to, or a cross-field rule ID. */
  field: string;
  /**
   * Severity of the issue:
   * - "error"   → violates a hard constraint; product cannot be published.
   * - "warning" → suspicious but recoverable; human review recommended.
   */
  severity: "error" | "warning";
  /** Human-readable explanation of the problem. */
  message: string;
}

// ---------------------------------------------------------------------------
// 5. ValidationResult — full output of the validation agent for one product
// ---------------------------------------------------------------------------

/**
 * The structured output returned by POST /api/validate for a single product.
 */
export interface ValidationResult {
  /** All flags raised during field-level and cross-field validation. */
  flags: ValidationFlag[];
  /**
   * Rolled-up status:
   * - "valid"    → no flags at all.
   * - "flagged"  → one or more warnings, no errors.
   * - "invalid"  → at least one error flag.
   */
  overall_status: "valid" | "flagged" | "invalid";
}

// ---------------------------------------------------------------------------
// 6. DisagreementLogEntry — one reconciled conflict across multiple sources
// ---------------------------------------------------------------------------

/** A single source's claim about a field value. */
export interface SourceClaim {
  /** Descriptive name of the data source, e.g. "supplier_pdf", "web_scrape", "catalog_api" */
  source_name: string;
  /** The value this source reported (serialised to string for uniform diffing). */
  value: string;
}

/**
 * Records how the reconciliation agent resolved a multi-source conflict
 * for a single field.
 */
export interface DisagreementLogEntry {
  /** The schema field key where sources disagreed. */
  field: string;
  /** All source claims that were in conflict. */
  sources: SourceClaim[];
  /**
   * The final resolved value chosen by the agent.
   * May be one of the source values or a synthesised canonical form.
   */
  resolution: string;
  /** Agent's reasoning for choosing this resolution. */
  reasoning: string;
}

// ---------------------------------------------------------------------------
// 7. GapAsk — a missing required (or high-value optional) field needing human input
// ---------------------------------------------------------------------------

/**
 * Represents a structured question the agent surfaces to the user when
 * a field cannot be resolved automatically.
 */
export interface GapAsk {
  /** The schema field key that is missing or unresolvable. */
  field: string;
  /**
   * The natural-language question to show the user.
   * Should be specific and reference the product context where possible.
   */
  ask_message: string;
  /**
   * Hints where the user might find the answer.
   * Examples: "product_datasheet", "manufacturer_website", "physical_inspection"
   */
  suggested_source_type: string;
}

// ---------------------------------------------------------------------------
// 8. FinalProductRecord — the complete result for one processed product
// ---------------------------------------------------------------------------

/**
 * Rolled-up health score for a single product, in [0, 1].
 * 1.0 = all required fields present, confident, validated with no errors.
 */
export type HealthScore = number;

/**
 * The unified output that represents a single product after all agents
 * (extraction → validation → reconciliation → gap-resolution) have run.
 */
export interface FinalProductRecord {
  /** Unique identifier for this processing run (UUID or slug). */
  id: string;

  /** ISO 8601 timestamp of when this record was created. */
  created_at: string;

  /** Raw input product text/URL that was processed. */
  raw_input: string;

  // ── Agent outputs ────────────────────────────────────────────────────────

  /** Output of the extraction agent. */
  extraction: ExtractionResult;

  /** Output of the validation agent. */
  validation: ValidationResult;

  /**
   * Log of all field-level disagreements resolved during reconciliation.
   * Empty if only one source was available or all sources agreed.
   */
  disagreement_log: DisagreementLogEntry[];

  /**
   * Gaps that remain after extraction + gap-resolution attempts.
   * These are surfaced to the user for manual input.
   */
  open_gaps: GapAsk[];

  // ── Rolled-up metrics ────────────────────────────────────────────────────

  /**
   * Overall data quality score for this product.
   * Computed from field coverage, confidence averages, and validation status.
   */
  health_score: HealthScore;

  /**
   * The final merged set of field values after reconciliation.
   * Suitable for display or downstream export.
   */
  resolved_fields: Record<string, ExtractedField>;

  /**
   * Optional free-text summary generated by the orchestrator,
   * describing the product and any notable quality issues.
   */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Utility / convenience re-exports
// ---------------------------------------------------------------------------

/** All schema category strings as a union (excludes "none"). */
export type KnownSchemaCategory = Exclude<SchemaCategory, "none">;

/** A batch of processed products. */
export type BatchResult = FinalProductRecord[];
