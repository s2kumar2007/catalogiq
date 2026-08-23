import Papa from "papaparse";
import * as XLSX from "xlsx";
import StatCard from "./StatCard";
import { labelStyle } from "./UploadArea";

// TODO: replace this mock with the real response shape from
// app/api/process-batch/route.ts once wired up.
export type ResultRow = {
  part: string;
  brand: string;
  status: "enriched" | "unbranded" | "needs_review";
  conf: number | null;
};

type Props = {
  mfr?: string;
  rows: ResultRow[]; // no default — must come from the real API response
  rawProducts?: any[];
};

function buildExportTable(products: any[], displayRows: ResultRow[]) {
  const columns =
    products.find((p) => Array.isArray(p.delivery_columns) && p.delivery_columns.length > 0)
      ?.delivery_columns ?? [];

  const records = products.map((p, index) => {
    if (p.delivery_record && Object.keys(p.delivery_record).length > 0) {
      return p.delivery_record;
    }

    const display = displayRows[index];
    const source = p.source_row ?? {};
    const fallback: Record<string, string> = { ...source };
    fallback.Mfg_Part_Num = fallback.Mfg_Part_Num || fallback.MANUFACTURER_PART_NUMBER || display?.part || "";
    fallback.MANUFACTURER_PART_NUMBER = fallback.MANUFACTURER_PART_NUMBER || fallback.Mfg_Part_Num || "";
    fallback.Part_Desc = fallback.Part_Desc || fallback.description || "";
    fallback.BRAND_NAME = fallback.BRAND_NAME || display?.brand || "";
    fallback.E1_Brand = fallback.E1_Brand || fallback.BRAND_NAME || "";
    fallback.Unilog_Brand = fallback.Unilog_Brand || fallback.BRAND_NAME || "";
    fallback.DIB_Brand = fallback.DIB_Brand || fallback.BRAND_NAME || "";
    return fallback;
  });

  const fallbackColumns = Array.from(
    new Set(records.flatMap((record) => Object.keys(record)))
  );

  return {
    columns: columns.length > 0 ? columns : fallbackColumns,
    records,
  };
}

export default function ResultsPanel({ mfr, rows, rawProducts = [] }: Props) {
  if (!rows || rows.length === 0) {
    return <p style={{ padding: 24, textAlign: "center", color: "#565D6B" }}>No results yet.</p>;
  }
  const shown = rows;
  const enrichedCount = rows.filter((r) => r.status === "enriched").length;
  const unbrandedCount = rows.filter((r) => r.status === "unbranded").length;
  const needsReviewCount = rows.filter((r) => r.status === "needs_review").length;

  const handleDownloadCsv = () => {
    if (!rawProducts.length) return;
    const { records: deliveryRecords, columns } = buildExportTable(rawProducts, rows);
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
    const { records: deliveryRecords, columns } = buildExportTable(rawProducts, rows);
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
        <StatCard label="Needs Review" value={needsReviewCount} accent="#F0A345" />
        <StatCard label="Unbranded" value={unbrandedCount} accent="#94A3B8" />
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
                  background: r.status === "enriched" ? "#2DD4BF" : r.status === "unbranded" ? "#94A3B8" : "#F0A345",
                }}
              >
                {r.status === "enriched" ? "Enriched" : r.status === "unbranded" ? "Unbranded" : "Needs review"}
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
