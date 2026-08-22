"use client";

import { useState, useRef, FormEvent } from "react";
import ProductCard from "@/components/ProductCard";
import HealthScoreDashboard from "@/components/HealthScoreDashboard";
import type { BatchResponse } from "@/lib/batch-types";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Types
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

interface PipelineResult {
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
  is_unverified: boolean;
  pipeline_warnings: string[];
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function Home() {
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [showRaw,      setShowRaw]      = useState(false);

  // Batch state
  const [batchText,     setBatchText]     = useState("");
  const [batchCsvFile,  setBatchCsvFile]  = useState<File | null>(null);
  const [batchResponse, setBatchResponse] = useState<BatchResponse | null>(null);

  const csvInputRef = useRef<HTMLInputElement>(null);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function parseBatchText(rawInput: string): Array<{ raw_text: string }> {
    return rawInput
      .replace(/\r\n/g, "\n")
      .split(/\n[ \t]*---[ \t]*\n|^[ \t]*---[ \t]*$/m)
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ raw_text: text }));
  }

  async function processBatchItems(items: Array<{ raw_text: string }>) {
    setLoading(true);
    try {
      const res = await fetch("/api/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: items, categoryHint: "auto" }),
      });
      const json = await res.json();
      if (res.ok) {
        setBatchResponse(json as BatchResponse);
      } else {
        setError(`Batch processing failed: ${json?.error ?? res.statusText}`);
      }
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBatchResponse(null);
    setShowRaw(false);

    if (batchCsvFile) {
      Papa.parse(batchCsvFile, {
        header: true,
        skipEmptyLines: true,
        complete: async (results) => {
          const items = (results.data as any[])
            .map((row) => {
              const name = row.product_name ?? row.Mfg_Part_Num ?? "";
              const text = row.raw_text ?? row.Part_Desc ?? "";
              const manuf = row.Part_Manuf ?? row.E1_Brand ?? "";
              const combined = [
                name ? `MPN: ${name}` : null,
                text ? `Description: ${text}` : null,
                manuf ? `Manufacturer: ${manuf}` : null,
              ].filter(Boolean).join("\n");
              return { raw_text: combined };
            })
            .filter((item) => item.raw_text.trim());

          if (items.length === 0) {
            setError("CSV parsed but no valid rows found (need product_name or raw_text columns).");
            return;
          }
          await processBatchItems(items);
        },
        error: (err) => setError(`Failed to parse CSV: ${err.message}`),
      });
      return;
    }

    if (batchText.trim()) {
      const items = parseBatchText(batchText);
      if (items.length === 0) {
        setError("No valid products found. Separate multiple products with '---' on its own line.");
        return;
      }
      await processBatchItems(items);
      return;
    }

    setError("Please upload a CSV file or paste product text below.");
  }

  // ── Download helpers ──────────────────────────────────────────────────────

  /** Flatten one product result into a plain object suitable for CSV/Excel export */
  function flattenProduct(prod: any, idx: number): Record<string, string | number> {
    // Prefer delivery_record (full Unilog 252-column shape) when available
    if (prod.delivery_record && typeof prod.delivery_record === "object") {
      return {
        "#": idx + 1,
        health_score: prod.health_score ?? "",
        validation_status: prod.validation_result?.overall_status ?? (prod.is_unverified ? "unverified" : "valid"),
        pipeline_warnings: (prod.pipeline_warnings ?? []).join(" | "),
        ...prod.delivery_record,
      };
    }
    // Fallback: flatten extracted_fields
    const row: Record<string, string | number> = {
      "#": idx + 1,
      schema_match: prod.schema_match ?? "",
      health_score: prod.health_score ?? "",
      validation_status: prod.validation_result?.overall_status ?? (prod.is_unverified ? "unverified" : "valid"),
      pipeline_warnings: (prod.pipeline_warnings ?? []).join(" | "),
    };
    for (const [key, field] of Object.entries(prod.extracted_fields ?? {})) {
      const f = field as any;
      row[key] = f.value ?? "";
    }
    return row;
  }

  function downloadCSV() {
    if (!batchResponse) return;
    const rows = batchResponse.products.map(flattenProduct);
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `catalogiq-${batchResponse.batch_id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadExcel() {
    if (!batchResponse) return;
    const rows = batchResponse.products.map(flattenProduct);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "CatalogIQ");
    XLSX.writeFile(wb, `catalogiq-${batchResponse.batch_id}.xlsx`);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main
      className="relative min-h-screen py-16 px-4"
      style={{ position: "relative", zIndex: 1 }}
    >
      <div className="max-w-2xl mx-auto space-y-8">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="animate-fade-up text-center space-y-3">
          {/* Logo mark */}
          <div className="flex justify-center mb-4">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, #4f7cff 0%, #a78bfa 100%)",
                boxShadow: "0 0 32px rgba(79,124,255,0.4)",
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M4 6h16M4 10h10M4 14h13M4 18h8" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                <circle cx="19" cy="17" r="3" fill="rgba(255,255,255,0.3)" stroke="white" strokeWidth="1.5"/>
                <path d="M21.5 19.5L23 21" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
          </div>

          <h1 className="text-4xl font-bold tracking-tight gradient-text">CatalogIQ</h1>
          <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
            Paste product descriptions or upload a CSV — the AI pipeline extracts,<br />
            validates and enriches structured data automatically.
          </p>
        </div>

        {/* ── Input Card ──────────────────────────────────────────────────── */}
        <div
          className="card-surface p-6 animate-fade-up space-y-5"
          style={{ animationDelay: "0.08s" }}
        >

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* CSV Upload */}
            <div className="space-y-2">
              <label
                htmlFor="csv-upload"
                className="text-xs font-semibold uppercase tracking-widest"
                style={{ color: "var(--text-secondary)" }}
              >
                Upload CSV
              </label>
              <div
                className="relative rounded-xl border p-4 transition-all"
                style={{
                  borderColor: batchCsvFile ? "var(--accent-blue)" : "var(--border-subtle)",
                  background: batchCsvFile ? "rgba(79,124,255,0.06)" : "var(--bg-surface)",
                }}
              >
                <input
                  id="csv-upload"
                  ref={csvInputRef}
                  type="file"
                  accept=".csv"
                  onChange={(e) => {
                    const picked = e.target.files?.[0] ?? null;
                    setBatchCsvFile(picked);
                    if (picked) setBatchText("");
                  }}
                  className="block w-full text-sm cursor-pointer"
                  style={{ color: "var(--text-secondary)" }}
                />
                <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                  CSV columns: <span style={{ color: "var(--accent-cyan)" }}>Mfg_Part_Num</span>,{" "}
                  <span style={{ color: "var(--accent-cyan)" }}>Part_Desc</span>,{" "}
                  <span style={{ color: "var(--accent-cyan)" }}>Part_Manuf</span> (or generic product_name / raw_text)
                </p>
                {batchCsvFile && (
                  <div className="mt-3 flex items-center gap-2 animate-fade-in">
                    <span className="badge badge-blue">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      {batchCsvFile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setBatchCsvFile(null);
                        if (csvInputRef.current) csvInputRef.current.value = "";
                      }}
                      className="text-xs transition"
                      style={{ color: "var(--text-muted)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
                    >
                      ✕ Remove
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Divider */}
            <div className="divider">or paste product text</div>

            {/* Text area */}
            <div className="space-y-2">
              <label
                className="text-xs font-semibold uppercase tracking-widest"
                style={{ color: "var(--text-secondary)" }}
              >
                Raw Product Text
              </label>
              <textarea
                value={batchText}
                onChange={(e) => {
                  setBatchText(e.target.value);
                  if (e.target.value && batchCsvFile) {
                    setBatchCsvFile(null);
                    if (csvInputRef.current) csvInputRef.current.value = "";
                  }
                }}
                rows={8}
                placeholder={`Paste one or multiple product descriptions here.\nSeparate multiple products with --- on its own line.\n\nExample:\nBosch 500 Series Dishwasher, stainless steel, 44dBA...\n---\nKitchenAid 24-inch Built-In Dishwasher, 46dBA...`}
                className="input-surface w-full px-4 py-3 text-sm resize-y leading-relaxed"
                style={{ minHeight: "160px", fontFamily: "inherit" }}
              />
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Separate multiple products with <code style={{ color: "var(--accent-cyan)", fontFamily: "monospace" }}>---</code> on its own line
              </p>
            </div>

            {/* Error */}
            {error && (
              <div
                className="rounded-xl px-4 py-3 text-sm flex items-start gap-2.5 animate-fade-in"
                style={{
                  background: "rgba(248,113,113,0.08)",
                  border: "1px solid rgba(248,113,113,0.25)",
                  color: "var(--danger)",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 mt-0.5">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                  <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              id="process-btn"
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-3 text-sm tracking-wide"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2.5">
                  <Spinner />
                  <span className="animate-pulse-slow">Processing pipeline…</span>
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M13 10V3L4 14h7v7l9-11h-7z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Run Enrichment Pipeline
                </span>
              )}
            </button>
          </form>
        </div>

        {/* ── Batch Results ────────────────────────────────────────────────── */}
        {batchResponse && (
          <div
            className="space-y-6 animate-fade-up"
            id="batch-pipeline-output"
          >
            {/* Results header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center"
                  style={{ background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.25)" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                    Pipeline Complete
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    {batchResponse.products?.length ?? 0} product{(batchResponse.products?.length ?? 0) !== 1 ? "s" : ""} processed
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Download CSV */}
                <button
                  type="button"
                  id="download-csv-btn"
                  onClick={downloadCSV}
                  disabled={loading}
                  className="text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
                  style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-secondary)",
                    opacity: loading ? 0.4 : 1,
                    cursor: loading ? "not-allowed" : "pointer",
                  }}
                  onMouseEnter={(e) => {
                    if (loading) return;
                    e.currentTarget.style.borderColor = "var(--accent-cyan)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3v13M7 11l5 5 5-5M5 21h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  CSV
                </button>

                {/* Download Excel */}
                <button
                  type="button"
                  id="download-excel-btn"
                  onClick={downloadExcel}
                  disabled={loading}
                  className="text-xs px-3 py-1.5 rounded-lg transition flex items-center gap-1.5"
                  style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-secondary)",
                    opacity: loading ? 0.4 : 1,
                    cursor: loading ? "not-allowed" : "pointer",
                  }}
                  onMouseEnter={(e) => {
                    if (loading) return;
                    e.currentTarget.style.borderColor = "#22c55e";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3v13M7 11l5 5 5-5M5 21h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Excel
                </button>

                {/* Raw JSON toggle */}
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-xs px-3 py-1.5 rounded-lg transition"
                  style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-secondary)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent-blue)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border-subtle)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  {showRaw ? "Hide JSON" : "View raw JSON"}
                </button>
              </div>
            </div>

            <HealthScoreDashboard
              batchId={batchResponse.batch_id}
              summary={batchResponse.summary}
              products={batchResponse.products}
            />

            {showRaw && (
              <div
                className="rounded-xl p-4 overflow-auto animate-fade-in"
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  maxHeight: "320px",
                }}
              >
                <pre
                  className="text-xs leading-relaxed font-mono"
                  style={{ color: "var(--accent-cyan)" }}
                >
                  {JSON.stringify(batchResponse, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div className="pb-4 text-center">
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Powered by Gemini · Built for UNIHACK 2026
          </p>
        </div>

      </div>
    </main>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8h4z"
      />
    </svg>
  );
}
