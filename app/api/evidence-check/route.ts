import { NextResponse } from "next/server";
import {
  callGroqJson,
  getClient,
  EvidenceCheckModelResponseSchema,
  buildEvidenceCheckPrompt,
  type EvidenceCheckModelResponse,
} from "@/app/lib/groq";
import { defectAction, scoreImage } from "@/app/lib/evidenceScoring";
import { mapWithConcurrency } from "@/app/lib/concurrency";
import type { EvidenceCheckItem, EvidenceCheckResult, DefectSignature } from "@/app/lib/types";

const MAX_IMAGES = 10;
// Kept low: Groq's free tier enforces a per-minute *output tokens* budget
// (not just a request count), which a burst of 3 concurrent vision calls on
// non-trivial JSON responses can exceed on its own — see callGroqJson's
// retry-after handling for what happens when it does.
const CONCURRENCY = 2;

// Groq's free-tier per-minute output-token budget can force a real ~45s
// retry wait per image (see callGroqJson) — give a full batch of images
// room to run instead of hitting Vercel's default function timeout.
export const maxDuration = 120;

function unconfiguredResult(imageId: string): EvidenceCheckItem {
  return {
    image_id: imageId,
    analysis: {
      image_id: imageId,
      detected_location: null,
      location_confidence: null,
      image_quality: { usable: false, issue: null },
      defect_signatures: [],
      overall: {
        risk_score: 0,
        status: "unusable",
        recommended_action: "retake_photo",
        summary: "GROQ_API_KEY_2 not configured.",
      },
    },
  };
}

function buildResult(imageId: string, raw: EvidenceCheckModelResponse): EvidenceCheckResult {
  // Defensive: never let a photo the model couldn't actually read carry a
  // clean/needs-review verdict, even if it hallucinated defect signatures.
  if (!raw.image_quality.usable) {
    return {
      image_id: imageId,
      detected_location: raw.detected_location,
      location_confidence: raw.location_confidence,
      image_quality: raw.image_quality,
      defect_signatures: [],
      overall: {
        risk_score: 0,
        status: "unusable",
        recommended_action: "retake_photo",
        summary: raw.overall.summary,
      },
    };
  }

  const defect_signatures: DefectSignature[] = raw.defect_signatures.map((d) => ({
    ...d,
    recommended_action: defectAction(d.severity, d.confidence),
  }));

  const { risk_score, status, recommended_action } = scoreImage(defect_signatures);

  return {
    image_id: imageId,
    detected_location: raw.detected_location,
    location_confidence: raw.location_confidence,
    image_quality: raw.image_quality,
    defect_signatures,
    overall: { risk_score, status, recommended_action, summary: raw.overall.summary },
  };
}

async function analyzeImage(
  ai: NonNullable<ReturnType<typeof getClient>>,
  imageId: string,
  dataUrl: string
): Promise<EvidenceCheckItem> {
  try {
    const parsed = await callGroqJson(ai, EvidenceCheckModelResponseSchema, buildEvidenceCheckPrompt(), [dataUrl]);

    if (!parsed.success) {
      console.error(`[evidence-check] ${imageId}: model response failed schema validation twice`);
      return { image_id: imageId, error: true };
    }

    return { image_id: imageId, analysis: buildResult(imageId, parsed.data) };
  } catch (e) {
    console.error(`[evidence-check] ${imageId}:`, e instanceof Error ? e.message : e);
    return { image_id: imageId, error: true };
  }
}

export async function POST(req: Request) {
  const body = await req.json();
  const images: string[] | undefined = body?.images;

  if (!Array.isArray(images) || images.length === 0) {
    return NextResponse.json({ error: "at least one image is required" }, { status: 400 });
  }
  if (images.length > MAX_IMAGES) {
    return NextResponse.json({ error: `at most ${MAX_IMAGES} images are allowed per batch` }, { status: 400 });
  }

  const imageIds = images.map((_, i) => `img_${i + 1}`);
  const ai = getClient(2);

  const results = ai
    ? await mapWithConcurrency(images, CONCURRENCY, (dataUrl, index) => analyzeImage(ai, imageIds[index], dataUrl))
    : imageIds.map(unconfiguredResult);

  return NextResponse.json({ results });
}
