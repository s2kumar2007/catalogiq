/**
 * lib/agents/classify.ts
 * Stage 3: Taxonomy & Classification Agent
 * 
 * Responsible for matching a product to the exact classpath in the official LOV.
 */

import { CLASSIFICATION_SYSTEM_PROMPT } from "@/lib/prompts";
import { SchemaCategory } from "@/lib/types";

export interface ClassificationInput {
  rawText: string;
}

export interface ClassificationResult {
  classpath: string;
  confidence: number;
}

export async function runClassification(input: ClassificationInput): Promise<ClassificationResult> {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  
  // Use explicit pinned models from process.env if available, fallback to flash
  const PRIMARY_MODEL = process.env.PRIMARY_MODEL || "gemini-3.6-flash";
  const model = genAI.getGenerativeModel({
    model: PRIMARY_MODEL,
    systemInstruction: CLASSIFICATION_SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  const userPrompt = `
Classify this product into the most specific classpath possible.
If it is a Dishwasher, use: "Appliances & Consumer Electronics>Kitchen Appliances>Built-In Dishwashers".
If you are unsure, output "unknown".

Raw Product Text:
${input.rawText}

Return JSON strictly matching this shape:
{
  "classpath": "string",
  "confidence": 0-100
}
  `;

  try {
    const result = await model.generateContent(userPrompt);
    const responseText = result.response.text();
    const jsonStr = responseText.replace(/```json|```/g, "").trim();
    return JSON.parse(jsonStr) as ClassificationResult;
  } catch (error) {
    console.error("Classification error:", error);
    return { classpath: "unknown", confidence: 0 };
  }
}
