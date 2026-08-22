"use client";

import { useEffect, useState, Fragment } from "react";

const STAGES = [
  { key: "classify", label: "Classify" },
  { key: "extract", label: "Extract" },
  { key: "enrich", label: "Enrich" },
  { key: "normalize", label: "Normalize" },
  { key: "format", label: "Format" },
  { key: "validate", label: "Validate" },
  { key: "score", label: "Score" },
];

export default function PipelineDiagram() {
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPulse((p) => (p + 1) % STAGES.length), 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
        maxWidth: 920,
        margin: "0 auto",
      }}
    >
      {STAGES.map((s, i) => (
        <Fragment key={s.key}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, minWidth: 84 }}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: pulse === i ? "#2DD4BF" : "#1F242B",
                border: pulse === i ? "none" : "1px solid #2A3038",
                boxShadow: pulse === i ? "0 0 0 4px rgba(45,212,191,0.15)" : "none",
                transition: "all 0.3s ease",
              }}
            />
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: pulse === i ? "#2DD4BF" : "#565D6B",
                letterSpacing: "0.02em",
                transition: "color 0.3s ease",
              }}
            >
              {s.label}
            </span>
          </div>
          {i < STAGES.length - 1 && (
            <div style={{ width: 32, height: 1, background: "#1F242B", marginBottom: 20 }} />
          )}
        </Fragment>
      ))}
    </div>
  );
}
