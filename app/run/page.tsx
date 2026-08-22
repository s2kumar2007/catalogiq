"use client";

import { useState } from "react";
import UploadArea, { labelStyle } from "@/components/UploadArea";
import ResultsPanel from "@/components/ResultsPanel";

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [mfr, setMfr] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");

  const run = async () => {
    if (!file) return;
    setStatus("running");

    // TODO: replace with the real call, e.g.:
    // const formData = new FormData();
    // formData.append("file", file);
    // formData.append("mfr", mfr);
    // const res = await fetch("/api/process-batch", { method: "POST", body: formData });
    // const data = await res.json();

    setTimeout(() => setStatus("done"), 1600);
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

        {status === "done" && <ResultsPanel mfr={mfr} />}
      </div>
    </div>
  );
}
