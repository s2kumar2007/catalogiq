"use client";

import { useState } from "react";
import Papa from "papaparse";
import UploadArea, { labelStyle } from "@/components/UploadArea";
import ResultsPanel, { ResultRow } from "@/components/ResultsPanel";

function mapToResultRows(products: any[]): ResultRow[] {
  return products.map((p) => {
    const normFields = p.normalization_result?.normalized_fields ?? {};
    const mpn =
      normFields.part_number?.value ??
      p.delivery_record?.Mfg_Part_Num ??
      "unknown";

    const brandValue =
      p.resolved_brand?.brand_name ??
      p.delivery_record?.BRAND_NAME ??
      normFields.brand?.value ??
      normFields.manufacturer?.value ??
      "Needs brand review";

    return {
      part: mpn,
      brand: brandValue,
      status: p.enrichment_result?.officialDataFound
        ? "enriched"
        : p.resolved_brand?.brand_name
          ? "resolved"
          : "flagged",
      conf: p.classification_result?.confidence ?? null,
    };
  });
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [mfr, setMfr] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const run = async () => {
    if (!file) return;
    setStatus("running");
    setErrorMsg(null);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (parsed) => {
        const rows = parsed.data as Record<string, string>[];
        
        // Filter by manufacturer if provided
        let filtered = rows;
        if (mfr.trim()) {
          const needle = mfr.trim().toLowerCase();
          filtered = rows.filter((r) => 
            (r.Part_Manuf || "").toLowerCase().includes(needle) ||
            (r.Part_Desc || "").toLowerCase().includes(needle)
          );
        }

        if (filtered.length === 0) {
          setErrorMsg(`No rows matched "${mfr}". Try a different filter or leave it blank to process all rows.`);
          setStatus("idle");
          return;
        }

        const products = filtered.map(r => {
          const mpn = (r.Mfg_Part_Num ?? r.MANUFACTURER_PART_NUMBER ?? "").trim();
          const desc = (r.Part_Desc ?? "").trim();
          const manuf = (r.Part_Manuf ?? r.MANUFACTURER_NAME ?? "").trim();
          const brand = (r.E1_Brand ?? "").trim();

          const raw_text = [
            mpn ? `Part Number: ${mpn}` : null,
            desc ? `Description: ${desc}` : null,
            brand ? `Brand: ${brand}` : null,
            manuf ? `Manufacturer: ${manuf}` : null,
          ].filter(Boolean).join("\n");

          return { raw_text, source_row: r };
        });

        try {
          const res = await fetch("/api/process-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ products }),
          });

          if (!res.ok) {
            throw new Error(`Server returned ${res.status}`);
          }

          const data = await res.json();
          setResult(data);
          setStatus("done");
        } catch (err) {
          console.error("Pipeline run failed:", err);
          setErrorMsg("Pipeline failed to run. Check console for details.");
          setStatus("idle");
        }
      },
      error: (err) => {
        console.error("CSV parse error:", err);
        setErrorMsg("Failed to parse CSV file.");
        setStatus("idle");
      }
    });
  };

  return (
    <div style={{ background: "#0A0C10", minHeight: "calc(100vh - 57px)", padding: "56px 24px 100px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <h2
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 700,
            fontSize: 30,
            color: "#E7E5DE",
            margin: "0 0 8px",
            letterSpacing: "-0.02em",
          }}
        >
          Run enrichment pipeline
        </h2>
        <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 15, color: "#8B92A0", margin: "0 0 36px" }}>
          Upload a catalog file and optionally scope the run to one manufacturer.
        </p>

        <div
          style={{
            background: "#12151A",
            border: "1px solid #1F242B",
            borderRadius: 14,
            padding: 28,
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
          <UploadArea file={file} onFile={setFile} />

          <div>
            <p style={labelStyle}>Manufacturer filter (optional)</p>
            <input
              value={mfr}
              onChange={(e) => setMfr(e.target.value)}
              placeholder="e.g. LG, GE — leave blank to process all manufacturers"
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "#171B21",
                border: "1px solid #2A3038",
                borderRadius: 8,
                padding: "12px 14px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
                color: "#E7E5DE",
                outline: "none",
              }}
            />
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#565D6B", margin: "8px 0 0" }}>
              If left empty, the pipeline processes every manufacturer in the file.
            </p>
          </div>

          <button
            onClick={run}
            disabled={!file || status === "running"}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontWeight: 600,
              fontSize: 15,
              color: "#0A0C10",
              background: !file ? "#2A3038" : "#2DD4BF",
              border: "none",
              borderRadius: 8,
              padding: "14px 20px",
              cursor: !file ? "not-allowed" : "pointer",
              opacity: status === "running" ? 0.7 : 1,
            }}
          >
            {status === "running" ? "Running pipeline…" : "Run enrichment pipeline"}
          </button>
        </div>
        
        {errorMsg && (
          <div style={{ marginTop: 24, padding: 16, background: "#3A1A1A", border: "1px solid #7A2E2E", borderRadius: 8, color: "#FCA5A5", fontSize: 14 }}>
            {errorMsg}
          </div>
        )}

        {status === "done" && <ResultsPanel mfr={mfr} rows={result ? mapToResultRows(result.products || []) : []} rawProducts={result?.products || []} />}
      </div>
    </div>
  );
}
