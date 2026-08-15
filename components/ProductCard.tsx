"use client";

import { useState } from "react";
import ConfidenceBadge from "./ConfidenceBadge";

// ---------------------------------------------------------------------------
// Types matching PipelineResult from page.tsx / types.ts
// ---------------------------------------------------------------------------

interface ExtractedField {
  value: string | number;
  confidence: number;
  source_location: string;
  extraction_method: "explicit" | "inferred";
}

interface ValidationFlag {
  field: string;
  severity: "error" | "warning" | "missing";
  rule_type: "schema_rule" | "cross_field_rule" | "inferred_check";
  message: string;
  current_value: string | null;
}

interface ValidationResult {
  overall_status: "valid" | "flagged" | "invalid";
  flags: ValidationFlag[];
  summary: string;
}

export interface ProductCardProps {
  result: {
    schema_match: string;
    extracted_fields: Record<string, ExtractedField>;
    extraction_notes: string;
    validation_result: ValidationResult | null;
    gap_resolution?: {
      confident_fills: Record<string, {
        value: string | number;
        confidence: number;
        reasoning: string;
        extraction_method: "inferred";
      }>;
      gap_asks: Array<{
        field: string;
        ask_message: string;
        suggested_source_type: string;
      }>;
      supplier_request_draft: {
        subject: string;
        body: string;
      } | null;
      summary: string;
    } | null;
    reconciliation_result?: {
      reconciled_fields: Record<string, {
        value: string | number;
        confidence: number;
        source_location: string;
        resolution_type: "single_source" | "agreement" | "trust_hierarchy" | "needs_human_review";
      }>;
      disagreement_log: Array<{
        field: string;
        sources: Array<{
          source_name: string;
          source_type: string;
          value: string;
          confidence?: number;
        }>;
        resolution: string;
        reasoning: string;
      }>;
      summary: string;
    } | null;
    is_unverified: boolean;
    pipeline_warnings: string[];
  };
}


// ---------------------------------------------------------------------------
// Label & Unit mapping dictionary for cleaner presentation
// ---------------------------------------------------------------------------

interface FieldMeta {
  label: string;
  unit?: string;
}

const FIELD_META_MAP: Record<string, FieldMeta> = {
  product_name: { label: "Product Name" },
  fastener_type: { label: "Fastener Type" },
  material: { label: "Material" },
  diameter_mm: { label: "Diameter", unit: "mm" },
  length_mm: { label: "Length", unit: "mm" },
  thread_pitch_mm: { label: "Thread Pitch", unit: "mm" },
  tensile_strength_mpa: { label: "Tensile Strength", unit: "MPa" },
  corrosion_resistance: { label: "Corrosion Resistance Rating" },
  compliance_tags: { label: "Compliance & Standards" },
  connector_type: { label: "Connector Type" },
  rated_voltage_v: { label: "Rated Voltage", unit: "V" },
  rated_current_a: { label: "Rated Current", unit: "A" },
  wire_gauge_range_awg: { label: "Wire Gauge Range" },
  housing_material: { label: "Housing Material" },
  operating_temp_range_c: { label: "Operating Temperature Range" },
  ip_rating: { label: "IP Rating" },
};

