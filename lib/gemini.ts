/**
 * lib/gemini.ts — Gemini API client helper
 *
 * Usage (once implemented):
 *   import { geminiGenerate } from "@/lib/gemini";
 *   const result = await geminiGenerate({ prompt: "..." });
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY && process.env.NODE_ENV !== "test") {
  console.warn("[gemini] GEMINI_API_KEY is not set. API calls will fail.");
}

// TODO: install @google/generative-ai and implement client
export async function geminiGenerate(_params: { prompt: string }): Promise<string> {
  throw new Error("geminiGenerate is not yet implemented");
}
