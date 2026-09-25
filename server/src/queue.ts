// In-process review queue: FIFO, dedupes a pull request that is already queued
// or running, and caps how many reviews execute at once so a burst of webhooks
// cannot stampede the LLM. `enqueue` is synchronous — the webhook handler never
// awaits a review. A failing job is logged and the queue keeps going.

export interface ReviewJob {
  owner: string;
  repo: string;
  pr: number;
}

export interface ReviewQueueOptions {
  /** Max reviews running at the same time. Default 1 (serial). */
  concurrency?: number;
  run: (job: ReviewJob) => Promise<void>;
  log?: (m: string) => void;
}

const keyOf = (job: ReviewJob): string => `${job.owner}/${job.repo}#${job.pr}`;

export class ReviewQueue {
  private readonly concurrency: number;
  private readonly run: (job: ReviewJob) => Promise<void>;
  private readonly log: (m: string) => void;
  /** Jobs waiting for a free slot, in arrival order. */
  private readonly pending: ReviewJob[] = [];
  /** Keys of every job queued or running; an entry clears when the job settles. */
  private readonly inFlight = new Set<string>();
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(opts: ReviewQueueOptions) {
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.run = opts.run;
    this.log = opts.log ?? ((m: string) => console.error(m));
  }

  /** Queue a review, or report "deduped" when that PR is already queued/running. */
  enqueue(job: ReviewJob): "queued" | "deduped" {
    const key = keyOf(job);
    if (this.inFlight.has(key)) return "deduped";
    this.inFlight.add(key);
    this.pending.push(job);
    this.pump();
    return "queued";
  }

  /** Jobs waiting for a free slot (excludes the ones currently running). */
  size(): number {
    return this.pending.length;
  }

  /** Resolves once the queue is empty and no job is running. */
  drain(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Fill free slots from the head of the queue. */
  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.running++;
      void this.execute(job);
    }
  }

  private async execute(job: ReviewJob): Promise<void> {
    const key = keyOf(job);
    try {
      await this.run(job);
    } catch (e) {
      this.log(`[queue] review job ${key} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    } finally {
      this.inFlight.delete(key);
      this.running--;
      this.pump();
      if (this.running === 0 && this.pending.length === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }
}
