import { NextRequest, NextResponse } from "next/server";
import { runNormalization } from "@/lib/agents/normalize";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || !body.fields) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }
    const result = await runNormalization(body.fields);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
