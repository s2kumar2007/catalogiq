import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/extract
 * Extraction agent: pulls structured fields from raw product text/HTML.
 */
export async function POST(req: NextRequest) {
  // TODO: implement extraction logic (Gemini / Groq LLM call)
  return NextResponse.json({ message: "extract stub" }, { status: 200 });
}
