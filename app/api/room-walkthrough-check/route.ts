import { NextResponse } from "next/server";
import {
  callGroqJson,
  getClient,
  RoomWalkthroughModelResponseSchema,
  buildRoomWalkthroughPrompt,
  type RoomWalkthroughModelResponse,
} from "@/app/lib/groq";
import type { RoomWalkthroughCheckResponse, RoomWalkthroughResult } from "@/app/lib/types";

const MAX_IMAGES = 6;

// qwen/qwen3.8-27b (Groq free tier) hard-caps a single request at 3 images.
// This feature depends on the model cross-referencing photos of a room
// together to dedupe elements, so splitting into batches loses some of
// that — each batch only dedupes within itself, and mergeChunks() below
// does a second, cruder pass (name+category match) across batches.
const MAX_IMAGES_PER_CALL = 3;

// Groq's free-tier per-minute output-token budget can force a real ~45s
// retry wait (see callGroqJson) — give that room instead of hitting
// Vercel's default function timeout.
export const maxDuration = 120;

type Element = RoomWalkthroughModelResponse["detected_elements"][number];

function mergeElement(a: Element, b: Element): Element {
  const seen_in_images = [...new Set([...a.seen_in_images, ...b.seen_in_images])].sort((x, y) => x - y);
  const defectKey = (d: Element["defect_signatures"][number]) => d.signature.trim().toLowerCase();
  const defects = new Map(a.defect_signatures.map((d) => [defectKey(d), d]));
  for (const d of b.defect_signatures) {
    const key = defectKey(d);
    const existing = defects.get(key);
    if (!existing || d.confidence > existing.confidence) defects.set(key, d);
  }
  const primary = b.confidence > a.confidence ? b : a;
  return {
    element: primary.element,
    category: primary.category,
    seen_in_images,
    condition_observed: primary.condition_observed,
    defect_signatures: [...defects.values()],
    recommended_check: a.recommended_check ?? b.recommended_check,
    confidence: Math.max(a.confidence, b.confidence),
  };
}

// Merges room-walkthrough results from multiple ≤3-image batches into one.
// image_index / seen_in_images from each chunk are local to that chunk's
// prompt (always starts at image_1) — offset them back to the image's real
// position in the full upload before merging. Offsets come from the planned
// batch sizes (not accumulated only over successful batches), so a failed
// batch in the middle doesn't shift numbering for the ones after it.
function mergeChunks(
  room: string,
  totalImages: number,
  chunks: { offset: number; data: RoomWalkthroughModelResponse }[]
): RoomWalkthroughModelResponse {
  const image_quality: RoomWalkthroughModelResponse["image_quality"] = [];
  const elements: Element[] = [];

  for (const { offset, data } of chunks) {
    for (const q of data.image_quality) {
      image_quality.push({ ...q, image_index: q.image_index + offset });
    }
    for (const el of data.detected_elements) {
      const shifted: Element = { ...el, seen_in_images: el.seen_in_images.map((i) => i + offset) };
      const matchIndex = elements.findIndex(
        (existing) =>
          existing.element.trim().toLowerCase() === shifted.element.trim().toLowerCase() &&
          existing.category.trim().toLowerCase() === shifted.category.trim().toLowerCase()
      );
      if (matchIndex === -1) elements.push(shifted);
      else elements[matchIndex] = mergeElement(elements[matchIndex], shifted);
    }
  }

  const overall_summary = [...new Set(chunks.map((c) => c.data.overall_summary.trim()).filter(Boolean))].join(" ");

  return { room, images_analyzed: totalImages, image_quality, detected_elements: elements, overall_summary };
}

export async function POST(req: Request) {
  const body = await req.json();
  const room: string | undefined = body?.room;
  const images: string[] | undefined = body?.images;

  if (!room || !Array.isArray(images) || images.length === 0) {
    return NextResponse.json({ error: true, message: "room and at least one image are required" } satisfies RoomWalkthroughCheckResponse);
  }
  if (images.length > MAX_IMAGES) {
    return NextResponse.json({ error: true, message: `at most ${MAX_IMAGES} images are allowed per room` } satisfies RoomWalkthroughCheckResponse);
  }

  const ai = getClient(2);
  if (!ai) {
    return NextResponse.json({ error: true, message: "GROQ_API_KEY_2 not configured." } satisfies RoomWalkthroughCheckResponse);
  }

  try {
    // Balanced batches (e.g. 4 images -> [2,2], not [3,1]) — an even split
    // gives the model more context per element in each batch than a
    // near-empty leftover batch would.
    const numChunks = Math.ceil(images.length / MAX_IMAGES_PER_CALL);
    const chunkSize = Math.ceil(images.length / numChunks);
    const chunks: { offset: number; images: string[] }[] = [];
    for (let i = 0; i < images.length; i += chunkSize) {
      chunks.push({ offset: i, images: images.slice(i, i + chunkSize) });
    }

    const chunkResults = await Promise.all(
      chunks.map(({ offset, images: chunkImages }) =>
        callGroqJson(ai, RoomWalkthroughModelResponseSchema, buildRoomWalkthroughPrompt(room, chunkImages.length), chunkImages).then(
          (result) => ({ offset, result })
        )
      )
    );

    const successful = chunkResults.filter(
      (r): r is { offset: number; result: { success: true; data: RoomWalkthroughModelResponse } } => r.result.success
    );
    if (successful.length === 0) {
      console.error("[room-walkthrough-check]: model response failed schema validation twice");
      return NextResponse.json({ error: true, message: "Couldn't parse the model's response." } satisfies RoomWalkthroughCheckResponse);
    }

    const merged = mergeChunks(
      room,
      images.length,
      successful.map(({ offset, result }) => ({ offset, data: result.data }))
    );

    const result: RoomWalkthroughResult = {
      ...merged,
      detected_elements: merged.detected_elements.slice(0, 8),
    };

    return NextResponse.json({ result } satisfies RoomWalkthroughCheckResponse);
  } catch (e) {
    console.error("[room-walkthrough-check]:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: true, message: "The check failed. Try again." } satisfies RoomWalkthroughCheckResponse);
  }
}
