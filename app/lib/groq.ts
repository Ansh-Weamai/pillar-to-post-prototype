import Groq from "groq-sdk";
import { z } from "zod";
import type { ChecklistEntry } from "@/app/lib/types";

export const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

// Each feature calls out with its own key (GROQ_API_KEY_1/2/3) so usage/
// quota/rate limits can be tracked and capped per feature independently,
// even though all three hit the same model.
export function getClient(feature: 1 | 2 | 3): Groq | null {
  const apiKey = process.env[`GROQ_API_KEY_${feature}`];
  return apiKey ? new Groq({ apiKey }) : null;
}

export const ItemResultSchema = z.object({
  required_item: z.string(),
  visible: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

export const VisionResponseSchema = z.object({
  results: z.array(ItemResultSchema),
});

export const ReportItemResultSchema = z.object({
  location: z.string(),
  required_item: z.string(),
  documented: z.boolean(),
  confidence: z.number().min(0).max(1),
  condition: z.enum(["Satisfactory", "Needs Repair", "Limitation"]).nullable(),
});

export const ReportResponseSchema = z.object({
  results: z.array(ReportItemResultSchema),
});

export function buildPhotoCheckPrompt(location: string, requiredItems: string[], multiPhoto: boolean) {
  return `You are doing a second-pass quality check on home inspection photos. You are
NOT diagnosing the property — you are only checking whether specific items
are visibly present in the photo${multiPhoto ? "s" : ""}.

Location tagged for ${multiPhoto ? "these photos" : "this photo"}: ${location}
Items to check for: ${requiredItems.join(", ")}
${multiPhoto ? "\nThese images are ALL from the same location. An item counts as visible if it appears in ANY of them.\n" : ""}
For EACH item, decide if it is visibly identifiable. Respond ONLY with JSON
matching this exact shape, one object per item, no other text:

{
  "results": [
    {
      "required_item": "<the item name, exactly as given>",
      "visible": true | false,
      "confidence": <number 0 to 1>,
      "reasoning": "<one short sentence, plain language, max 15 words>"
    }
  ]
}

If a photo shows visible UI chrome (a sidebar, a floor plan overlay, a
comments panel) around the actual room content, ignore the chrome and judge
only the photographed scene itself.`;
}

export function buildReportCheckPrompt(checklist: ChecklistEntry[], source: "image" | "text" = "image") {
  const checklistText = checklist
    .map((entry) => `- ${entry.location}: ${entry.required_items.join(", ")}`)
    .join("\n");

  return `You are looking at ${source === "text" ? "the text extracted from" : ""} a home inspection report. Here is the full checklist of
locations and required items we expect to see documented:

${checklistText}

Go through the document and determine, for EACH location above:
1. Is this location discussed${source === "image" ? " or photographed" : ""} anywhere in the document?
2. For each required item under that location, is it ${source === "image" ? "visibly" : "clearly"} documented?
3. If documented, what condition does the report state or imply for it —
   "Satisfactory" (no issue reported), "Needs Repair" (a defect, damage, or
   repair recommendation is stated), or "Limitation" (the report explicitly
   says the item couldn't be fully evaluated)? If not documented at all,
   condition is null — there is nothing to rate.

Respond ONLY with JSON:
{
  "results": [
    {
      "location": "...",
      "required_item": "...",
      "documented": true|false,
      "confidence": 0-1,
      "condition": "Satisfactory" | "Needs Repair" | "Limitation" | null
    }
  ]
}

Cover every location and every required item from the checklist above, even
ones the document never mentions (documented: false, condition: null for
those).`;
}

// Feature 2 — Evidence Consistency: raw per-image model output. The model
// only reports what it observes; risk_score/status/recommended_action are
// computed deterministically afterward (see app/lib/evidenceScoring.ts).
export const EvidenceDefectSignatureSchema = z.object({
  signature: z.string(),
  description: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  region: z.string(),
});

export const EvidenceCheckModelResponseSchema = z.object({
  detected_location: z.string().nullable(),
  location_confidence: z.number().min(0).max(1).nullable(),
  image_quality: z.object({
    usable: z.boolean(),
    issue: z.enum(["blurry", "too_dark", "obstructed"]).nullable(),
  }),
  defect_signatures: z.array(EvidenceDefectSignatureSchema),
  overall: z.object({
    summary: z.string(),
  }),
});

export type EvidenceCheckModelResponse = z.infer<typeof EvidenceCheckModelResponseSchema>;

// Shared across features — appended to the prompt and resent once if the
// first response fails schema validation.
export const RETRY_JSON_ONLY_SUFFIX =
  "Your previous response could not be parsed as valid JSON. Return ONLY the JSON object, nothing else — no explanation, no markdown code fences.";

export function buildEvidenceCheckPrompt(): string {
  return `You are performing an independent visual review of a single home inspection
photo. You have NOT been told what room this is or what an inspector wrote
about it — judge only what is visible in the image itself.

Rules:
- Only report what you can actually see. If something is not visible or you
  cannot tell, do not guess — use null, or leave defect_signatures empty.
- Do not diagnose the building or claim a hidden defect exists behind a
  surface. Only describe observable evidence: staining, cracking, corrosion,
  visible leaks, missing hardware, wear, damage.
- If the photo is too blurry, dark, or obstructed to evaluate reliably, set
  image_quality.usable to false and say so — do not force an answer. When
  usable is false, defect_signatures must be an empty array.
- detected_location is your best guess of the room/area shown. If you
  genuinely cannot tell, use null rather than guessing.

Respond ONLY with JSON matching this exact shape, no markdown fences, no
extra commentary:

{
  "detected_location": "bathroom" | null,
  "location_confidence": 0.8 | null,
  "image_quality": { "usable": true, "issue": "blurry" | "too_dark" | "obstructed" | null },
  "defect_signatures": [
    {
      "signature": "water staining",
      "description": "one plain sentence, only what's visible",
      "severity": "low" | "medium" | "high",
      "confidence": 0.75,
      "region": "lower left near the base"
    }
  ],
  "overall": { "summary": "one plain sentence, max 20 words" }
}`;
}

// Feature 2 — Room Walkthrough mode: several photos of the same room, no
// fixed checklist. Raw model output only — nothing computed afterward, this
// mode has no deterministic scoring layer (unlike Single Photo mode).
export const RoomWalkthroughElementSchema = z.object({
  element: z.string(),
  category: z.string(),
  seen_in_images: z.array(z.number()),
  condition_observed: z.string(),
  defect_signatures: z.array(
    z.object({
      signature: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      confidence: z.number().min(0).max(1),
    })
  ),
  recommended_check: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const RoomWalkthroughModelResponseSchema = z.object({
  room: z.string(),
  images_analyzed: z.number(),
  image_quality: z.array(
    z.object({
      image_index: z.number(),
      usable: z.boolean(),
      issue: z.enum(["blurry", "too_dark", "obstructed"]).nullable(),
    })
  ),
  detected_elements: z.array(RoomWalkthroughElementSchema),
  overall_summary: z.string(),
});

export type RoomWalkthroughModelResponse = z.infer<typeof RoomWalkthroughModelResponseSchema>;

export function buildRoomWalkthroughPrompt(room: string, imageCount: number): string {
  return `You are reviewing ${imageCount} photos of the same room (${room}), taken from different
angles/walls. You have NOT been given a checklist — decide for yourself what
is actually worth checking, based only on what you can see.

Images are provided as image_1 through image_${imageCount}, in that order.

For each image, first note if it is too blurry, dark, or obstructed to
evaluate reliably.

Then identify up to 8 distinct checkable elements visible across these
photos — things like windows, outlets, flooring, fixtures, vents, visible
wall or ceiling condition, doors, built-ins. Only list something you can
actually point to in a specific image. Do not invent items to fill out the
list, and do not repeat the same physical element twice just because it
appears in more than one photo — merge it into one entry citing all the
images it appears in.

For each element: describe its condition in plain language, note any visible
defect signatures with severity and confidence (empty if none), and — only
if genuinely useful and not obvious from the photo alone — note one specific
thing a human inspector should physically check that the photo can't confirm
(e.g. "test this outlet with a plug-in tester", "verify this window latches
and seals properly"). Leave this null if there's nothing non-obvious to add.

Respond ONLY with JSON matching this exact shape, no markdown fences, no
extra commentary:

{
  "room": "${room}",
  "images_analyzed": ${imageCount},
  "image_quality": [
    { "image_index": 1, "usable": true, "issue": null }
  ],
  "detected_elements": [
    {
      "element": "<short label, e.g. 'window, left wall'>",
      "category": "<general type, e.g. 'window' | 'outlet' | 'flooring' | 'wall' | 'fixture' | 'vent' | 'door'>",
      "seen_in_images": [1, 3],
      "condition_observed": "<one plain sentence>",
      "defect_signatures": [
        { "signature": "<name>", "severity": "low" | "medium" | "high", "confidence": 0.7 }
      ],
      "recommended_check": "<one sentence, or null>",
      "confidence": 0.8
    }
  ],
  "overall_summary": "<one sentence, max 20 words>"
}`;
}

// Feature 3 — Contradiction Flag: photo + finding text checked together in
// one call. The model reports verdict/confidence/reasoning/omissions only;
// recommended_action is computed deterministically afterward (see
// app/lib/contradictionScoring.ts) so it isn't the model self-grading.
export const OmissionSchema = z.object({
  description: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
});

export const ContradictionModelResponseSchema = z.object({
  verdict: z.enum(["match", "mismatch"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  omissions: z.array(OmissionSchema),
});

export type ContradictionModelResponse = z.infer<typeof ContradictionModelResponseSchema>;

export function buildContradictionCheckPrompt(findingText: string): string {
  return `You are checking a home inspector's written finding against the accompanying
photo, in two directions. You are NOT inspecting the home yourself and NOT
judging how well-written the finding is.

Inspector's finding: "${findingText}"

Direction 1 — does the finding hold up? Does this photo plausibly show what
the finding describes? Consider it a match if the photo is consistent with
it, even if not every detail is captured. Consider it a mismatch if the
photo shows something clearly different from, or contradicted by, the
finding (wrong location, wrong object, or the described issue is not
remotely visible).

Direction 2 — does the finding miss anything? Separately, look at the WHOLE
photo for anything else visibly wrong or noteworthy that the finding text
does NOT mention at all. Only report something here if it is clearly
visible — do not invent minor details to fill this list. An empty list is a
correct answer if nothing else stands out.

Respond ONLY with JSON matching this exact shape, no markdown fences, no
extra commentary:

{
  "verdict": "match" | "mismatch",
  "confidence": <number 0 to 1>,
  "reasoning": "<one sentence, max 20 words, plain language>",
  "omissions": [
    { "description": "<plain language, max 15 words>", "severity": "low" | "medium" | "high", "confidence": <0 to 1> }
  ]
}`;
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) throw new Error("invalid data URL");
  return { mimeType: match[1], data: match[2] };
}

// A handful of transient failure modes worth one backoff-retry round on:
// rate limiting and server-side/transient errors. Anything else (bad
// request, auth, not found) fails fast instead of stalling the request.
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 1500;
// Groq's free tier enforces a per-minute *output tokens* budget (not just
// request count) that's easy to exceed with one non-trivial JSON response —
// a 429 here comes back with a `retry-after` header naming the actual wait
// (seen up to ~45s in testing). Respect it (capped, so one retry can't run
// past a route's maxDuration) rather than a fixed short backoff that has no
// chance of clearing a per-minute quota.
const MAX_RETRY_DELAY_MS = 50_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Models occasionally ignore "no markdown fences" / "no extra commentary"
// instructions and wrap the JSON in ```json fences or a leading/trailing
// sentence. Strip fences and, failing a direct parse, fall back to the
// outermost {...} substring rather than failing on text that IS valid JSON
// once the wrapper is removed.
function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return candidate.slice(start, end + 1);
    }
    return candidate;
  }
}

function errorStatus(e: unknown): number | undefined {
  return e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number"
    ? (e as { status: number }).status
    : undefined;
}

function isRetryableError(e: unknown): boolean {
  const status = errorStatus(e);
  return status === undefined || RETRYABLE_STATUS_CODES.has(status);
}

function retryDelayMs(e: unknown): number {
  const headers = e && typeof e === "object" && "headers" in e ? (e as { headers: unknown }).headers : undefined;
  const retryAfter = headers instanceof Headers ? headers.get("retry-after") : null;
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_DELAY_MS) : DEFAULT_RETRY_DELAY_MS;
}

// Runs a Groq vision chat completion with JSON-object mode, one backoff
// retry on a transient API error (rate limit / server overload), and one
// retry with a corrective prompt if the response isn't valid JSON matching
// the schema. Never throws — every path resolves to { success: false } once
// attempts are exhausted, so callers can degrade gracefully.
export async function callGroqJson<T>(
  ai: Groq,
  schema: z.ZodType<T>,
  promptText: string,
  imageDataUrls: string[]
): Promise<{ success: true; data: T } | { success: false }> {
  const imageParts = imageDataUrls.map((url) => ({ type: "image_url" as const, image_url: { url } }));
  let text = promptText;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string | null | undefined;
    try {
      const completion = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text }, ...imageParts],
          },
        ],
        response_format: { type: "json_object" },
        // qwen3 models reason by default (reasoning_effort defaults to
        // "medium") and, without this, that <think>...</think> reasoning
        // gets interleaved into message.content alongside the JSON —
        // extractJsonObject's brace-matching then grabs braces out of the
        // reasoning text instead of the actual answer, so parsing fails
        // more often the longer/more complex the prompt is (rare in quick
        // dev smoke tests, routine under real multi-image/production
        // traffic). Hiding it keeps content pure JSON.
        reasoning_format: "hidden",
      });
      raw = completion.choices[0]?.message?.content;
    } catch (e) {
      const retryable = isRetryableError(e);
      const delay = retryDelayMs(e);
      console.error(
        `[callGroqJson] attempt ${attempt}/2 (${retryable ? `retrying after ${delay}ms` : "not retryable"}):`,
        e instanceof Error ? e.message : e
      );
      if (!retryable || attempt === 2) return { success: false };
      await sleep(delay);
      continue;
    }

    let parsedJson: unknown;
    let issue: string | undefined;
    try {
      parsedJson = JSON.parse(extractJsonObject(raw ?? ""));
    } catch (e) {
      issue = `Response was not valid JSON (${e instanceof Error ? e.message : String(e)}).`;
    }

    const result = issue ? undefined : schema.safeParse(parsedJson);
    if (result?.success) return result;
    if (!issue) issue = z.prettifyError(result!.error);

    console.error(`[callGroqJson] attempt ${attempt}/2: response failed validation — ${issue}`);
    if (attempt === 2) return { success: false };

    text = `${promptText}\n\n${RETRY_JSON_ONLY_SUFFIX}\n\nYour previous response was:\n${raw ?? "(empty)"}\n\nThat response failed with this error:\n${issue}\n\nFix it and return ONLY the corrected JSON, matching the required shape exactly.`;
  }

  return { success: false };
}
