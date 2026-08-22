"use client";

import { useCallback, useRef, useState } from "react";

export const labelStyle = {
  fontFamily: "'Inter', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  color: "#E7E5DE",
  margin: "0 0 10px",
};

const pillStyle = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: "#2DD4BF",
  background: "rgba(45,212,191,0.08)",
  border: "1px solid rgba(45,212,191,0.25)",
  borderRadius: 5,
  padding: "3px 8px",
};

type Props = {
  file: File | null;
  onFile: (file: File) => void;
};

export default function UploadArea({ file, onFile }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.[0]) onFile(e.dataTransfer.files[0]);
    },
    [onFile]
  );

  return (
    <div>
      <p style={labelStyle}>Upload CSV</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `1px dashed ${dragging ? "#2DD4BF" : "#2A3038"}`,
          borderRadius: 10,
          background: dragging ? "rgba(45,212,191,0.05)" : "#171B21",
          padding: "36px 20px",
          textAlign: "center",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <div
          style={{
            width: 40,
            height: 40,
            margin: "0 auto 14px",
            borderRadius: "50%",
            background: "#1F242B",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 16V4M12 4L7 9M12 4l5 5"
              stroke="#2DD4BF"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="#2DD4BF" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        {file ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#2DD4BF" }}>{file.name}</p>
        ) : (
          <>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 14, color: "#E7E5DE", margin: "0 0 4px", fontWeight: 500 }}>
              Drop a CSV here, or click to browse
            </p>
            <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 13, color: "#565D6B", margin: 0 }}>
              Up to 1,000 rows
            </p>
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {["Mfg_Part_Num", "Part_Desc", "Part_Manuf"].map((col) => (
          <span key={col} style={pillStyle}>
            {col}
          </span>
        ))}
        <span style={{ ...pillStyle, color: "#565D6B", borderStyle: "dashed" }}>or product_name / raw_text</span>
      </div>
    </div>
  );
}
