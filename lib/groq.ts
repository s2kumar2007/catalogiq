/**
 * lib/groq.ts — Groq API client helper
 *
 * Usage (once implemented):
 *   import { groqChat } from "@/lib/groq";
 *   const result = await groqChat({ messages: [...] });
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY && process.env.NODE_ENV !== "test") {
  console.warn("[groq] GROQ_API_KEY is not set. API calls will fail.");
}

// TODO: install groq-sdk and implement client
export async function groqChat(_params: {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  model?: string;
}): Promise<string> {
  throw new Error("groqChat is not yet implemented");
}
