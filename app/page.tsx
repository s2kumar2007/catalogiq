"use client";

import { useState, useRef, ChangeEvent, FormEvent } from "react";
import ProductCard from "@/components/ProductCard";
import HealthScoreDashboard from "@/components/HealthScoreDashboard";
import type { BatchResponse } from "@/lib/batch-types";
import Papa from "papaparse";

// ---------------------------------------------------------------------------
// Types (mirrors the orchestrator response shape)
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

interface SourceInput {
  source_name: string;
  source_type: "manufacturer_pdf" | "ecommerce_listing" | "scraped_page";
  raw_text: string;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function Home() {
  const [file,     setFile]     = useState<File | null>(null);
  const [rawText,  setRawText]  = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [result,   setResult]   = useState<PipelineResult | null>(null);
  const [showRaw,  setShowRaw]  = useState(false);

  // Multi-source mode state
  const [isMultiSource, setIsMultiSource] = useState(false);
  const [sources, setSources] = useState<SourceInput[]>([
    { source_name: "", source_type: "manufacturer_pdf", raw_text: "" }
  ]);

  // Batch mode state
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchCsvFile, setBatchCsvFile] = useState<File | null>(null);
  const [batchResponse, setBatchResponse] = useState<BatchResponse | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setFile(picked);
    if (picked) {
      setRawText("");
      setIsMultiSource(false);
      setIsBatchMode(false);
    }
  }

  function handleTextChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setRawText(e.target.value);
    if (e.target.value && file) {
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleAddSource() {
    setSources((prev) => [
      ...prev,
      { source_name: "", source_type: "manufacturer_pdf", raw_text: "" }
    ]);
  }

  function handleRemoveSource(index: number) {
    setSources((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSourceChange(index: number, key: keyof SourceInput, value: string) {
    setSources((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [key]: value };
      return copy;
    });
  }

  async function processBatchItems(items: Array<{ raw_text: string }>) {
    setLoading(true);
    try {
      const payload = {
        products: items,
        categoryHint: "auto"
      };
      const res = await fetch("/api/process-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (res.ok) {
        setBatchResponse(json as BatchResponse);
      } else {
        setError(`Batch processing failed: ${json?.error ?? res.statusText}`);
      }
    } catch (err) {
      setError(`Batch request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  /**
   * Splits a raw batch textarea value on lines that contain only "---".
   * Robust to CRLF line endings, leading/trailing whitespace, and a missing
   * trailing newline after the final separator.
   */
  function parseBatchText(rawInput: string): Array<{ raw_text: string }> {
    const products = rawInput
      .replace(/\r\n/g, "\n")          // normalise Windows CRLF → LF
      .split(/\n[ \t]*---[ \t]*\n|^[ \t]*---[ \t]*$/m)  // line containing only ---
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ raw_text: text }));
    return products;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBatchResponse(null);
    setShowRaw(false);

    if (isBatchMode) {
      if (batchCsvFile) {
        Papa.parse(batchCsvFile, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {
            const items = results.data.map((row: any) => {
              const name = row.product_name || "";
              const text = row.raw_text || "";
              const combined = name ? `Product: ${name}\n\n${text}` : text;
              return { raw_text: combined };
            }).filter((item) => item.raw_text.trim());

            if (items.length === 0) {
              setError("CSV parsed but no valid rows with raw_text found.");
              return;
            }
            await processBatchItems(items);
          },
          error: (err) => {
            setError(`Failed to parse CSV: ${err.message}`);
          }
        });
      } else if (batchText.trim()) {
        const items = parseBatchText(batchText);

        // Permanent diagnostic — visible in browser console on every batch submit
        console.log(`Split into ${items.length} products:`, items);

        if (items.length === 0) {
          setError("No valid products found separated by '---'.");
          return;
        }
        await processBatchItems(items);
      } else {
        setError("Please upload a CSV file or paste product texts in Batch Mode.");
      }
      return;
    }

    const hasTextContent = isMultiSource
      ? sources.some((s) => s.raw_text.trim())
      : rawText.trim();

    if (!file && !hasTextContent) {
      setError("Please upload a file or paste product text before processing.");
      return;
    }

    setLoading(true);
    try {
      let res;
      if (isMultiSource && !file) {
          const payload = {
            sources: sources.filter((s) => s.raw_text.trim()).map((s) => ({
              source_name: s.source_name.trim() || "Unnamed Source",
              source_type: s.source_type,
              raw_text: s.raw_text.trim()
            })),
          categoryHint: "auto"
        };
        res = await fetch("/api/process-product", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } else {
        const body = new FormData();
        if (file)              body.append("file",     file);
        else                   body.append("text",     rawText.trim());
        body.append("category", "auto");
        res = await fetch("/api/process-product", { method: "POST", body });
      }

      const json = await res.json();

      if (!res.ok) {
        setError(`Server error ${res.status}: ${json?.error ?? res.statusText}`);
      } else {
        setResult(json as PipelineResult);
      }
    } catch (err) {
      setError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">CatalogIQ</h1>
            <p className="mt-1 text-gray-500 text-sm">
              Upload a product spec or paste raw text to extract structured intelligence.
            </p>
          </div>
          
          {/* Mode switch buttons */}
          <div className="flex items-center gap-2 justify-end">
            {!file && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setIsBatchMode(false);
                    setIsMultiSource(false);
                  }}
                  className={`text-xs font-semibold px-2.5 py-1 rounded border transition ${
                    !isMultiSource && !isBatchMode
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  Single Product
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsBatchMode(false);
                    setIsMultiSource(true);
                  }}
                  className={`text-xs font-semibold px-2.5 py-1 rounded border transition ${
                    isMultiSource
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  Multi-Source
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsMultiSource(false);
                    setIsBatchMode(true);
                  }}
                  className={`text-xs font-semibold px-2.5 py-1 rounded border transition ${
                    isBatchMode
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  Batch Mode
                </button>
              </>
            )}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Conditional Input Rendering based on Mode */}
          {isBatchMode ? (
            <div className="space-y-4 border border-dashed border-gray-300 rounded-xl p-6 bg-gray-50/50">
              <div className="space-y-2">
                <label htmlFor="csv-upload" className="block text-sm font-medium text-gray-700">
                  Upload CSV Batch
                  <span className="block text-xs font-normal text-gray-400 mt-0.5">
                    Format: CSV with product_name, raw_text columns.
                  </span>
                </label>
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
                  className="block w-full text-sm text-gray-600
                             file:mr-3 file:py-1.5 file:px-3
                             file:rounded-md file:border file:border-gray-300
                             file:text-xs file:font-semibold file:text-gray-700
                             file:bg-white file:cursor-pointer hover:file:bg-gray-50
                             cursor-pointer border border-gray-300 rounded-md
                             bg-white py-1.5 px-3"
                />
                {batchCsvFile && (
                  <p className="text-xs text-gray-500 font-medium">Selected CSV: {batchCsvFile.name}</p>
                )}
              </div>

              <div className="flex items-center gap-3 text-gray-400 text-xs">
                <div className="flex-1 border-t border-gray-200" />
                or paste raw texts separated by "---"
                <div className="flex-1 border-t border-gray-200" />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-medium text-gray-700">Pasted Batch Texts</label>
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
                  placeholder={`Product A description...\n---\nProduct B description...\n---\nProduct C description...`}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2
                             text-sm text-gray-800 placeholder-gray-400
                             focus:outline-none focus:ring-2 focus:ring-gray-400 resize-y"
                />
              </div>
            </div>
          ) : (
            <>
              {/* File upload (only visible if not Batch Mode) */}
              <div>
                <label htmlFor="file-upload" className="block text-sm font-medium text-gray-700 mb-1">
                  Upload file
                  <span className="ml-1 text-gray-400 font-normal">(PDF, image, .txt)</span>
                </label>
                <input
                  id="file-upload"
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.png,.jpg,.jpeg,.webp,.heic"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-600
                             file:mr-3 file:py-2 file:px-4
                             file:rounded-md file:border file:border-gray-300
                             file:text-sm file:font-medium file:text-gray-700
                             file:bg-white file:cursor-pointer hover:file:bg-gray-50
                             cursor-pointer border border-gray-300 rounded-md
                             bg-white py-2 px-3"
                />
                {file && (
                  <p className="mt-1 text-xs text-gray-500">
                    Selected: <span className="font-medium">{file.name}</span>{" "}
                    ({(file.size / 1024).toFixed(1)} KB)
                  </p>
                )}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3 text-gray-400 text-xs">
                <div className="flex-1 border-t border-gray-200" />
                or paste text directly
                <div className="flex-1 border-t border-gray-200" />
              </div>

              {/* Multi-source toggle and input fields */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">
                    Raw product text
                  </label>
                </div>

                {!isMultiSource ? (
                  <div>
                    <textarea
                      id="raw-text"
                      value={rawText}
                      onChange={handleTextChange}
                      rows={8}
                      placeholder="Paste a product title, description, spec sheet text, or any raw content here…"
                      className="w-full rounded-md border border-gray-300 bg-white px-3 py-2
                                 text-sm text-gray-800 placeholder-gray-400
                                 focus:outline-none focus:ring-2 focus:ring-gray-400 resize-y"
                    />
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sources.map((src, idx) => (
                      <div key={idx} className="border border-gray-200 rounded-lg p-4 bg-white space-y-3 relative">
                        {sources.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveSource(idx)}
                            className="absolute top-2 right-2 text-gray-400 hover:text-red-500 text-xs font-bold"
                          >
                            Remove
                          </button>
                        )}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Source Name</label>
                            <input
                              type="text"
                              value={src.source_name}
                              onChange={(e) => handleSourceChange(idx, "source_name", e.target.value)}
                              placeholder="e.g. Manufacturer PDF"
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-800"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Source Type</label>
                            <select
                              value={src.source_type}
                              onChange={(e) => handleSourceChange(idx, "source_type", e.target.value as any)}
                              className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 bg-white"
                            >
                              <option value="manufacturer_pdf">Manufacturer PDF</option>
                              <option value="ecommerce_listing">Ecommerce Listing</option>
                              <option value="scraped_page">Scraped Page</option>
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Content</label>
                          <textarea
                            value={src.raw_text}
                            onChange={(e) => handleSourceChange(idx, "raw_text", e.target.value)}
                            rows={4}
                            placeholder="Paste content for this source..."
                            className="w-full rounded border border-gray-300 px-2 py-1 text-xs text-gray-800 resize-y"
                          />
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={handleAddSource}
                      className="w-full border border-dashed border-gray-300 hover:border-gray-500 rounded-lg py-2 text-xs font-medium text-gray-500 hover:text-gray-800 bg-white hover:bg-gray-50/50 transition flex items-center justify-center gap-1"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                      </svg>
                      Add another source
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            id="process-btn"
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-semibold
                       text-white hover:bg-gray-700 active:bg-gray-800
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner /> Processing…
              </span>
            ) : isBatchMode ? (
              "Process Batch"
            ) : (
              "Process Product"
            )}
          </button>
        </form>


        {/* ── Results ─────────────────────────────────────────────────────── */}
        {result && !isBatchMode && (
          <div className="mt-10 space-y-6" id="pipeline-output">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Pipeline Result</h2>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-xs text-gray-500 hover:text-gray-700 underline focus:outline-none"
              >
                {showRaw ? "Hide raw JSON" : "View raw JSON"}
              </button>
            </div>

            {/* Pipeline warnings */}
            {result.pipeline_warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-1">
                {result.pipeline_warnings.map((warning, idx) => (
                  <p key={idx} className="text-xs text-amber-800 flex items-start gap-1">
                    <span className="shrink-0 text-amber-500 font-bold">⚠</span>
                    <span>{warning}</span>
                  </p>
                ))}
              </div>
            )}

            {/* Custom Product Card component */}
            <ProductCard result={result} />

            {/* Raw JSON toggle */}
            {showRaw && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-700">Raw Pipeline JSON</h3>
                <pre
                  id="raw-output"
                  className="rounded-lg border border-gray-200 bg-gray-900 text-emerald-400
                             text-xs p-4 overflow-auto max-h-96 leading-relaxed font-mono"
                >
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* ── Batch Results ───────────────────────────────────────────────── */}
        {isBatchMode && batchResponse && (
          <div className="mt-10 space-y-8" id="batch-pipeline-output">
            <div className="flex items-center justify-between border-b border-gray-200 pb-3">
              <h2 className="text-xl font-bold text-gray-950">Batch Processing Summary</h2>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="text-xs text-gray-500 hover:text-gray-700 underline focus:outline-none"
              >
                {showRaw ? "Hide raw JSONs" : "View raw JSONs"}
              </button>
            </div>

            <HealthScoreDashboard
              batchId={batchResponse.batch_id}
              summary={batchResponse.summary}
              products={batchResponse.products}
            />

            {showRaw && (
              <pre className="rounded-lg border border-gray-200 bg-gray-900 text-emerald-400 text-[10px] p-4 overflow-auto max-h-48 leading-relaxed font-mono">
                {JSON.stringify(batchResponse, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// ── Inline spinner ────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 text-white"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8h4z" />
    </svg>
  );
}
