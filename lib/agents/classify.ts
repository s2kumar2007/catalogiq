/**
 * lib/agents/classify.ts
 * Stage 3: Taxonomy & Classification Agent
 *
 * Responsible for matching a product to the correct classpath AND
 * dynamically generating a schema (field list) for that category using Groq.
 * No static schema files required — the LLM derives the attribute set from
 * the product text and the Expected Output format.
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";

export interface ClassificationInput {
  rawText: string;
}

export interface ClassificationResult {
  classpath: string;
  confidence: number;
  /** LLM-generated schema fields for this category (replaces static JSON files) */
  schema_fields: SchemaField[];
}

export interface SchemaField {
  key: string;
  label: string;
  type: "string" | "number" | "enum" | "array";
  unit?: string;
  required: boolean;
}

const SYSTEM_PROMPT = `You are a product taxonomy and schema expert for an industrial/commercial product catalog.

Your job:
1. Classify the product into the most specific plausible classpath, using the format "Department>Category>Subcategory" (2-3 levels).
2. Generate a realistic list of attribute fields that a real spec sheet for this EXACT type of product would include - reason from your knowledge of the product category, not from memorized examples. Do not use a fixed field count; include as many genuine fields as the product type justifies, up to the 50 delivery slots.

CLASSPATH GUIDANCE:
- Be as specific as the input text supports. If the input only says "Load Center" or "Square Drive Bit", classify at whatever specificity you can confidently determine (e.g. "Electrical>Circuit Protection>Load Centers", "Hardware>Hand Tool Accessories>Screwdriver Bits") - do not default to generic categories when a more specific one is clearly implied by the text.
- Only return "Unknown>Uncategorized" if the input is genuinely too vague to classify AT ALL (e.g. just a part number with no descriptive text) - not simply because the category is unfamiliar to you. You have broad general knowledge of industrial/commercial products - use it.

SCHEMA FIELD GUIDANCE:
- Generate fields a real spec sheet for THIS SPECIFIC product type would have - e.g. a load center needs fields like Amperage Rating, Number of Circuits, Phase, Voltage Rating, Enclosure Type; a screwdriver bit needs fields like Drive Type, Bit Length, Tip Size, Material, Shank Type.
- key must be snake_case, label must be a clean human-readable field name.
- Always return AT LEAST 5 schema_fields for any product with real descriptive text - a near-empty schema_fields array is a sign you should reason harder about the category, not give up.

Return ONLY valid JSON with this exact shape:
{
  "classpath": "string",
  "confidence": 0-100,
  "schema_fields": [
    { "key": "string", "label": "string", "type": "string"|"number"|"enum"|"array", "unit": "string (optional)", "required": boolean }
  ]
}`;

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.substring(start, end + 1);
  }
  return text;
}

function parseWithRepair<T>(text: string): T {
  try {
    return parseJsonResponse<T>(text);
  } catch (err) {
    let repaired = text.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // Simple basic brace closing if mismatched
    const openBraces = (repaired.match(/\{/g) || []).length;
    let closeBraces = (repaired.match(/\}/g) || []).length;
    while (openBraces > closeBraces) {
        repaired += '}';
        closeBraces++;
    }
    const openBrackets = (repaired.match(/\[/g) || []).length;
    let closeBrackets = (repaired.match(/\]/g) || []).length;
    while (openBrackets > closeBrackets) {
        repaired += ']';
        closeBrackets++;
    }
    return JSON.parse(repaired) as T;
  }
}

export async function runClassification(
  input: ClassificationInput
): Promise<ClassificationResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const userPrompt = `Classify this product and generate its attribute schema:

  ${input.rawText}`;

  const attempt = async (): Promise<ClassificationResult> => {
    const responseText = await callGroq(SYSTEM_PROMPT, userPrompt, apiKey, undefined, 1400);
    const parsed = parseWithRepair<ClassificationResult>(extractJson(responseText));

    // Validate shape
    if (!parsed.classpath || !Array.isArray(parsed.schema_fields)) {
      throw new Error("Invalid classification response shape");
    }

    return parsed;
  };

  const thirdAttempt = async (): Promise<ClassificationResult> => {
    const simplePrompt = `Classify this product into a classpath only. Return ONLY:
{"classpath": "string", "confidence": 0-100}`;
    const responseText = await callGroq(simplePrompt, userPrompt, apiKey, undefined, 512);
    const parsed = parseWithRepair<{classpath: string, confidence: number}>(extractJson(responseText));

    if (!parsed.classpath) {
      throw new Error("Invalid minimal classification response shape");
    }

    return {
      classpath: parsed.classpath,
      confidence: parsed.confidence || 50,
      schema_fields: []
    };
  };

  try {
    return await attempt();
  } catch (firstError) {
    console.error("[classify] FAILED for input:", input.rawText.slice(0, 100));
    console.error("[classify] First attempt failed:", firstError);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await attempt();
    } catch (secondError) {
      console.error("[classify] FAILED for input:", input.rawText.slice(0, 100));
      console.error("[classify] Second attempt also failed:", secondError);
      
      console.log("[classify] Falling back to simplified third attempt...");
      try {
        return await thirdAttempt();
      } catch (thirdError) {
        console.error("[classify] Third attempt also failed:", thirdError);
      }
    }
    return {
      classpath: "Unknown>Uncategorized",
      confidence: 0,
      schema_fields: [],
    };
  }
}
