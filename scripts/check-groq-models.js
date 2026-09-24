#!/usr/bin/env node
// Lists every model your GROQ_API_KEY_1 currently has access to.
// Usage: node scripts/check-groq-models.js
//
// Groq model availability shifts over time (previews get retired, free-tier
// limits differ per model), so re-run this whenever GROQ_MODEL starts
// failing instead of guessing a new name. Cross-check vision support (needed
// by this app) against https://console.groq.com/docs/models.

const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const apiKey = process.env.GROQ_API_KEY_1;
if (!apiKey) {
  console.error("GROQ_API_KEY_1 is not set in .env");
  process.exit(1);
}

async function main() {
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await res.json();

  if (!res.ok) {
    console.error(`Key rejected (HTTP ${res.status}):`, body.error?.message ?? body);
    process.exit(1);
  }

  console.log(`${body.data.length} models visible to this key:\n`);
  for (const m of body.data) {
    console.log(`  ${m.id}`);
  }

  console.log(
    "\nThis only confirms the model is LISTED for your key — a 400/429/503 on\n" +
      "an actual chat completion call still happens for models that don't\n" +
      "support image input, or during a transient rate limit/overload. To\n" +
      "confirm one actually works right now:\n" +
      "  node -e \"require('@next/env').loadEnvConfig(process.cwd()); const Groq=require('groq-sdk').default; new Groq({apiKey:process.env.GROQ_API_KEY_1}).chat.completions.create({model:'MODEL_NAME_HERE',messages:[{role:'user',content:'hi'}]}).then(r=>console.log(r.choices[0].message.content)).catch(e=>console.error(e.message))\""
  );
}

main();
