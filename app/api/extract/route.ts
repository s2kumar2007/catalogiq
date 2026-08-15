/**
 * app/api/extract/route.ts
 * Extraction Agent HTTP endpoint — thin wrapper around lib/agents/extract.ts.
 *
 * POST body (JSON):
 * { rawText?: string, imageBase64?: string, category: "fasteners" | "electrical_connectors" | "auto" }
 */

import { NextRequest, NextResponse } from "next/server";
import { runExtraction } from "@/lib/agents/extract";

export async function POST(req: NextRequest) {
  let body: { rawText?: string; imageBase64?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { rawText, imageBase64, category = "auto" } = body;

  if (!rawText && !imageBase64) {
    return NextResponse.json(
      { error: "Provide either rawText or imageBase64." },
      { status: 400 }
    );
  }

  if (
    category !== "auto" &&
    category !== "fasteners" &&
    category !== "electrical_connectors"
  ) {
    return NextResponse.json(
      { error: 'category must be "fasteners", "electrical_connectors", or "auto".' },
      { status: 400 }
    );
  }

  try {
    const result = await runExtraction({
      rawText,
      imageBase64,
      category: category as "fasteners" | "electrical_connectors" | "auto",
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
