# Creagent

Local-first agentic content creation. Ingest your work, learn your voice, keep
a two-week queue drafted, and approve everything in one place. Built for the
Meta Global AI Developer Hackathon (Indie Dev Track).

All LLM intelligence runs on the **Meta Model API**. The app runs entirely on
your machine; keys are encrypted locally and never leave your computer except
in direct calls to each provider.

## Install (one command)

macOS or Linux. Prerequisites: **Node.js 20+** and **git**. The database
(SQLite) and job queue are embedded, and ffmpeg/whisper are fetched
automatically — nothing else to install or start:

```bash
curl -fsSL https://raw.githubusercontent.com/masonleetompkins/creagent/main/install.sh | bash
```

This clones the repo to `~/.local/share/creagent` (or updates it on
re-runs), installs dependencies, builds, then:

- macOS: adds **Creagent** to `~/Applications` (no sudo, no
  Gatekeeper friction — the installer clears its own quarantine bit).
- Linux: adds an app-menu entry via
  `~/.local/share/applications/creagent.desktop`.

Then it starts the server and opens the app in its own fullscreen window
(Chrome app mode when Chrome is installed, otherwise a browser tab at
`http://127.0.0.1:3000`).

First install takes several minutes: `npm ci`, the Next.js build, and the
ffmpeg/whisper downloads. After that, launching takes seconds. To update,
re-run the same command.

`./start.sh` launches, `./stop.sh` stops. Logs live at
`~/.config/creagent/server.log` (app) and `worker.log` (jobs).

Starting runs SQL migrations from `db/migrations` and starts the job
worker. Everything lives under `~/.config/creagent` (SQLite file, keys,
models, uploads). The home page shows live Database / Queue / Keys status
from `/api/health`. Copy `.env.example` to `.env.local` to override `PORT`,
`SQLITE_PATH`, or `META_TEXT_MODEL`.

## Develop

```bash
npm install
npm run dev    # http://127.0.0.1:3000
npm run build
npm start
```

The desktop launcher (`start.sh`, default) runs in dev mode: `next dev`
hot-reloads UI/API changes, `tsx watch` restarts the worker on code changes,
and the worker applies new SQL migrations within a minute — no relaunch
needed while iterating. For a production server instead:

```bash
CREAGENT_MODE=prod ./start.sh
```

## Settings and keys

Open **Settings** in the app and save keys for:

| Key            | Used for                                  |
| -------------- | ----------------------------------------- |
| Meta Model API | All writing, reasoning, image generation  |
| Monid          | Content ingest (scraping profiles/posts)  |
| Zernio         | Publishing, scheduling, analytics         |
| Brave Search   | Real-time web context for the agent       |

Keys are AES-256-GCM encrypted at
`~/.config/creagent/keys.enc.json` (mode `0600`). Each key has
a **Test** button: Meta runs a tiny Responses call, Monid reads the workspace
balance, Zernio lists profiles, Brave runs a one-result search.

## Ingest, analysis, Brain

- **Ingest** (Settings): pull posts, videos, and transcripts through Monid
  and Zernio into the `assets` table. Pick platforms as pills, choose a date
  range per source, and ingest with progress, retries, and resume. Runs as a
  background job with cursor pagination.
- **Analysis**: reads unanalyzed assets with `muse-spark-1.3-contributor`,
  writes the voice profile, Q&A, principles, and quotes to the vault, and
  upserts content pillars — with a live progress indicator.
- **Brain**: voice profile, up-to-5 editable content pillars, vault tabs
  (principles, Q&A, quotes, voice), and the platform playbook. Vault
  embeddings are local MiniLM (384-dim, float32 BLOBs in SQLite with JS
  cosine search, model auto-downloads to `~/.config/creagent/models`).

Monid is called over its REST API (`https://api.monid.ai`, Bearer auth) using
request shapes matching `@monid-ai/cli` 0.1.8 — no CLI install needed.

## Queue

The queue is a week/month calendar. Slots are red (needs work), orange
(needs review), green (ready), gray (posted).

- **Queue setup** (modal): cadence templates — weekday + time + pillar +
  content type + platforms — or a daily cadence, or plain-language setup via
  the agent. This is the posting schedule.
- **Plan 14 days**: materializes red slots from templates and rolls overdue
  red/orange slots to their next matching occurrence.
- **Draft all red / Draft now**: Meta writes each draft grounded in vault
  retrieval (top-5 cosine matches) and flips the slot orange for review.
  Media slots draft a separate post-caption block alongside the script or
  carousel outline.
- **Approve** turns orange to green; **Post now / Schedule** publishes via
  Zernio with per-platform receipts; **Mark posted** turns green gray.
  Deleting a slot removes it and its drafts. Jobs stuck `running` past 10
  minutes are reaped and retried (3 attempts).

## Data

- **Dashboard** (`/data`): per-platform averages plus every post with its
  multiplier against the average (2x = twice the usual).
- **Sync metrics** pulls engagement from ingested assets and from Zernio
  (`GET /v1/analytics/delta` with a stored cursor, plus `/v1/posts`).
  Zernio shapes are normalized best-effort — first real sync may need a
  mapping tweak once connected-account data is visible.

## Editors

- **Text**: any draft opens in an edit modal from the slot detail; saving
  marks it edited.
- **Carousel** (`/carousels`, or the Carousel button on any queue slot):
  brand kit with primary/secondary/background colors plus heading and body
  fonts, model-written slide copy grounded in the vault, direct slide editing
  with reorder and count controls, ingested-photo picker (downloads locally),
  uploads, and Muse Image scene generation per slide. Previews and exports
  render on a 1080×1350 canvas to PNGs — no extra dependencies.
