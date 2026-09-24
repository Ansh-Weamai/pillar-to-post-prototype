import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { callGroqJson, getClient, ReportResponseSchema, buildReportCheckPrompt, parseDataUrl } from "@/app/lib/groq";
import type { ChecklistEntry, ItemUpdate } from "@/app/lib/types";

// Groq's vision models take actual images (png/jpeg/webp/gif) via image_url,
// not PDFs. A non-image upload is a PDF (per UploadReportModal's `.pdf,image/*`
// accept + isImage check) — extract its text and send that instead of pixels.
// unpdf runs pdfjs without a separate worker file/thread, which is what
// makes it safe to bundle into a Next.js route handler (pdf-parse's own
// worker resolution breaks under Next's bundler). Text is capped well
// under the model's context/TPM budget on the free tier.
const MAX_PDF_TEXT_CHARS = 60000;

// Groq's free-tier per-minute output-token budget can force a real ~45s
// retry wait (see callGroqJson) — give that room instead of hitting
// Vercel's default function timeout.
export const maxDuration = 120;

async function extractPdfText(base64: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, "base64")));
  const { text } = await extractText(pdf, { mergePages: true });
  return text.slice(0, MAX_PDF_TEXT_CHARS);
}

export async function POST(req: Request) {
  const body = await req.json();
  const dataUrl: string | undefined = body?.dataUrl;

  if (!dataUrl) {
    return NextResponse.json({ error: "dataUrl is required" }, { status: 400 });
  }

  try {
    const checklistRaw = await fs.readFile(path.join(process.cwd(), "data", "checklist.json"), "utf-8");
    const checklist: ChecklistEntry[] = JSON.parse(checklistRaw);

    const allItems = checklist.flatMap((entry) =>
      entry.required_items.map((item) => ({ location: entry.location, required_item: item }))
    );
    const undocumentedUpdates = (): ItemUpdate[] =>
      allItems.map((i) => ({ ...i, status: "missing", source: "report", condition: null }));

    const ai = getClient(1);
    if (!ai) {
      return NextResponse.json({ updates: undocumentedUpdates() });
    }

    const { mimeType, data } = parseDataUrl(dataUrl);
    const isImage = mimeType.startsWith("image/");

    const parsed = isImage
      ? await callGroqJson(ai, ReportResponseSchema, buildReportCheckPrompt(checklist, "image"), [dataUrl])
      : await (async () => {
          const reportText = (await extractPdfText(data)).trim();
          if (!reportText) {
            console.error("[upload-report]: PDF text extraction produced no text (scanned/image-only PDF?)");
            return { success: false as const };
          }
          const prompt = `${buildReportCheckPrompt(checklist, "text")}\n\nHere is the full text extracted from the report document:\n\n"""\n${reportText}\n"""`;
          return callGroqJson(ai, ReportResponseSchema, prompt, []);
        })();

    const resultByKey = new Map(
      parsed.success ? parsed.data.results.map((r) => [`${r.location}::${r.required_item}`, r]) : []
    );

    const updates: ItemUpdate[] = allItems.map(({ location, required_item }) => {
      const result = resultByKey.get(`${location}::${required_item}`);
      if (!result || !result.documented) {
        return { location, required_item, status: "missing", source: "report", condition: null };
      }
      return {
        location,
        required_item,
        status: "confirmed",
        confidence: result.confidence,
        source: "report",
        condition: result.condition,
      };
    });

    return NextResponse.json({ updates });
  } catch (e) {
    console.error("[upload-report]:", e instanceof Error ? e.message : e);
    return NextResponse.json({ updates: [] }, { status: 500 });
  }
}
