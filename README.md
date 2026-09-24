# PTP360 Second-Pass QA

Prototype QA tool for home inspection photos — coverage check, evidence
consistency, and contradiction flagging, built on Next.js (App Router) +
`groq-sdk` (Groq, Llama 4 vision). See `requirements.txt` and `BUILD_PROMPT.md` /
`BUILD_PROMPT_REVISION_2.md` for the original design/build spec.

## Prerequisites

- Node.js `>= 18.17` (this machine has v24 — fine)
- npm (comes with Node)
- A Groq API key from [console.groq.com/keys](https://console.groq.com/keys)
- A GitHub account + [Git](https://git-scm.com/downloads) installed

---

## Part 1 — Push this project to GitHub (do this now, on this machine)

1. **Check what's about to be committed.** `.env` holds your real API key —
   the `.gitignore` in this repo already excludes it, but it's worth a
   sanity check before the first commit:

   ```bash
   git init
   git status
   ```

   Confirm `.env` is **not** listed under files to be committed (it should
   be silently ignored). If it shows up, stop and fix `.gitignore` before
   continuing.

2. **Stage and commit everything else:**

   ```bash
   git add .
   git commit -m "Initial commit: PTP360 second-pass QA prototype"
   ```

3. **Create the GitHub repo.** Either on [github.com/new](https://github.com/new)
   (don't initialize it with a README/gitignore — this project already has
   both), or via the GitHub CLI if you have it installed:

   ```bash
   gh repo create ptp360-second-pass-qa --private --source=. --remote=origin
   ```

4. **Push:**

   ```bash
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```

   (Skip the `git remote add` step if you used `gh repo create` above — it
   already wires up the remote.)

---

## Part 2 — Continue from home (or any other machine)

1. **Clone the repo:**

   ```bash
   git clone https://github.com/<your-username>/<repo-name>.git
   cd <repo-name>
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Set up your environment variables.** `.env` is gitignored on purpose
   (it holds your API key), so it does not come down with `git clone`.
   Recreate it from the template:

   ```bash
   cp .env.example .env
   ```

   Then open `.env` and fill in:

   ```
   GROQ_API_KEY_1=<your real key from console.groq.com/keys>
   GROQ_API_KEY_2=<can reuse the same key, or a separate one per feature>
   GROQ_API_KEY_3=<can reuse the same key, or a separate one per feature>
   GROQ_MODEL=qwen/qwen3.8-27b
   ```

4. **Run the dev server:**

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) — it redirects to
   `/coverage`.

5. **Verify a production build works too** (optional but recommended before
   deploying):

   ```bash
   npm run build
   npm run start
   ```

---

## Available scripts

| Command         | What it does                          |
|-----------------|----------------------------------------|
| `npm run dev`   | Start the dev server on port 3000      |
| `npm run build` | Production build                       |
| `npm run start` | Serve the production build             |
| `npm run lint`  | Run ESLint                             |

## Project structure

```
app/
  coverage/            Feature 1 — Coverage Check (fully built)
  evidence-check/      Feature 2 — placeholder
  contradiction-check/ Feature 3 — placeholder
  api/
    coverage-check/    "Load demo data" — runs the bundled sample tour
    check-room/        "+ Add photo" — live per-room photo upload + check
    upload-report/     "Upload report" — whole-document (PDF/image) check
  components/          Sidebar, RoomCard, StatusIcon, Lightbox, UploadReportModal
  lib/                 Shared types, Groq client/prompts, client room-state logic
data/
  checklist.json       The full inspection checklist (locations + required items)
  sample-tour.json     Demo tour data (which locations have photos, for "Load demo data")
public/sample-images/  The 3 bundled demo photos
```

## Deploying (Vercel)

This is a standard Next.js app, so [Vercel](https://vercel.com) works with
zero config:

1. Import the GitHub repo in the Vercel dashboard.
2. Add the same environment variables from your `.env` (`GROQ_API_KEY_1`,
   `GROQ_API_KEY_2`, `GROQ_API_KEY_3`, `GROQ_MODEL`) under Project Settings →
   Environment Variables.
3. Deploy — Vercel auto-builds on every push to `main`.

## Notes

- No database — everything is static config (`data/*.json`) or computed
  on-demand per request. See `requirements.txt` for the full reasoning.
- Never commit `.env`. If you ever rotate a Groq API key, only `.env`
  (local) and your deployment platform's environment variables need
  updating — nothing in the codebase references the key directly.
