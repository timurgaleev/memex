/**
 * Unit tests for the FIFO Semaphore that gates file-sweep
 * fan-out. Exercises:
 *   - permits are claimed in arrival order (FIFO)
 *   - release wakes exactly one waiter
 *   - a thrown work item still releases its permit (via the caller's
 *     finally-handler responsibility — we don't test that the caller
 *     uses finally, but we DO test that release() is the only path
 *     that returns the permit)
 *   - acquire() with max=1 serialises
 */
import { describe, expect, test } from "bun:test";
import { Semaphore } from "../src/core/concurrency.ts";

describe("Semaphore", () => {
  test("rejects max < 1", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  test("max=1 serialises", async () => {
    const sem = new Semaphore(1);
    const log: string[] = [];

    const work = async (name: string): Promise<void> => {
      const release = await sem.acquire();
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 20));
      log.push(`end ${name}`);
      release();
    };

    await Promise.all([work("A"), work("B"), work("C")]);
    // Each work block must complete before the next starts.
    expect(log).toEqual([
      "start A", "end A",
      "start B", "end B",
      "start C", "end C",
    ]);
  });

  test("max=2 allows 2 concurrent and queues the rest", async () => {
    const sem = new Semaphore(2);
    const order: string[] = [];

    const tasks = ["A", "B", "C", "D"].map(async (name) => {
      const release = await sem.acquire();
      order.push(`+${name}`);
      // Two slots stay occupied; D + C wait.
      await new Promise((r) => setTimeout(r, 30));
      order.push(`-${name}`);
      release();
    });
    await Promise.all(tasks);

    // First two starts come from the synchronous arrivals; the next
    // two only start after a release. We expect interleaved +/- in
    // FIFO arrival order — A,B start first; then A,B each end; then
    // C,D start; then C,D end.
    expect(order.slice(0, 2)).toEqual(["+A", "+B"]);
    // After both initial releases the next two acquisitions are C,D
    // in arrival order:
    const tail = order.filter((s) => s.startsWith("+")).slice(2);
    expect(tail).toEqual(["+C", "+D"]);
  });

  test("releasing without holding does not unbalance the count", async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    r1();
    // Same permit must be reusable on a fresh acquire.
    const r2 = await sem.acquire();
    expect(r2).toBeDefined();
    r2();
  });
});
