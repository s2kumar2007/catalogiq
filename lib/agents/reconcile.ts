/**
 * lib/agents/reconcile.ts
 * Shared reconciliation agent logic — merges multi-source extraction results.
 */

import { callGroq, parseJsonResponse } from "@/lib/groq";
import { RECONCILIATION_SYSTEM_PROMPT } from "@/lib/prompts";
import type { ExtractedField, DisagreementLogEntry } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationSourceInput {
  source_name: string;
  source_type: "manufacturer_pdf" | "ecommerce_listing" | "scraped_page";
  extraction_result: {
    schema_match: string;
    extracted_fields: Record<string, ExtractedField>;
    notes?: string;
  };
}

export interface ReconciliationResult {
  reconciled_fields: Record<string, {
    value: string | number;
    confidence: number;
    source_location: string;
    resolution_type: "single_source" | "agreement" | "trust_hierarchy" | "needs_human_review";
  }>;
  disagreement_log: DisagreementLogEntry[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Core Reconciliation function
// ---------------------------------------------------------------------------

export async function runReconciliation(
  sources: ReconciliationSourceInput[]
): Promise<ReconciliationResult> {
  if (sources.length === 0) {
    throw new Error("Reconciliation requires at least one source.");
  }

  // ── Build Groq user message ───────────────────────────────────────────────
  const userContent = `Sources extraction results to reconcile:\n${JSON.stringify(sources, null, 2)}`;

  // ── Call Groq ─────────────────────────────────────────────────────────────
  const rawResponse = await callGroq(RECONCILIATION_SYSTEM_PROMPT, userContent);

  // ── Parse ─────────────────────────────────────────────────────────────────
  const result = parseJsonResponse<ReconciliationResult>(rawResponse);

  // Normalise arrays and maps
  if (!result.reconciled_fields) {
    result.reconciled_fields = {};
  }
  if (!Array.isArray(result.disagreement_log)) {
    result.disagreement_log = [];
  }

  // Clamp reconciled confidence values
  for (const field of Object.values(result.reconciled_fields)) {
    field.confidence = Math.min(99, Math.max(0, Math.round(field.confidence)));
  }

  return result;
}
