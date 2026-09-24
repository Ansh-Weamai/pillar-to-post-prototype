import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { callGroqJson, getClient, VisionResponseSchema, buildPhotoCheckPrompt } from "@/app/lib/groq";
import type { ChecklistEntry, ItemUpdate } from "@/app/lib/types";

// Groq's free-tier per-minute output-token budget can force a real ~45s
// retry wait (see callGroqJson) — give that room instead of hitting
// Vercel's default function timeout.
export const maxDuration = 120;

// qwen/qwen3.8-27b (Groq free tier) hard-caps a single request at 3 images.
// Unlike room-walkthrough, "is this item visible in ANY of these photos" is
// safe to split across calls and merge afterward — no cross-image dedup is
// needed, so chunk instead of capping how many photos a room can have.
const MAX_IMAGES_PER_CALL = 3;

type ItemVerdict = { visible: boolean; confidence: number; reasoning: string };

function betterVerdict(a: ItemVerdict, b: ItemVerdict): ItemVerdict {
  if (b.visible && !a.visible) return b;
  if (b.visible === a.visible && b.confidence > a.confidence) return b;
  return a;
}

export async function POST(req: Request) {
  const body = await req.json();
  const location: string | undefined = body?.location;
  const images: string[] | undefined = body?.images;

  if (!location || !Array.isArray(images) || images.length === 0) {
    return NextResponse.json({ error: "location and at least one image are required" }, { status: 400 });
  }

  try {
    const checklistRaw = await fs.readFile(path.join(process.cwd(), "data", "checklist.json"), "utf-8");
    const checklist: ChecklistEntry[] = JSON.parse(checklistRaw);
    const entry = checklist.find((e) => e.location === location);

    if (!entry) {
      return NextResponse.json({ error: `unknown location "${location}"` }, { status: 400 });
    }

    const ai = getClient(1);
    if (!ai) {
      const updates: ItemUpdate[] = entry.required_items.map((item) => ({
        location,
        required_item: item,
        status: "partial",
        confidence: 0,
        source: "upload",
      }));
      return NextResponse.json({ updates });
    }

    const chunks: string[][] = [];
    for (let i = 0; i < images.length; i += MAX_IMAGES_PER_CALL) {
      chunks.push(images.slice(i, i + MAX_IMAGES_PER_CALL));
    }

    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        callGroqJson(ai, VisionResponseSchema, buildPhotoCheckPrompt(location, entry.required_items, chunk.length > 1), chunk)
      )
    );

    const resultByItem = new Map<string, ItemVerdict>();
    for (const parsed of chunkResults) {
      if (!parsed.success) continue;
      for (const r of parsed.data.results) {
        const existing = resultByItem.get(r.required_item);
        resultByItem.set(r.required_item, existing ? betterVerdict(existing, r) : r);
      }
    }

    const updates: ItemUpdate[] = entry.required_items.map((item) => {
      const result = resultByItem.get(item);
      if (!result) {
        return { location, required_item: item, status: "partial", confidence: 0, source: "upload" };
      }
      return {
        location,
        required_item: item,
        status: result.visible ? "confirmed" : "partial",
        confidence: result.confidence,
        source: "upload",
      };
    });

    return NextResponse.json({ updates });
  } catch (e) {
    console.error("[check-room]:", e instanceof Error ? e.message : e);
    return NextResponse.json({ updates: [] }, { status: 500 });
  }
}
