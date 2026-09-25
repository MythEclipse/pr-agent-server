import { describe, expect, test } from "bun:test";
import { ReviewQueue } from "../src/queue";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ReviewQueue", () => {
  test("dedupes the same repo+pr while a job is in flight", async () => {
    const ran: string[] = [];
    let release: () => void = () => {};
    const q = new ReviewQueue({ run: async (j) => { ran.push(`${j.repo}#${j.pr}`); await new Promise<void>((r) => (release = r)); } });
    expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("queued");
    expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("deduped");
    await tick();
    release();
    await q.drain();
    expect(ran).toEqual(["r#1"]);
  });

  test("re-runs after the job finished (new head may need a review)", async () => {
    const ran: string[] = [];
    const q = new ReviewQueue({ run: async (j) => { ran.push(`${j.repo}#${j.pr}`); } });
    q.enqueue({ owner: "o", repo: "r", pr: 1 });
    await q.drain();
    expect(q.enqueue({ owner: "o", repo: "r", pr: 1 })).toBe("queued");
    await q.drain();
    expect(ran.length).toBe(2);
  });

  test("never exceeds the concurrency cap", async () => {
    let active = 0, peak = 0;
    const q = new ReviewQueue({ concurrency: 2, run: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    }});
    for (let i = 0; i < 6; i++) q.enqueue({ owner: "o", repo: "r", pr: i });
    await q.drain();
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("a failing job does not kill the queue", async () => {
    const ran: number[] = [];
    const q = new ReviewQueue({ run: async (j) => { if (j.pr === 1) throw new Error("boom"); ran.push(j.pr); } });
    q.enqueue({ owner: "o", repo: "r", pr: 1 });
    q.enqueue({ owner: "o", repo: "r", pr: 2 });
    await q.drain();
    expect(ran).toEqual([2]);
  });
});
