import { clearSession } from "./ipc";

export type SessionClearPhase = "started" | "succeeded" | "failed";

type SessionClearListener = (phase: SessionClearPhase) => void;
type ClearBackend = () => Promise<void>;

const listeners = new Set<SessionClearListener>();

export function onSessionClear(listener: SessionClearListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitSessionClear(phase: SessionClearPhase): void {
  for (const listener of listeners) listener(phase);
}

/**
 * Tags reads with a generation and closes the gate while a session clear is
 * pending. Bumping the generation on both edges rejects requests that started
 * before the clear as well as any timer that fired while the backend was
 * clearing.
 */
export class SessionClearBarrier {
  private generation = 0;
  private clearing = false;

  capture(): number {
    return this.generation;
  }

  accepts(generation: number): boolean {
    return !this.clearing && generation === this.generation;
  }

  beginClear(): void {
    this.generation += 1;
    this.clearing = true;
  }

  finishClear(): void {
    this.generation += 1;
    this.clearing = false;
  }
}

export function createSessionClearCoordinator(
  clearBackend: ClearBackend,
  emit: SessionClearListener
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return () => {
    if (inFlight) return inFlight;

    emit("started");
    inFlight = Promise.resolve()
      .then(clearBackend)
      .then(
        () => emit("succeeded"),
        (error: unknown) => {
          emit("failed");
          throw error;
        }
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export const clearCurrentSession = createSessionClearCoordinator(clearSession, emitSessionClear);
