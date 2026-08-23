import Papa from "papaparse";
import * as XLSX from "xlsx";
import StatCard from "./StatCard";
import { labelStyle } from "./UploadArea";

// TODO: replace this mock with the real response shape from
// app/api/process-batch/route.ts once wired up.
export type ResultRow = {
  part: string;
  brand: string;
  status: "enriched" | "flagged";
  conf: number | null;
};

type Props = {
  mfr?: string;
  rows: ResultRow[]; // no default — must come from the real API response
  rawProducts?: any[];
};

export default function ResultsPanel({ mfr, rows, rawProducts = [] }: Props) {
  if (!rows || rows.length === 0) {
    return <p style={{ padding: 24, textAlign: "center", color: "#565D6B" }}>No results yet.</p>;
  }
  const shown = rows;
  const enrichedCount = rows.filter((r) => r.status === "enriched").length;
  const flaggedCount = rows.filter((r) => r.status === "flagged").length;

  const handleDownloadCsv = () => {
    if (!rawProducts.length) return;
    const deliveryRecords = rawProducts.map((p) => p.delivery_record).filter(Boolean);
    const columns = rawProducts[0]?.delivery_columns || [];
    const csv = Papa.unparse(deliveryRecords, { columns });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "catalogiq_results.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadExcel = () => {
    if (!rawProducts.length) return;
    const deliveryRecords = rawProducts.map((p) => p.delivery_record).filter(Boolean);
    const columns = rawProducts[0]?.delivery_columns || [];
    const ws = XLSX.utils.json_to_sheet(deliveryRecords, { header: columns });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    XLSX.writeFile(wb, "catalogiq_results.xlsx");
  };

  const buttonStyle = {
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
    fontWeight: 500,
    color: "#E7E5DE",
    background: "#12151A",
    border: "1px solid #1F242B",
    borderRadius: 8,
    padding: "8px 16px",
    cursor: rawProducts.length > 0 ? "pointer" : "not-allowed",
    opacity: rawProducts.length > 0 ? 1 : 0.5,
  };

  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
        <StatCard label="Rows processed" value={rows.length} />
        <StatCard label="Enriched" value={enrichedCount} accent="#2DD4BF" />
        <StatCard label="Flagged unbranded" value={flaggedCount} accent="#F0A345" />
        <StatCard label="Errors" value={0} />
        
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={buttonStyle} onClick={handleDownloadCsv} disabled={rawProducts.length === 0}>
            Download CSV
          </button>
          <button style={buttonStyle} onClick={handleDownloadExcel} disabled={rawProducts.length === 0}>
            Download Excel
          </button>
        </div>
      </div>

      <p style={labelStyle}>Results{mfr ? ` — filtered by "${mfr}"` : ""}</p>
      <div style={{ border: "1px solid #1F242B", borderRadius: 10, overflow: "hidden" }}>
        {shown.map((r, i) => (
          <div
            key={r.part}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 18px",
              borderBottom: i < shown.length - 1 ? "1px solid #1F242B" : "none",
              background: "#12151A",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#E7E5DE" }}>
                {r.part}
              </span>
              <span style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#8B92A0" }}>{r.brand}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {r.conf && (
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#565D6B" }}>
                  {r.conf}% category conf
                </span>
              )}
              <span
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: 5,
                  color: "#0A0C10",
                  background: r.status === "enriched" ? "#2DD4BF" : "#F0A345",
                }}
              >
                {r.status === "enriched" ? "Enriched" : "Unbranded"}
              </span>
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <p style={{ padding: 24, textAlign: "center", color: "#565D6B", fontFamily: "'Inter', sans-serif", fontSize: 14 }}>
            No rows match that manufacturer filter.
          </p>
        )}
      </div>
    </div>
  );
}
