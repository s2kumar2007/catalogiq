/**
 * app/api/reconcile/route.ts
 * Reconciliation Agent HTTP endpoint — thin wrapper around lib/agents/reconcile.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { runReconciliation, ReconciliationSourceInput } from "@/lib/agents/reconcile";

export async function POST(req: NextRequest) {
  let body: {
    sources?: ReconciliationSourceInput[];
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { sources } = body;

  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return NextResponse.json(
      { error: "Missing or invalid sources array. Reconciliation requires at least one source." },
      { status: 400 }
    );
  }

  try {
    const result = await runReconciliation(sources);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
