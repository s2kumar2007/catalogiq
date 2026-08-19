/**
 * lib/agents/classify.ts
 * Stage 3: Taxonomy & Classification Agent
 * 
 * Responsible for matching a product to the exact classpath in the official LOV.
 * CURRENTLY BLOCKED: Waiting for LOV file upload.
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
  // TODO: Load LOV data
  // TODO: Call Gemini/Groq using CLASSIFICATION_SYSTEM_PROMPT
  // TODO: Match exact classpath
  
  throw new Error("Classification Agent is blocked pending LOV dataset upload.");
}
