import { EventEmitter, on } from "node:events";

import { v4 } from "uuid";

/** One event emitted by the demo seed pipeline. `progress` is 0..1; the final event has `progress === 1` and carries the signed `token`. Error terminations close the async iterator with an exception instead of using an error-shaped event. */
export type DemoProgressEvent = {
  step: string;
  progress: number;
  token: string | null;
};

type Job = {
  emitter: EventEmitter;
  buffer: DemoProgressEvent[];
  done: boolean;
  error: Error | null;
};

const JOBS = new Map<string, Job>();
const CLEANUP_MS = 60_000;

/** Allocate a new job id. The caller is responsible for eventually calling `emit` with `progress: 1` (or `fail`) — otherwise subscribers hang until cleanup. */
export function createJob(): string {
  const jobId = v4();
  JOBS.set(jobId, {
    emitter: new EventEmitter(),
    buffer: [],
    done: false,
    error: null,
  });
  return jobId;
}

/** Emit a progress event. The final event (`progress === 1`) flips the job to `done` and signals `"end"` so subscribers exit their loop. */
export function emit(jobId: string, event: DemoProgressEvent): void {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.buffer.push(event);
  job.emitter.emit("progress", event);
  if (event.progress >= 1) {
    job.done = true;
    job.emitter.emit("end");
    scheduleCleanup(jobId);
  }
}

/** Terminate a job with an error. Active subscribers throw, future subscribers throw immediately. */
export function fail(jobId: string, err: Error): void {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.error = err;
  job.done = true;
  job.emitter.emit("error", err);
  job.emitter.emit("end");
  scheduleCleanup(jobId);
}

function scheduleCleanup(jobId: string): void {
  setTimeout(() => JOBS.delete(jobId), CLEANUP_MS).unref?.();
}

/** Stream events for `jobId`: yields buffered events first, then live ones, then exits on `"end"` (or throws if the job failed). Throws if `jobId` is unknown. */
export async function* subscribe(
  jobId: string,
): AsyncIterable<DemoProgressEvent> {
  const job = JOBS.get(jobId);
  if (!job) throw new Error(`Unknown demo job: ${jobId}`);

  for (const event of job.buffer) yield event;
  if (job.error) throw job.error;
  if (job.done) return;

  const controller = new AbortController();
  const endPromise = new Promise<void>((resolve, reject) => {
    const onEnd = () => {
      controller.abort();
      resolve();
    };
    const onError = (err: Error) => {
      controller.abort();
      reject(err);
    };
    job.emitter.once("end", onEnd);
    job.emitter.once("error", onError);
  });
  // Swallow the AbortError thrown by `on(..., { signal })` when we abort —
  // that's the normal exit path, real failures come through `endPromise`.
  endPromise.catch(() => {});

  try {
    for await (const [event] of on(job.emitter, "progress", {
      signal: controller.signal,
    })) {
      yield event as DemoProgressEvent;
      if ((event as DemoProgressEvent).progress >= 1) break;
    }
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "AbortError") throw err;
  }

  await endPromise;
}
