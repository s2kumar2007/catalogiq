/**
 * lib/agents/format.ts
 * Stage 7: Description Building (Formatting) Agent
 */

import { FORMATTING_SYSTEM_PROMPT } from "@/lib/prompts";
import { DeliveryFormats, ExtractedField } from "@/lib/types";

export interface FormattingResult {
  delivery_formats: DeliveryFormats;
}

export async function runFormatting(
  normalizedFields: Record<string, ExtractedField>
): Promise<FormattingResult> {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  
  const PRIMARY_MODEL = process.env.PRIMARY_MODEL || "gemini-3.6-flash";
  const model = genAI.getGenerativeModel({
    model: PRIMARY_MODEL,
    systemInstruction: FORMATTING_SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  // Convert normalized fields to a simpler key-value object for the prompt
  const simpleFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(normalizedFields)) {
    simpleFields[k] = v.value;
  }

  const userPrompt = `
Generate the delivery formats using exactly these normalized fields and no others.

Normalized Fields:
${JSON.stringify(simpleFields, null, 2)}

Return JSON strictly matching this shape:
{
  "mobile_desc": "string (60-80 chars max)",
  "short_desc": "string",
  "long_desc": "string",
  "attributes_string": "string"
}
  `;

  try {
    const result = await model.generateContent(userPrompt);
    const responseText = result.response.text();
    const jsonStr = responseText.replace(/```json|```/g, "").trim();
    const formats = JSON.parse(jsonStr) as DeliveryFormats;
    
    // Fallbacks if missing
    if (!formats.mobile_desc) formats.mobile_desc = "";
    if (!formats.short_desc) formats.short_desc = "";
    if (!formats.long_desc) formats.long_desc = "";
    if (!formats.attributes_string) formats.attributes_string = "";
    
    return { delivery_formats: formats };
  } catch (error) {
    console.error("Formatting error:", error);
    return {
      delivery_formats: {
        mobile_desc: "Error generating mobile description.",
        short_desc: "Error generating short description.",
        long_desc: "Error generating long description.",
        attributes_string: "Error generating attributes."
      }
    };
  }
}
