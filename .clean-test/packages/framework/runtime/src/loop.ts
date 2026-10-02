import type { RuntimeEvent } from "@anthelia/contracts";

export type HeadlessRuntimeOptions = {
  maxStepsPerTurn?: number;
  requestTimeoutSec?: number;
};

export class HeadlessRuntime {
  readonly maxStepsPerTurn: number;
  readonly requestTimeoutSec: number;
  private listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(options: HeadlessRuntimeOptions = {}) {
    this.maxStepsPerTurn = options.maxStepsPerTurn ?? Number.POSITIVE_INFINITY;
    this.requestTimeoutSec = options.requestTimeoutSec ?? 120;
  }

  onEvent(listener: (event: RuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
