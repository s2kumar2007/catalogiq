import { NextRequest, NextResponse } from "next/server";
import { runFormatting } from "@/lib/agents/format";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || !body.normalizedFields) {
      return NextResponse.json({ error: "Missing normalizedFields" }, { status: 400 });
    }
    const result = await runFormatting(body.normalizedFields);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
