import Link from "next/link";
import Logo from "@/components/Logo";
import PipelineDiagram from "@/components/PipelineDiagram";

export default function Page() {
  return (
    <div
      style={{
        minHeight: "calc(100vh - 57px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "80px 24px 100px",
        background: "radial-gradient(circle at 50% 0%, rgba(45,212,191,0.06), transparent 60%), #0A0C10",
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: "1px solid #1F242B",
          borderRadius: 20,
          marginBottom: 28,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2DD4BF" }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#8B92A0" }}>
          7-stage LLM pipeline · live enrichment
        </span>
      </div>

      <Logo size={56} />

      <h1
        style={{
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 700,
          fontSize: "clamp(48px, 8vw, 84px)",
          lineHeight: 1.02,
          letterSpacing: "-0.03em",
          color: "#E7E5DE",
          margin: "20px 0 0",
          textAlign: "center",
        }}
      >
        Catalog<span style={{ color: "#2DD4BF" }}>IQ</span>
      </h1>

      <p
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: 18,
          color: "#8B92A0",
          maxWidth: 560,
          textAlign: "center",
          margin: "18px 0 40px",
          lineHeight: 1.6,
        }}
      >
        Messy distributor rows in. Fully enriched, 252-column delivery records out — classified, extracted, and
        verified against real manufacturer sites.
      </p>

      <Link
        href="/run"
        style={{
          fontFamily: "'Inter', sans-serif",
          fontWeight: 600,
          fontSize: 15,
          color: "#0A0C10",
          background: "#2DD4BF",
          border: "none",
          borderRadius: 8,
          padding: "14px 28px",
          cursor: "pointer",
          marginBottom: 72,
          textDecoration: "none",
        }}
      >
        Run the pipeline →
      </Link>

      <PipelineDiagram />
    </div>
  );
}
