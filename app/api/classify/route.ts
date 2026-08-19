import { NextRequest, NextResponse } from "next/server";
import { runClassification } from "@/lib/agents/classify";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || !body.rawText) {
      return NextResponse.json({ error: "Missing rawText" }, { status: 400 });
    }
    const result = await runClassification({ rawText: body.rawText });
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
