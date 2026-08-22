import { describe, expect, it, vi } from "vitest";

import {
  SessionClearBarrier,
  createSessionClearCoordinator,
  type SessionClearPhase,
} from "./sessionBus";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("session clear coordination", () => {
  it("emits started immediately and succeeded only after the backend clears", async () => {
    const backend = deferred<void>();
    const clearBackend = vi.fn(() => backend.promise);
    const phases: SessionClearPhase[] = [];
    const clear = createSessionClearCoordinator(clearBackend, (phase) => phases.push(phase));

    const result = clear();

    expect(phases).toEqual(["started"]);
    await Promise.resolve();
    expect(clearBackend).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["started"]);

    backend.resolve();
    await result;

    expect(phases).toEqual(["started", "succeeded"]);
  });

  it("emits failed and rejects when the backend clear fails", async () => {
    const backend = deferred<void>();
    const error = new Error("clear failed");
    const phases: SessionClearPhase[] = [];
    const barrier = new SessionClearBarrier();
    const backendRows = ["existing-row"];
    let visibleRows = [...backendRows];
    const clear = createSessionClearCoordinator(
      () => backend.promise,
      (phase) => {
        phases.push(phase);
        if (phase === "started") {
          barrier.beginClear();
          visibleRows = [];
          return;
        }
        barrier.finishClear();
        const recoveryGeneration = barrier.capture();
        if (barrier.accepts(recoveryGeneration)) visibleRows = [...backendRows];
      }
    );

    const result = clear();
    expect(visibleRows).toEqual([]);
    backend.reject(error);

    await expect(result).rejects.toBe(error);
    expect(phases).toEqual(["started", "failed"]);
    expect(visibleRows).toEqual(backendRows);
  });

  it("shares one in-flight backend clear across repeated calls", async () => {
    const backend = deferred<void>();
    const clearBackend = vi.fn(() => backend.promise);
    const phases: SessionClearPhase[] = [];
    const clear = createSessionClearCoordinator(clearBackend, (phase) => phases.push(phase));

    const first = clear();
    const second = clear();

    expect(second).toBe(first);
    expect(phases).toEqual(["started"]);
    await Promise.resolve();
    expect(clearBackend).toHaveBeenCalledTimes(1);

    backend.resolve();
    await first;
    expect(phases).toEqual(["started", "succeeded"]);
  });
});

describe("SessionClearBarrier", () => {
  it("rejects reads from before and during clear, then accepts the new generation", () => {
    const barrier = new SessionClearBarrier();
    const beforeClear = barrier.capture();

    expect(barrier.accepts(beforeClear)).toBe(true);

    barrier.beginClear();
    const duringClear = barrier.capture();

    expect(barrier.accepts(beforeClear)).toBe(false);
    expect(barrier.accepts(duringClear)).toBe(false);

    barrier.finishClear();
    const afterClear = barrier.capture();

    expect(barrier.accepts(beforeClear)).toBe(false);
    expect(barrier.accepts(duringClear)).toBe(false);
    expect(barrier.accepts(afterClear)).toBe(true);
  });

  it("drops a delayed 100,001-row pre-clear snapshot", async () => {
    const barrier = new SessionClearBarrier();
    const preClearGeneration = barrier.capture();
    const preClearRows = Array.from({ length: 100_001 }, (_, index) => ({
      id: index + 1,
      session: "pre-clear",
    }));
    const delayedSnapshot = deferred<typeof preClearRows>();
    let committed: typeof preClearRows = [];
    const commit = (generation: number, rows: typeof preClearRows) => {
      if (barrier.accepts(generation)) committed = rows;
    };
    const inFlightRead = delayedSnapshot.promise.then((rows) => commit(preClearGeneration, rows));

    barrier.beginClear();
    barrier.finishClear();
    delayedSnapshot.resolve(preClearRows);
    await inFlightRead;

    const postClearGeneration = barrier.capture();
    const postClearRows = [{ id: 100_002, session: "post-clear" }];
    commit(postClearGeneration, postClearRows);

    expect(committed).toEqual(postClearRows);
    expect(committed.some((row) => row.session === "pre-clear")).toBe(false);
  });
});
