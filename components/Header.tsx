"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Logo from "./Logo";

function navLinkStyle(active: boolean) {
  return {
    fontFamily: "'Inter', sans-serif",
    fontSize: 14,
    fontWeight: 500,
    color: active ? "#E7E5DE" : "#8B92A0",
    textDecoration: "none",
  };
}

const ctaSmall = {
  fontFamily: "'Inter', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  color: "#0A0C10",
  background: "#2DD4BF",
  border: "none",
  borderRadius: 6,
  padding: "8px 16px",
  cursor: "pointer",
  textDecoration: "none",
};

export default function Header() {
  const pathname = usePathname();

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 32px",
        borderBottom: "1px solid #1F242B",
        background: "rgba(10,12,16,0.85)",
        backdropFilter: "blur(8px)",
      }}
    >
      <Link
        href="/"
        style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}
      >
        <Logo size={24} />
        <span
          style={{
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 700,
            fontSize: 17,
            color: "#E7E5DE",
            letterSpacing: "-0.02em",
          }}
        >
          CatalogIQ
        </span>
      </Link>

      <nav style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <Link href="/" style={navLinkStyle(pathname === "/")}>
          Home
        </Link>
        <a
          href="https://github.com/s2kumar2007/catalogiq"
          target="_blank"
          rel="noreferrer"
          style={navLinkStyle(false)}
        >
          GitHub
        </a>
        <Link href="/run" style={ctaSmall}>
          Run pipeline
        </Link>
      </nav>
    </header>
  );
}
