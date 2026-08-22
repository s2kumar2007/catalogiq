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

Your job is two-fold:
1. Classify the product into the most specific classpath from the Unilog taxonomy.
2. Generate the exact list of attribute fields that should be extracted for that classpath.

CLASSPATH RULES:
- For kitchen dishwashers: "Appliances & Consumer Electronics>Kitchen Appliances>Built-In Dishwashers"
- For threaded fasteners (bolts, screws, nuts, washers): "Hardware>Fasteners"  
- For electrical connectors/terminals/plugs: "Electrical>Wiring>Connectors & Terminals"
- For other products: use the most accurate path you can determine
- If truly unknown: "Unknown>Uncategorized"

SCHEMA FIELD RULES:
- Use the ATTRIBUTE_LABEL values seen in the Unilog Expected Output format as your field labels
- For Built-In Dishwashers, the known attribute labels are:
  Series, Model, Number of Wash Cycles, Voltage Rating, Amperage Rating,
  Mounting Type, Plug Type, Size, Depth With Door Open, Minimum Height,
  Maximum Height, Sound Level, Material, Color, Additional Information
- For Fasteners: Thread Size, Length, Material, Drive Type, Finish, Grade/Class
- For Connectors: Number of Positions, Contact Gender, Current Rating, Voltage Rating, Mounting Style
- For any other category, infer the most likely attribute fields from the product text
- key must be snake_case, label must match the ATTRIBUTE_LABEL exactly as it would appear in the output

Return ONLY valid JSON with this exact shape:
{
  "classpath": "string",
  "confidence": 0-100,
  "schema_fields": [
    { "key": "series", "label": "Series", "type": "string", "required": false },
    { "key": "number_of_wash_cycles", "label": "Number of Wash Cycles", "type": "number", "required": false },
    ...
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

export async function runClassification(
  input: ClassificationInput
): Promise<ClassificationResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const userPrompt = `Classify this product and generate its attribute schema:

  ${input.rawText}`;

  try {
    const responseText = await callGroq(SYSTEM_PROMPT, userPrompt, apiKey, undefined, 1400);
    const parsed = parseJsonResponse<ClassificationResult>(extractJson(responseText));

    // Validate shape
    if (!parsed.classpath || !Array.isArray(parsed.schema_fields)) {
      throw new Error("Invalid classification response shape");
    }

    return parsed;
  } catch (error) {
    console.error("[classify] Error:", error);
    return {
      classpath: "Unknown>Uncategorized",
      confidence: 0,
      schema_fields: [],
    };
  }
}