- **Video** (`/videos`, or the Video editor button on any video slot):
  magnetic multi-track timeline with ripple trims, word-accurate local
  transcription, editable captions with retiming, vertical safe zones,
  review notes, auto-cut with best-take selection, RAW/CUT toggle, B-roll,
  SFX/music libraries, and 9:16 story illustrations generated per statement
  in the house style. Exports attach to the slot, and approval pins exactly
  which finished file uploads.
- Finished files also upload straight onto any slot (500MB cap).

## Agent imagery

- **Analyze photos** describes every ingested photo with Meta vision and
  stores tags plus an embedding.
- **Auto-pick photos** matches each imageless slide to its closest photo by
  embedding similarity (skips low-confidence matches rather than forcing).
- **Plan images** auto-picks first, then files approval-gated generation
  requests for the rest. Approve on the queue slot or in the editor —
  approval enqueues the real Muse Image job, and nothing spends credits
  without a Yes. Direct Generate stays available for your own prompts.

Verified live: `muse-image-1.0` is on the Model API (confirmed via
`/v1/models`, which also lists `muse-wonder-1.0`, `sam-3.1`, and
`muse-voice-transcribe-1.0`). Generations return portrait WebP (~1152×2016);
saved with sniffed extensions. Monid run payloads arrive on top-level
`output` (not `providerResponse`); chat calls need generous `max_tokens`
because reasoning eats the budget first.

## Meta Model API (verified 2026-10-26)

Confirmed against independent sources (the Google AI summary got the curl URLs
wrong — the correct host is below, not `https://meta.ai`):

- Base URL: `https://api.meta.ai/v1`
- Auth: `Authorization: Bearer $MODEL_API_KEY`
- Text: `POST /v1/responses` with `{"model", "input"}` (OpenAI SDK
  `client.responses.create`, or `/v1/chat/completions`, or Anthropic-style
  `/v1/messages`)
- Models: `muse-spark-1.3-contributor` (default, ~12x cheaper at
  $0.10/$0.20 per 1M — Meta trains on prompts/completions),
  `muse-spark-1.3` (private Standard tier, set `META_TEXT_MODEL` to use it),
  `muse-wonder-1.0` (frontier, agentic, 1M context)
- Health: `GET /v1/status` (no key needed)
- Image: `muse-image-1.0` on `/v1/images/generations`, verified live
  end to end (portrait WebP generations).
- Note: the Responses API has built-in `web_search` grounding — may cover
  real-time context without Brave.

No video generation route exists on the Model API (verified 2026-11-04):
text, image, transcription, and segmentation only. Muse Video is
preview-only inside the muse.ai agent, so video scenes stay image-based
until Meta ships a video endpoint.

## CorridorKey 2.0 notes (video keying)

- Repo: `nikopueringer/CorridorKey2.0` (branch `master`). CLI is clean for a
  sidecar: `infer.py --input --output_dir [--hint_first_frame | --hint_video]`.
- Our Luma-hint UI maps to `--hint_first_frame` (single-channel matte PNG,
  white = subject) or a full `--hint_video`; the launcher also auto-picks
  `<clip>FrameHint.png` / `<clip>_AlphaHint.mp4` companions.
- **Hardware: NVIDIA-only.** Setup needs an RTX 30-series+ with CUDA PyTorch;
  `runtime.py` hardcodes `cuda` (no MPS/MLX/CPU path). It will not run on Apple
  Silicon — plan demo keying on a Linux + NVIDIA box (local or cloud GPU).
- **License: CC BY-NC-SA 4.0 variant.** Processing footage (even commercial)
  is fine and outputs are yours, but you may not sell the tool, charge for
  access, or offer it as a paid API without Corridor Digital's permission.
  Fine for the hackathon demo and local-first open source; email
  contact@corridordigital.com before any SaaS integration.
- Unconfirmed: use without a green/blue screen. The model is screen-keying
  oriented (there is a `--despill_strength` flag), so plan the demo with a
  screen and treat no-screen as a stretch test.

The keyer stays a separate Python sidecar process (no code linking), which
keeps this repo's MIT license clean. `scripts/setup-corridorkey.sh` handles
the install when you're on a supported machine.

## Layout

```text
app/                Next.js App Router (pages + API routes)
components/         Client components (editors, queue, chat, settings)
lib/                Server libs (drafting, publish, video, carousel, ingest…)
db/migrations/      SQL migrations (run by ./start.sh, or npm run migrate)
scripts/            Tool setup (ffmpeg/whisper, CorridorKey) + migrate runner
sidecar/            CorridorKey keying server (separate Python process)
worker.ts           Local job worker (npm run worker)
tests/              node:test suite (npm test)
install.sh          One-command macOS/Linux installer
start.sh / stop.sh  Generated launcher (edit install.sh, not these)
```

## Roadmap

1. Settings + local keys (done)
2. Embedded SQLite + job queue (done — zero daemons)
3. Ingest (Monid/Zernio) → voice profile + vault → editable pillars (done)
4. Queue calendar + drafters + RED/ORANGE/GREEN approvals (done)
5. Data dashboard (done)
6. Text editor modal + upload fallback (done)
7. Carousel editor (done — vision + Muse Image verified live end to end)
8. Video editor (done — timeline, transcription, captions, scenes, export)
9. Real-use hardening + demo polish (in progress)

## License

MIT. See [LICENSE](LICENSE).
