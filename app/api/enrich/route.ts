import { NextRequest, NextResponse } from "next/server";
import { runEnrichment } from "@/lib/agents/enrich";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || !body.manufacturerName || !body.partNumber) {
      return NextResponse.json({ error: "Missing manufacturerName or partNumber" }, { status: 400 });
    }
    const result = await runEnrichment(body);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
