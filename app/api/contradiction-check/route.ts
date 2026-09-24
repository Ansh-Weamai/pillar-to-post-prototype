import { NextResponse } from "next/server";
import { callGroqJson, getClient, ContradictionModelResponseSchema, buildContradictionCheckPrompt } from "@/app/lib/groq";
import { contradictionAction } from "@/app/lib/contradictionScoring";
import type { ContradictionCheckResponse } from "@/app/lib/types";

// Groq's free-tier per-minute output-token budget can force a real ~45s
// retry wait (see callGroqJson) — give that room instead of hitting
// Vercel's default function timeout.
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json();
  const image: string | undefined = body?.image;
  const findingText: string | undefined = body?.findingText;

  if (!image || !findingText) {
    return NextResponse.json({ error: "image and findingText are required" }, { status: 400 });
  }

  const ai = getClient(3);
  if (!ai) {
    const response: ContradictionCheckResponse = { error: true, message: "GROQ_API_KEY_3 not configured." };
    return NextResponse.json(response);
  }

  try {
    const parsed = await callGroqJson(ai, ContradictionModelResponseSchema, buildContradictionCheckPrompt(findingText), [
      image,
    ]);

    if (!parsed.success) {
      console.error("[contradiction-check]: model response failed schema validation twice");
      const response: ContradictionCheckResponse = { error: true, message: "Couldn't parse the model's response." };
      return NextResponse.json(response);
    }

    const { verdict, confidence, reasoning, omissions } = parsed.data;
    const response: ContradictionCheckResponse = {
      result: {
        verdict,
        confidence,
        reasoning,
        omissions,
        recommended_action: contradictionAction(verdict, confidence, omissions),
      },
    };
    return NextResponse.json(response);
  } catch (e) {
    console.error("[contradiction-check]:", e instanceof Error ? e.message : e);
    const response: ContradictionCheckResponse = { error: true, message: "The check failed. Try again." };
    return NextResponse.json(response);
  }
}
