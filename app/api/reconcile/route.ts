import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/reconcile
 * Reconciliation agent: merges multi-source extractions, resolves conflicts.
 */
export async function POST(req: NextRequest) {
  // TODO: implement reconciliation logic
  return NextResponse.json({ message: "reconcile stub" }, { status: 200 });
}
