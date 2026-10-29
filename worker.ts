// Local job worker. Polls the embedded SQLite queue, no daemons.
// Usage: npm run worker
import { runAnalysis } from "./lib/analysis";
import { runCarouselCopy } from "./lib/carousel-copy";
import { runCarouselImage } from "./lib/carousel-image";
import { runAutopick, runPlanImages } from "./lib/carousel-plan";
import { runPhotoScan } from "./lib/photo-vision";
import { closeDb } from "./lib/db";
import { runDraftAll, runDraftSlot } from "./lib/drafting";
import { runMigrations } from "./scripts/migrate";
import { isIngestSource, runIngest, runZernioIngest } from "./lib/ingest";
import { metaChatClient, runAgentTurn } from "./lib/agent";
import { runSlotAutoEdit } from "./lib/autoedit";
import { requestKey, runKeyingSetup } from "./lib/corridorkey";
import { runExport } from "./lib/export";
import { runMetricsSync } from "./lib/metrics";
import { runPlanner } from "./lib/planner";
import { runTranscription } from "./lib/transcribe";
import { eligibleCount, runTranscriptBackfill } from "./lib/transcript-backfill";
import {
  claimNext,
  completeJob,
  failJob,
  reapStaleJobs,
  updateProgress,
  type JobRow,
} from "./lib/queue";

