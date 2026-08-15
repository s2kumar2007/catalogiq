/**
 * app/api/gap-resolve/route.ts
 * Gap-Resolution Agent HTTP endpoint — thin wrapper around lib/agents/gap-resolve.ts.
 *
 * POST body (JSON):
 * {
 *   extracted_fields:   Record<string, ExtractedField>,
 *   validation_result:  ValidationResult | null,
 *   category_schema:    { category: "fasteners" | "electrical_connectors", ... }
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { runGapResolution } from "@/lib/agents/gap-resolve";
import type { ExtractedField, ValidationResult } from "@/lib/types";

export async function POST(req: NextRequest) {
  let body: {
    extracted_fields?: Record<string, ExtractedField>;
    validation_result?: ValidationResult | null;
    category_schema?: { category?: string };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { extracted_fields, validation_result = null, category_schema } = body;

  if (!extracted_fields || typeof extracted_fields !== "object") {
    return NextResponse.json(
      { error: "Missing or invalid extracted_fields." },
      { status: 400 }
    );
  }

  const category = category_schema?.category;

  if (category !== "fasteners" && category !== "electrical_connectors") {
    return NextResponse.json(
      {
        error:
          'category_schema.category must be "fasteners" or "electrical_connectors".',
      },
      { status: 400 }
    );
  }

  try {
    const result = await runGapResolution(
      extracted_fields,
      validation_result,
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

