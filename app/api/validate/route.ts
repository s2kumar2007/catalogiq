/**
 * app/api/validate/route.ts
 * Validation Agent HTTP endpoint — thin wrapper around lib/agents/validate.ts.
 *
 * POST body (JSON):
 * { extractedFields: Record<string, ExtractedField>, category: "fasteners" | "electrical_connectors" }
 */

import { NextRequest, NextResponse } from "next/server";
import { runValidation } from "@/lib/agents/validate";
import type { ExtractedField } from "@/lib/types";

export async function POST(req: NextRequest) {
  let body: { extractedFields?: Record<string, ExtractedField>; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { extractedFields, category } = body;

  if (!extractedFields || typeof extractedFields !== "object") {
    return NextResponse.json(
      { error: "Missing or invalid extractedFields." },
      { status: 400 }
    );
  }

  if (category !== "fasteners" && category !== "electrical_connectors") {
    return NextResponse.json(
      {
        error:
          'category must be "fasteners" or "electrical_connectors". ' +
          "Resolve schema_match from the extraction step first.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await runValidation(
      extractedFields,
      category as "fasteners" | "electrical_connectors"
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