async function dispatch(job: JobRow): Promise<unknown> {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (job.name === "ping") {
    return { pong: true, at: new Date().toISOString() };
  }
  if (job.name === "ingest") {
    const { source, value, since, until, maxPages } = data;
    if (typeof source !== "string" || !isIngestSource(source)) {
      throw new Error(`bad ingest source: ${String(source)}`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("ingest input is empty");
    }
    return runIngest(
      source,
      value,
      (assets, pages) => {
        updateProgress(job.id, { assets, pages });
      },
      {
        since: typeof since === "string" ? since : undefined,
        until: typeof until === "string" ? until : undefined,
      },
      typeof maxPages === "number" ? maxPages : undefined,
    );
  }
  if (job.name === "ingest_zernio") {
    const { accountIds, since, until } = data;
    if (!Array.isArray(accountIds) || !accountIds.every((a): a is string => typeof a === "string")) {
      throw new Error("accountIds must be a string array");
    }
    return runZernioIngest(
      accountIds,
      {
        since: typeof since === "string" ? since : undefined,
        until: typeof until === "string" ? until : undefined,
      },
      (assets) => {
        updateProgress(job.id, { assets });
      },
    );
  }
  if (job.name === "analyze") {
    const { limit } = data;
    return runAnalysis(typeof limit === "number" ? limit : undefined);
  }
  if (job.name === "plan") {
    const { days } = data;
    return runPlanner(typeof days === "number" ? days : 14);
  }
  if (job.name === "draft_all") {
    const { limit } = data;
    return runDraftAll(typeof limit === "number" ? limit : 10, (done, total) =>
      updateProgress(job.id, { done, total }),
    );
  }
  if (job.name === "draft_slot") {
    const { slotId } = data;
    if (typeof slotId !== "string" || !slotId) throw new Error("slotId is required");
    await runDraftSlot(slotId);
    return { drafted: 1 };
  }
  if (job.name === "sync_metrics") {
    return runMetricsSync();
  }
  if (job.name === "transcribe_backfill") {
    const { limit } = data;
    const result = await runTranscriptBackfill(
      typeof limit === "number" ? limit : 500,
      (done, total, spent) => updateProgress(job.id, { done, total, spent }),
    );
    const { total: remaining } = eligibleCount();
    return { ...result, failures: result.failures.slice(0, 10), remaining };
  }
  if (job.name === "carousel_copy") {
    const { projectId, numSlides, brief, replace } = data;
    if (typeof projectId !== "string" || !projectId) throw new Error("projectId is required");
    return runCarouselCopy(projectId, {
      numSlides: typeof numSlides === "number" ? numSlides : undefined,
      brief: typeof brief === "string" ? brief : undefined,
      replace: replace === true,
    });
  }
  if (job.name === "carousel_image") {
    const { slideId, prompt, requestId } = data;
    if (typeof slideId !== "string" || !slideId) throw new Error("slideId is required");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
    return runCarouselImage(slideId, prompt, {
      requestId: typeof requestId === "string" ? requestId : undefined,
    });
  }
  if (job.name === "photo_scan") {
    const { limit } = data;
    return runPhotoScan(typeof limit === "number" ? limit : 30);
  }
  if (job.name === "carousel_autopick") {
    const { projectId } = data;
    if (typeof projectId !== "string" || !projectId) throw new Error("projectId is required");
    return runAutopick(projectId);
  }
  if (job.name === "carousel_plan_images") {
    const { projectId } = data;
    if (typeof projectId !== "string" || !projectId) throw new Error("projectId is required");
    return runPlanImages(projectId);
  }
  if (job.name === "transcribe") {
    const { assetId, lang } = data;
    if (typeof assetId !== "string" || !assetId) throw new Error("assetId is required");
    return runTranscription(assetId, typeof lang === "string" ? lang : "en");
  }
  if (job.name === "key_clip") {
    const { clipId, hintPath } = data;
    if (typeof clipId !== "string" || !clipId) throw new Error("clipId is required");
    return requestKey(clipId, typeof hintPath === "string" ? hintPath : undefined);
  }
  if (job.name === "keying_setup") {
    updateProgress(job.id, { stage: "installing" });
    const result = runKeyingSetup();
    updateProgress(job.id, { stage: "ready" });
    return result;
  }
  if (job.name === "agent_turn") {
    const { chatId, message } = data;
    if (typeof chatId !== "string" || !chatId) throw new Error("chatId is required");
    if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
    return runAgentTurn(chatId, message, metaChatClient());
  }
  if (job.name === "video_autoedit") {
    const { slotId } = data;
    if (typeof slotId !== "string" || !slotId) throw new Error("slotId is required");
    updateProgress(job.id, { stage: "cutting" });
    return runSlotAutoEdit(slotId);
  }
  if (job.name === "export_video") {
    const { projectId, burnCaptions } = data;
    if (typeof projectId !== "string" || !projectId) throw new Error("projectId is required");
    return runExport(projectId, {
      burnCaptions: burnCaptions !== false,
      onStage: (stage: string) => updateProgress(job.id, { stage }),
    });
  }
  throw new Error(`unknown job: ${job.name}`);
}

let stopping = false;
let ticks = 0;

async function tick(): Promise<void> {
  if (stopping) return;
  ticks++;
  // Pick up new migrations without a relaunch (hot-reload path).
  if (ticks % 60 === 0) {
    try {
      const applied = runMigrations();
      if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);
    } catch (error) {
      console.log(`migration check failed: ${(error as Error).message}`);
    }
  }
  try {
    const { requeued, failed } = reapStaleJobs();
    if (requeued > 0 || failed > 0) {
      console.log(`reaped stale jobs: ${requeued} requeued, ${failed} failed`);
    }
  } catch (error) {
    console.log(`reaper error: ${(error as Error).message}`);
  }
  let job: JobRow | null;
  try {
    job = claimNext();
  } catch (error) {
    console.log(`queue error: ${(error as Error).message}`);
    return;
  }
  if (!job) return;
  try {
    completeJob(job.id, await dispatch(job));
    console.log(`completed ${job.id} (${job.name})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(job.id, message);
    console.log(`failed ${job.id} (${job.name}): ${message}`);
  }
}

const once = process.argv.includes("--once");

console.log(
  once ? "worker running one tick" : 'worker polling embedded queue (Ctrl-C to stop)',
);
void tick().then(() => {
  if (once) {
    closeDb();
    process.exit(0);
  }
});
const timer = setInterval(() => {
  if (!once) void tick();
}, 1000);

function shutdown(): void {
  stopping = true;
  clearInterval(timer);
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