function getFieldMeta(key: string): FieldMeta {
  if (FIELD_META_MAP[key]) {
    return FIELD_META_MAP[key];
  }
  // Generic fallback: format key cleanly
  const label = key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return { label };
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function ProductCard({ result }: ProductCardProps) {
  const {
    schema_match,
    extracted_fields,
    extraction_notes,
    validation_result,
    gap_resolution,
    reconciliation_result,
    is_unverified,
  } = result;

  // Track expanded validation flags for inline view
  const [expandedFlags, setExpandedFlags] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  // ── Stats calculations ───────────────────────────────────────────────────
  const fields = Object.entries(extracted_fields);
  const totalFields = fields.length;
  const avgConfidence =
    totalFields > 0
      ? Math.round(fields.reduce((acc, [, f]) => acc + f.confidence, 0) / totalFields)
      : 0;

  const productName =
    (extracted_fields["product_name"]?.value as string) || "Unnamed Product";

  // ── Validation flags parsing ─────────────────────────────────────────────
  const flags = validation_result?.flags ?? [];
  const errors = flags.filter((f) => f.severity === "error");
  const warnings = flags.filter((f) => f.severity === "warning" || f.severity === "missing");

  // Helper to find flags associated with a specific field key
  const getFieldFlags = (key: string) => {
    return flags.filter((flag) => {
      // Direct match or part of comma-separated list
      const fields = flag.field.split(",").map((f) => f.trim());
      return fields.includes(key);
    });
  };

  const toggleFlagExpansion = (key: string) => {
    setExpandedFlags((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleCopyRequest = () => {
    if (gap_resolution?.supplier_request_draft?.body) {
      navigator.clipboard.writeText(gap_resolution.supplier_request_draft.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // ── UI Styles helpers ────────────────────────────────────────────────────
  const statusConfig = {
    valid: {
      bg: "bg-emerald-50 text-emerald-800 border-emerald-200",
      label: "Valid",
      dot: "bg-emerald-500",
    },
    flagged: {
      bg: "bg-amber-50 text-amber-800 border-amber-200",
      label: "Flagged",
      dot: "bg-amber-500",
    },
    invalid: {
      bg: "bg-red-50 text-red-800 border-red-200",
      label: "Invalid",
      dot: "bg-red-500",
    },
  };

  const validationStatus = validation_result?.overall_status || (is_unverified ? "flagged" : "valid");
  const activeStatus = statusConfig[validationStatus as keyof typeof statusConfig] || statusConfig.flagged;

  const fills = gap_resolution?.confident_fills ? Object.entries(gap_resolution.confident_fills) : [];
  const asks = gap_resolution?.gap_asks ?? [];
  const hasGaps = fills.length > 0 || asks.length > 0;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden text-gray-800">
      
      {/* ── 1. HEADER SECTION ────────────────────────────────────────────── */}
      <div className="border-b border-gray-100 p-6 bg-gray-50/50">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-gray-900 tracking-tight">
              {productName}
            </h2>
            
            {/* Category / Schema match info */}
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-medium text-xs">
                {schema_match === "fasteners" ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                ) : schema_match === "electrical_connectors" ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
                {schema_match === "fasteners"
                  ? "Fasteners Schema"
                  : schema_match === "electrical_connectors"
                  ? "Connectors Schema"
                  : "Unclassified Product"}
              </span>

              {is_unverified && (
                <span className="text-xs font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-100">
                  Unverified
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-6">
            {/* Avg Confidence Indicator */}
            <div className="text-right">
              <span className="text-xs text-gray-400 block font-medium mb-1">Avg Confidence</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-700">{avgConfidence}%</span>
                <div className="w-20 bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      avgConfidence >= 85
                        ? "bg-emerald-500"
                        : avgConfidence >= 60
                        ? "bg-amber-500"
                        : "bg-red-500"
                    }`}
                    style={{ width: `${avgConfidence}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Validation Badge */}
            <div className="text-right">
              <span className="text-xs text-gray-400 block font-medium mb-1">Validation Status</span>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 border rounded-lg text-sm font-semibold shadow-xs ${activeStatus.bg}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${activeStatus.dot}`} />
                {activeStatus.label}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. FIELD LIST SECTION ────────────────────────────────────────── */}
      <div className="p-6">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Extracted Product Data
        </h3>
        
        <div className="border border-gray-100 rounded-lg overflow-hidden divide-y divide-gray-100">
          {fields.map(([key, field]) => {
            const meta = getFieldMeta(key);
            const fieldFlags = getFieldFlags(key);
            const hasError = fieldFlags.some((f) => f.severity === "error");
            
            return (
              <div key={key} className="bg-white">
                <div className="flex items-center justify-between p-4 hover:bg-gray-50 transition-colors gap-4">
                  {/* Left Column: Label, Info Icon, Status Dot */}
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Validation Flag Dot */}
                    {fieldFlags.length > 0 && (
                      <button
                        onClick={() => toggleFlagExpansion(key)}
                        title="Click to view validation details"
                        className="shrink-0 p-1 -m-1 focus:outline-none"
                      >
                        <span
                          className={`flex h-2.5 w-2.5 rounded-full ring-4 cursor-pointer animate-pulse ${
                            hasError ? "bg-red-500 ring-red-100" : "bg-amber-500 ring-amber-100"
                          }`}
                        />
                      </button>
                    )}

                    <span className="text-sm font-medium text-gray-900 truncate">
                      {meta.label}
                    </span>

                    {/* Simple CSS Tooltip for Source Location */}
                    <div className="relative group shrink-0">
                      <span className="cursor-help text-gray-300 hover:text-gray-500">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </span>
                      <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block w-48 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-20 leading-tight">
                        <div className="font-semibold mb-0.5">Source Details:</div>
                        <div className="text-gray-300">Loc: {field.source_location}</div>
                        <div className="text-gray-300 mt-1 capitalize">Method: {field.extraction_method}</div>
                        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Value, Unit, Confidence Badge */}
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm text-gray-700 font-semibold bg-gray-50 border border-gray-100 px-2 py-0.5 rounded">
                      {String(field.value)}
                      {meta.unit ? ` ${meta.unit}` : ""}
                    </span>
                    <ConfidenceBadge score={field.confidence} />
                  </div>
                </div>

                {/* Inline Validation Details (Expanded when clicking Dot) */}
                {expandedFlags[key] && fieldFlags.length > 0 && (
                  <div className="px-4 pb-4 bg-gray-50/50 border-t border-gray-100/50 pt-2 space-y-2">
                    {fieldFlags.map((flag, idx) => (
                      <div
                        key={idx}
                        className={`text-xs border-l-2 pl-3 py-1 ${
                          flag.severity === "error"
                            ? "border-red-500 text-red-700"
                            : "border-amber-500 text-amber-700"
                        }`}
                      >
                        <span className="font-bold uppercase tracking-wider text-[10px] mr-1.5">
                          {flag.severity} ({flag.rule_type}):
                        </span>
                        {flag.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── 3. VALIDATION SUMMARY SECTION ────────────────────────────────── */}
      {validation_result && flags.length > 0 && (
        <div className="border-t border-gray-100 p-6 bg-gray-50/30">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Validation Summary
          </h3>
          
          <div className="space-y-3">
            {/* Show Errors First */}
            {errors.map((flag, idx) => (
              <div key={`err-${idx}`} className="flex items-start gap-3 bg-white border border-red-100 rounded-lg p-4 shadow-2xs">
                <span className="inline-flex shrink-0 px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800 uppercase">
                  Error
                </span>
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-gray-700 font-mono">
                      {flag.field}
                    </span>
                    <span className="px-1.5 py-0.2 text-[10px] font-medium text-gray-400 bg-gray-100 rounded">
                      {flag.rule_type}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 leading-normal">{flag.message}</p>
                </div>
              </div>
            ))}

            {/* Show Warnings Second */}
            {warnings.map((flag, idx) => (
              <div key={`warn-${idx}`} className="flex items-start gap-3 bg-white border border-amber-100 rounded-lg p-4 shadow-2xs">
                <span className={`inline-flex shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                  flag.severity === "missing" ? "bg-gray-150 text-gray-700" : "bg-amber-100 text-amber-800"
                }`}>
                  {flag.severity}
                </span>
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-bold text-gray-700 font-mono">
                      {flag.field}
                    </span>
                    <span className="px-1.5 py-0.2 text-[10px] font-medium text-gray-400 bg-gray-100 rounded">
                      {flag.rule_type}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 leading-normal">{flag.message}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 4. GAPS & NEXT STEPS SECTION ─────────────────────────────────── */}
      {gap_resolution && (
        <div className="border-t border-gray-100 p-6 bg-slate-50/50">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Gaps &amp; Next Steps
          </h3>

          {!hasGaps ? (
            <div className="flex items-center gap-2 text-emerald-800 bg-emerald-50 border border-emerald-100 p-3 rounded-lg text-sm font-medium">
              <svg className="w-5 h-5 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
              </svg>
              No gaps — fully resolved
            </div>
          ) : (
            <div className="space-y-4">
              {/* Confident Fills (AI-Inferred) */}
              {fills.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 mb-2">AI-Inferred (Unverified)</h4>
                  <div className="space-y-2">
                    {fills.map(([key, fill]) => {
                      const meta = getFieldMeta(key);
                      return (
                        <div key={key} className="flex items-center justify-between bg-white border border-gray-100 p-3 rounded-lg text-sm shadow-3xs">
                          <div className="min-w-0 pr-4">
                            <div className="font-semibold text-gray-900">{meta.label}</div>
                            <div className="text-xs text-gray-500 italic mt-0.5">{fill.reasoning}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-semibold text-gray-700 bg-gray-50 px-2 py-0.5 border border-gray-100 rounded">
                              {String(fill.value)}
                              {meta.unit ? ` ${meta.unit}` : ""}
                            </span>
                            <span className="text-[10px] font-bold text-gray-500 bg-gray-100 px-2 py-0.5 rounded border border-gray-200/50 uppercase tracking-wider">
                              Inferred ({fill.confidence}%)
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Gap Asks */}
              {asks.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 mb-2">Required Information</h4>
                  <div className="grid grid-cols-1 gap-3">
                    {asks.map((ask, idx) => {
                      const meta = getFieldMeta(ask.field);
                      return (
                        <div key={idx} className="bg-white border border-gray-200 rounded-lg p-4 shadow-3xs space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-bold text-sm text-gray-800">{meta.label}</span>
                            <span className="inline-flex px-2 py-0.5 text-[10px] font-semibold text-gray-600 bg-gray-100 rounded border border-gray-200 uppercase tracking-wider shrink-0">
                              {ask.suggested_source_type.replace(/_/g, " ")}
                            </span>
                          </div>
                          <p className="text-sm text-gray-600 leading-normal">{ask.ask_message}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Supplier Request Draft */}
              {asks.length > 0 && gap_resolution.supplier_request_draft && (
                <div className="border-t border-gray-200/60 pt-4 space-y-3">
                  <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-3xs space-y-2">
                    <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Supplier Request Draft
                    </div>
                    <div className="text-xs font-bold text-gray-700 pb-2 border-b border-gray-100">
                      Subject: {gap_resolution.supplier_request_draft.subject}
                    </div>
                    <pre className="text-xs text-gray-600 font-mono whitespace-pre-wrap pt-2 overflow-auto max-h-48 leading-relaxed">
                      {gap_resolution.supplier_request_draft.body}
                    </pre>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyRequest}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-gray-900 hover:bg-gray-800 text-white font-semibold py-2 px-4 text-sm transition shadow-sm"
                  >
                    {copied ? (
                      <>
                        <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                        </svg>
                        Copied!
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                        </svg>
                        Copy Supplier Request
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 5. RECONCILIATION SECTION ───────────────────────────────────── */}
      {reconciliation_result && reconciliation_result.disagreement_log && reconciliation_result.disagreement_log.length > 0 && (
        <div className="border-t border-gray-100 p-6 bg-blue-50/10">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Source Reconciliation (Disagreement Log)
          </h3>
          <div className="space-y-4">
            {reconciliation_result.disagreement_log.map((log, idx) => {
              const meta = getFieldMeta(log.field);
              const needsReview = log.resolution === "flagged for human review" || log.resolution.toLowerCase().includes("human_review") || log.resolution.toLowerCase().includes("review");
              return (
                <div key={idx} className={`border rounded-lg p-4 bg-white shadow-3xs space-y-3 ${needsReview ? "border-amber-200" : "border-slate-100"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sm text-slate-800">{meta.label}</span>
                    {needsReview ? (
                      <span className="inline-flex px-2 py-0.5 text-[10px] font-bold bg-amber-50 text-amber-700 rounded border border-amber-200 uppercase tracking-wider">
                        Needs Human Review
                      </span>
                    ) : (
                      <span className="inline-flex px-2 py-0.5 text-[10px] font-semibold bg-slate-50 text-slate-600 rounded border border-slate-200 uppercase tracking-wider">
                        Auto-Resolved
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-slate-400">Claims:</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {log.sources.map((src, sIdx) => (
                        <div key={sIdx} className="bg-slate-50/50 p-2 rounded border border-slate-100 text-xs flex justify-between gap-2">
                          <span className="font-medium text-slate-600">{src.source_name} ({src.source_type.replace(/_/g, " ")}):</span>
                          <span className="font-bold text-slate-800">{src.value}{src.confidence !== undefined ? ` (conf: ${src.confidence}%)` : ""}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-xs pt-2 border-t border-slate-50 flex flex-col sm:flex-row sm:items-start gap-2">
                    <div className="font-bold text-slate-600 shrink-0">Resolution:</div>
                    <div className="text-slate-800 font-medium">{log.resolution}</div>
                  </div>
                  <div className="text-xs flex flex-col sm:flex-row sm:items-start gap-2">
                    <div className="font-bold text-slate-600 shrink-0">Reasoning:</div>
                    <div className="text-slate-700 italic">{log.reasoning}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 6. NOTES SECTION ─────────────────────────────────────────────── */}
      {(extraction_notes || (validation_result && validation_result.summary)) && (
        <div className="border-t border-gray-100 p-6 bg-gray-50/50">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Audit Notes
          </h3>
          <div className="space-y-2 text-xs text-gray-500 leading-relaxed italic">
            {validation_result?.summary && (
              <p>Validation summary: {validation_result.summary}</p>
            )}
            {extraction_notes && (
              <p>Extraction observations: {extraction_notes}</p>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

