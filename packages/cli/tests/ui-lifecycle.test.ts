import { describe, expect, it, vi } from "vitest";
import { installSignalShutdown, type ShutdownSignalSource } from "../src/commands/ui.js";

describe("ui signal shutdown", () => {
  it.each([
    "SIGINT",
    "SIGTERM",
  ] as const)("routes %s through the sidecar close state machine and removes handlers after close", async (signal) => {
    const signals = new FakeSignalSource();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const close = vi.fn(async () => undefined);
    installSignalShutdown(close, closed, signals);

    signals.emit(signal);
    expect(close).toHaveBeenCalledOnce();

    resolveClosed();
    await closed;
    await Promise.resolve();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});

class FakeSignalSource implements ShutdownSignalSource {
  readonly #listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();

  once(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(signal, listeners);
  }

  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of [...(this.#listeners.get(signal) ?? [])]) {
      this.off(signal, listener);
      listener();
    }
  }

  listenerCount(signal: "SIGINT" | "SIGTERM"): number {
    return this.#listeners.get(signal)?.size ?? 0;
  }
}
