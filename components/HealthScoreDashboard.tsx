"use client";

import { useState } from "react";
import ProductCard from "./ProductCard";

export interface PipelineResult {
  schema_match: string;
  extracted_fields: Record<string, {
    value: string | number;
    confidence: number;
    source_location: string;
    extraction_method: "explicit" | "inferred";
  }>;
  extraction_notes: string;
  validation_result: {
    overall_status: "valid" | "flagged" | "invalid";
    flags: Array<{
      field: string;
      severity: "error" | "warning" | "missing";
      rule_type: "schema_rule" | "cross_field_rule" | "inferred_check";
      message: string;
      current_value: string | null;
    }>;
    summary: string;
  } | null;
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
  is_unverified: boolean;
  pipeline_warnings: string[];
  health_score: number;
  input?: string;
  status: "success" | "error";
  error?: string;
}

interface BatchSummary {
  avg_health_score: number;
  validation_status_counts: {
    valid: number;
    flagged: number;
    invalid: number;
  };
  total_gap_asks: number;
  sorted_products: PipelineResult[];
}

interface HealthScoreDashboardProps {
  batchId: string;
  summary: BatchSummary;
  products: PipelineResult[];
}

export default function HealthScoreDashboard({
  batchId,
  summary,
  products,
}: HealthScoreDashboardProps) {
  const [expandedProductIdx, setExpandedProductIdx] = useState<number | null>(null);

  const avg = summary.avg_health_score;
  const scoreColor =
    avg >= 80
      ? "text-emerald-600 bg-emerald-50 border-emerald-200"
      : avg >= 50
      ? "text-amber-600 bg-amber-50 border-amber-200"
      : "text-red-600 bg-red-50 border-red-200";

  return (
    <div className="space-y-6">
      {/* ── 1. TOP SUMMARY BAR ────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Batch Catalog Health</h2>
            <p className="text-xs text-gray-400 font-mono mt-0.5">ID: {batchId}</p>
          </div>
          <div className={`flex items-center gap-2 border px-4 py-2 rounded-lg ${scoreColor}`}>
            <span className="text-sm font-semibold uppercase tracking-wider">Avg Health</span>
            <span className="text-2xl font-black">{avg}/100</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 border-t border-gray-100 pt-4 text-center">
          <div>
            <span className="block text-xs text-gray-400 font-medium">Total Products</span>
            <span className="text-lg font-bold text-gray-800">{products.length}</span>
          </div>
          <div>
            <span className="block text-xs text-gray-400 font-medium">Flagged/Invalid</span>
            <span className="text-lg font-bold text-amber-600">
              {summary.validation_status_counts.flagged + summary.validation_status_counts.invalid}
            </span>
          </div>
          <div>
            <span className="block text-xs text-gray-400 font-medium">Total Gap Asks</span>
            <span className="text-lg font-bold text-slate-800">{summary.total_gap_asks}</span>
          </div>
        </div>
      </div>

      {/* ── 2. PRODUCT LIST (sorted worst-first) ─────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="border-b border-gray-100 p-4 bg-gray-50/50">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Breakdown (Worst Health Score First)
          </h3>
        </div>

        <div className="divide-y divide-gray-100">
          {summary.sorted_products.map((prod, idx) => {
            const pName = (prod.extracted_fields?.["product_name"]?.value as string) || "Unnamed Product";
            const valStatus = prod.validation_result?.overall_status || (prod.is_unverified ? "flagged" : "valid");

            const badgeConfig = {
              valid: "bg-emerald-50 text-emerald-700 border-emerald-200",
              flagged: "bg-amber-50 text-amber-700 border-amber-200",
              invalid: "bg-red-50 text-red-700 border-red-200",
            };

            const scoreBadgeColor =
              prod.health_score >= 80
                ? "bg-emerald-100 text-emerald-800"
                : prod.health_score >= 50
                ? "bg-amber-100 text-amber-800"
                : "bg-red-100 text-red-800";

            const gapCount = prod.gap_resolution?.gap_asks?.length ?? 0;
            const isExpanded = expandedProductIdx === idx;

            return (
              <div key={idx} className="transition">
                {/* Product row summary */}
                <div
                  onClick={() => setExpandedProductIdx(isExpanded ? null : idx)}
                  className="flex items-center justify-between p-4 hover:bg-gray-50 cursor-pointer gap-4 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-gray-900 truncate">{pName}</span>
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-gray-100 text-gray-500 rounded uppercase">
                        {prod.schema_match}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
                      <span className={`inline-flex px-1.5 py-0.2 border rounded text-[10px] font-semibold capitalize ${badgeConfig[valStatus]}`}>
                        {valStatus}
                      </span>
                      <span>•</span>
                      <span>{gapCount} gaps</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${scoreBadgeColor}`}>
                      {prod.health_score}/100
                    </span>
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="p-4 bg-slate-50/50 border-t border-gray-100">
                    {prod.status === "error" ? (
                      <div className="bg-red-50 border border-red-200 text-red-800 text-xs p-3 rounded-lg">
                        <strong>Error:</strong> {prod.error || "Failed to process item."}
                      </div>
                    ) : (
                      <ProductCard result={prod} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
