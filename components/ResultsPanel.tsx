import StatCard from "./StatCard";
import { labelStyle } from "./UploadArea";

// TODO: replace this mock with the real response shape from
// app/api/process-batch/route.ts once wired up.
type ResultRow = {
  part: string;
  brand: string;
  status: "enriched" | "flagged";
  conf: number | null;
};

const MOCK_ROWS: ResultRow[] = [
  { part: "LFXS28968S", brand: "LG", status: "enriched", conf: 94 },
  { part: "GDT650SYVFS", brand: "GE", status: "enriched", conf: 91 },
  { part: "KDTM404KPS", brand: "KitchenAid", status: "enriched", conf: 88 },
  { part: "PDSH4816AF", brand: "Unbranded", status: "flagged", conf: null },
  { part: "WDTS7024RZ", brand: "Unbranded", status: "flagged", conf: null },
];

type Props = {
  mfr?: string;
  rows?: ResultRow[];
};

export default function ResultsPanel({ mfr, rows = MOCK_ROWS }: Props) {
  const shown = mfr ? rows.filter((r) => r.brand.toLowerCase().includes(mfr.toLowerCase())) : rows;
  const enrichedCount = rows.filter((r) => r.status === "enriched").length;
  const flaggedCount = rows.filter((r) => r.status === "flagged").length;

  return (
    <div style={{ marginTop: 40 }}>
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Rows processed" value={rows.length} />
        <StatCard label="Enriched" value={enrichedCount} accent="#2DD4BF" />
        <StatCard label="Flagged unbranded" value={flaggedCount} accent="#F0A345" />
        <StatCard label="Errors" value={0} />
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
                  {r.conf}% confidence
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
