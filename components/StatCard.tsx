type Props = {
  label: string;
  value: string | number;
  accent?: string;
};

export default function StatCard({ label, value, accent }: Props) {
  return (
    <div
      style={{
        flex: "1 1 140px",
        background: "#12151A",
        border: "1px solid #1F242B",
        borderRadius: 10,
        padding: "16px 18px",
      }}
    >
      <p style={{ fontFamily: "'Inter', sans-serif", fontSize: 12, color: "#8B92A0", margin: "0 0 6px" }}>{label}</p>
      <p
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 600,
          fontSize: 26,
          color: accent || "#E7E5DE",
          margin: 0,
        }}
      >
        {value}
      </p>
    </div>
  );
}
