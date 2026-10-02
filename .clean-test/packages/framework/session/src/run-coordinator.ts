export type SessionDrain = (signal: AbortSignal) => Promise<void>;

/**
 * Per-session execution coordinator separates durable admission from execution wakeups.
 * `run` joins the current drain, while repeated `wake` calls schedule at most
 * one follow-up drain after work admitted during the active drain.
 */
export class SessionRunCoordinator {
  private current: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private pendingWake = false;
  private stopping = false;
  private drain: SessionDrain | undefined;

  get active() {
    return this.current !== undefined;
  }

  async run(drain: SessionDrain): Promise<void> {
    this.drain = drain;
    if (!this.current) return await this.start();
    await this.current.catch(() => undefined);
    if (this.stopping) return await this.run(drain);
    await this.idle();
  }

  async wake(drain: SessionDrain) {
    this.drain = drain;
    if (this.current) {
      this.pendingWake = true;
      return;
    }
    void this.start();
  }

  async interrupt() {
    if (!this.current || !this.controller) return;
    this.stopping = true;
    this.pendingWake = false;
    this.controller.abort(new Error("session execution interrupted"));
    await this.current.catch(() => undefined);
    this.stopping = false;
    if (!this.pendingWake) return;
    this.pendingWake = false;
    void this.start();
  }

  async idle() {
    while (this.current) await this.current.catch(() => undefined);
  }

  private async start(): Promise<void> {
    const drain = this.drain;
    if (!drain || this.current) return;
    const controller = new AbortController();
    this.controller = controller;
    let current!: Promise<void>;
    current = (async () => {
      try {
        await drain(controller.signal);
      } finally {
        if (this.current !== current) return;
        this.current = undefined;
        this.controller = undefined;
        if (this.stopping || !this.pendingWake) return;
        this.pendingWake = false;
        void this.start();
      }
    })();
    this.current = current;
    await current;
  }
}

const coordinators = new Map<string, SessionRunCoordinator>();

/** Returns the process-local execution owner for a durable session ID. */
export function sessionRunCoordinator(sessionID: string) {
  let coordinator = coordinators.get(sessionID);
  if (!coordinator) {
    coordinator = new SessionRunCoordinator();
    coordinators.set(sessionID, coordinator);
  }
  return coordinator;
}

export function releaseSessionRunCoordinator(sessionID: string) {
  const coordinator = coordinators.get(sessionID);
  if (coordinator?.active) return false;
  return coordinators.delete(sessionID);
}
