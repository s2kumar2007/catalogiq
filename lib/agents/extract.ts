/**
 * lib/agents/extract.ts
 * Shared extraction agent logic — used by both /api/extract and /api/process-product.
 * Keeps route handlers thin and avoids route-to-route HTTP calls.
 */

import path from "path";
import fs from "fs";

import { callGemini, parseJsonResponse, GeminiContentPart } from "@/lib/gemini";
import { EXTRACTION_SYSTEM_PROMPT } from "@/lib/prompts";
import type { ExtractionResult, SchemaCategory } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractInput {
  rawText?: string;
  imageBase64?: string;
  /** Hint from the caller. "auto" triggers keyword detection first. */
  category: "fasteners" | "electrical_connectors" | "auto";
}

// ---------------------------------------------------------------------------
// Schema loader
// ---------------------------------------------------------------------------

const SCHEMA_FILES: Record<Exclude<SchemaCategory, "none">, string> = {
  fasteners: "fasteners.json",
  electrical_connectors: "connectors.json",
};

export function loadSchemaJson(category: Exclude<SchemaCategory, "none">): string {
  const filename = SCHEMA_FILES[category];
  const schemaPath = path.join(process.cwd(), "schemas", filename);

  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `[extract] Schema file not found: ${schemaPath}. ` +
        `Drop ${filename} into the /schemas directory.`
    );
  }

  return fs.readFileSync(schemaPath, "utf-8");
}

// ---------------------------------------------------------------------------
// Keyword-based category detection (pre-flight before calling the LLM)
// ---------------------------------------------------------------------------

export function autoDetectCategory(
  rawText?: string
): Exclude<SchemaCategory, "none"> | null {
  if (!rawText) return null;
  const lower = rawText.toLowerCase();

  const fastenerKeywords = [
    "bolt", "screw", "nut", "washer", "fastener", "thread", "pitch",
    "hex", "torque", "tensile", "m4", "m6", "m8", "m10", "m12",
  ];
  const connectorKeywords = [
    "connector", "terminal", "voltage", "current", "ampere", "rated",
    "awg", "ip rating", "housing", "plug", "socket", "circuit",
  ];

  const fastenerScore  = fastenerKeywords .filter((w) => lower.includes(w)).length;
  const connectorScore = connectorKeywords.filter((w) => lower.includes(w)).length;

  if (fastenerScore === 0 && connectorScore === 0) return null;
  return fastenerScore >= connectorScore ? "fasteners" : "electrical_connectors";
}

// ---------------------------------------------------------------------------
// Core extraction function
// ---------------------------------------------------------------------------

/**
 * Runs the Extraction Agent for a single product input.
 * Returns a typed ExtractionResult with confidence values clamped to [0, 99].
 * Throws on LLM or parse failure — callers decide how to surface the error.
 */
export async function runExtraction(input: ExtractInput): Promise<ExtractionResult> {
  const { rawText, imageBase64, category } = input;

  if (!rawText && !imageBase64) {
    throw new Error("Provide either rawText or imageBase64.");
  }

  // ── Resolve category ──────────────────────────────────────────────────────
  let resolvedCategory: Exclude<SchemaCategory, "none"> | null;

  if (category === "auto") {
    resolvedCategory = autoDetectCategory(rawText);
    // null → schema-less extraction
  } else {
    resolvedCategory = category;
  }

  // ── Build user parts ──────────────────────────────────────────────────────
  const userParts: GeminiContentPart[] = [];

  if (resolvedCategory) {
    const schemaJson = loadSchemaJson(resolvedCategory);
    userParts.push({
      type: "text",
      data:
        `Schema to use (extract ONLY fields listed here, using exact key names):\n\n` +
        schemaJson +
        `\n\nExtract all product data you can find from the following input:`,
    });
  } else {
    userParts.push({
      type: "text",
      data:
        `No specific schema was matched for this input. Extract all identifiable ` +
        `product fields generically (use descriptive key names), following the same ` +
        `output format. Set schema_match to "none".`,
    });
  }

  if (rawText)     userParts.push({ type: "text",  data: rawText });
  if (imageBase64) userParts.push({ type: "image", data: imageBase64 });

  // ── Call Gemini ───────────────────────────────────────────────────────────
  const rawResponse = await callGemini(EXTRACTION_SYSTEM_PROMPT, userParts);

  // ── Parse ─────────────────────────────────────────────────────────────────
  const result = parseJsonResponse<ExtractionResult>(rawResponse);

  // Clamp confidence values
  for (const field of Object.values(result.extracted_fields ?? {})) {
    field.confidence = Math.min(99, Math.max(0, Math.round(field.confidence)));
  }

  return result;
}
