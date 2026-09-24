import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { callGroqJson, getClient, VisionResponseSchema, buildPhotoCheckPrompt } from "@/app/lib/groq";
import { mapWithConcurrency } from "@/app/lib/concurrency";
import type { ChecklistEntry, ItemUpdate } from "@/app/lib/types";

// Kept low: Groq's free tier enforces a per-minute *output tokens* budget
// (not just a request count), which firing every tagged location's photos
// at once could exceed on its own — see callGroqJson's retry-after
// handling for what happens when it does.
const CONCURRENCY = 2;

// Groq's free-tier per-minute output-token budget can force a real ~45s
// retry wait per photo (see callGroqJson) — give a full demo tour room to
// run instead of hitting Vercel's default function timeout.
export const maxDuration = 120;

type TourEntry = { location: string; photos: string[] };
type ItemVerdict = { visible: boolean; confidence: number; reasoning: string };

function mimeTypeForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function unparseableMap(requiredItems: string[], reasoning: string): Map<string, ItemVerdict> {
  return new Map(requiredItems.map((item) => [item, { visible: false, confidence: 0, reasoning }]));
}

async function checkPhoto(
  ai: NonNullable<ReturnType<typeof getClient>>,
  location: string,
  requiredItems: string[],
  photoPath: string
): Promise<Map<string, ItemVerdict>> {
  let dataUrl: string;
  try {
    const absPath = path.join(process.cwd(), "public", photoPath);
    const base64 = (await fs.readFile(absPath)).toString("base64");
    dataUrl = `data:${mimeTypeForPath(photoPath)};base64,${base64}`;
  } catch {
    return unparseableMap(requiredItems, "photo file missing");
  }

  try {
    const parsed = await callGroqJson(
      ai,
      VisionResponseSchema,
      buildPhotoCheckPrompt(location, requiredItems, false),
      [dataUrl]
    );
    if (!parsed.success) return unparseableMap(requiredItems, "model response unparseable");

    const map = unparseableMap(requiredItems, "item not returned by model");
    for (const result of parsed.data.results) {
      map.set(result.required_item, {
        visible: result.visible,
        confidence: result.confidence,
        reasoning: result.reasoning,
      });
    }
    return map;
  } catch {
    return unparseableMap(requiredItems, "vision call failed");
  }
}

export async function POST() {
  try {
    const [checklistRaw, tourRaw] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "data", "checklist.json"), "utf-8"),
      fs.readFile(path.join(process.cwd(), "data", "sample-tour.json"), "utf-8"),
    ]);

    const checklist: ChecklistEntry[] = JSON.parse(checklistRaw);
    const tour: TourEntry[] = JSON.parse(tourRaw);
    const tourByLocation = new Map(tour.map((t) => [t.location, t]));

    const ai = getClient(1);

    // Pass A: only locations present in the tour proceed to Pass B — one
    // model call per photo, across ALL tagged locations combined, run at a
    // shared concurrency cap (not per-location) so a tour with several
    // tagged rooms can't burst past the free-tier rate limit on its own.
    const taggedEntries = checklist.filter((entry) => tourByLocation.has(entry.location));

    const photoJobs = taggedEntries.flatMap((entry) => {
      const tourEntry = tourByLocation.get(entry.location)!;
      return tourEntry.photos.map((photo) => ({ entry, photo }));
    });

    const photoResults = ai
      ? await mapWithConcurrency(photoJobs, CONCURRENCY, ({ entry, photo }) =>
          checkPhoto(ai, entry.location, entry.required_items, photo)
        )
      : [];

    const perPhotoMapsByLocation = new Map<string, Map<string, ItemVerdict>[]>();
    photoJobs.forEach(({ entry }, i) => {
      const list = perPhotoMapsByLocation.get(entry.location) ?? [];
      list.push(photoResults[i]);
      perPhotoMapsByLocation.set(entry.location, list);
    });

    const taggedResults = taggedEntries.map((entry) => {
      const tourEntry = tourByLocation.get(entry.location)!;
      const thumbnail = tourEntry.photos[0];

      const itemResults = new Map<string, ItemVerdict>();
      if (!ai) {
        for (const item of entry.required_items) {
          itemResults.set(item, { visible: false, confidence: 0, reasoning: "GROQ_API_KEY_1 not configured" });
        }
      } else {
        const perPhotoMaps = perPhotoMapsByLocation.get(entry.location) ?? [];
        for (const item of entry.required_items) {
          let best: ItemVerdict = { visible: false, confidence: 0, reasoning: "not checked" };
          for (const map of perPhotoMaps) {
            const r = map.get(item);
            if (!r) continue;
            if (r.visible && !best.visible) best = r;
            else if (r.visible === best.visible && r.confidence > best.confidence) best = r;
          }
          itemResults.set(item, best);
        }
      }

      return { location: entry.location, thumbnail, itemResults };
    });

    const resultsByLocation = new Map(taggedResults.map((r) => [r.location, r]));

    const updates: ItemUpdate[] = [];
    for (const entry of checklist) {
      const tagged = resultsByLocation.get(entry.location);
      for (const item of entry.required_items) {
        if (!tagged) {
          updates.push({ location: entry.location, required_item: item, status: "missing", source: "demo" });
          continue;
        }
        const verdict = tagged.itemResults.get(item)!;
        updates.push({
          location: entry.location,
          required_item: item,
          status: verdict.visible ? "confirmed" : "partial",
          confidence: verdict.confidence,
          thumbnail: tagged.thumbnail,
          source: "demo",
        });
      }
    }

    return NextResponse.json({ updates });
  } catch (e) {
    console.error("[coverage-check]:", e instanceof Error ? e.message : e);
    return NextResponse.json({ updates: [] }, { status: 500 });
  }
}
