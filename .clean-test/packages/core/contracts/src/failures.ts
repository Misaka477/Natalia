/**
 * How a call fails, said in a way a program can act on.
 *
 * Every remote failure used to arrive as JSON-RPC `-32602` with a string, so a
 * consumer could not tell apart five situations that call for five different
 * reactions:
 *
 *   - the method does not exist        -> report a bug, or fall back
 *   - this runtime does not do it      -> hide the feature entirely
 *   - the parameters are wrong         -> fix the call
 *   - policy or state says no          -> tell the user, maybe retry later
 *   - something broke                  -> retry or escalate
 *
 * The codes below are the JSON-RPC ones plus two from the implementation-defined
 * server range; nothing is invented where the spec already has a word for it.
 *
 * Failures travel in two directions and this module serves both:
 *
 *   - **producers** (a runtime, a registry, the dispatcher) throw one of the
 *     typed failures so the transport can classify without guessing from message
 *     text. Guessing from text is what this module exists to abolish.
 *   - **consumers** catch `RuntimeRPCError` and switch on `failureKind()`.
 *
 * A refusal that is an *ordinary outcome* should not be here at all: it belongs
 * in the return value, so a caller cannot confuse it with a broken connection.
 * `reloadConfig(): {applied, reason?}` is the reference case. Use `RuntimeRefusal`
 * only where the operation has no value to answer with.
 */

/**
 * `-32000` and `-32001` sit in the JSON-RPC implementation-defined server range;
 * the rest are the spec's own.
 */
export const RUNTIME_RPC_ERROR_CODES = {
  /** The envelope is not a request. */
  invalidRequest: -32600,
  /** No route by that name. */
  methodNotFound: -32601,
  /** The route exists and the arguments are wrong. Only that. */
  invalidParams: -32602,
  /** The route exists; this runtime does not implement the member behind it. */
  notSupported: -32000,
  /** Policy or current state says no. Carries a reason. */
  refused: -32001,
  /** Anything else. Carries no detail — see `RuntimeFailureData`. */
  internal: -32603,
} as const;

export type RuntimeFailureKind = keyof typeof RUNTIME_RPC_ERROR_CODES;

const KIND_BY_CODE = new Map<number, RuntimeFailureKind>(
  (Object.keys(RUNTIME_RPC_ERROR_CODES) as RuntimeFailureKind[]).map((kind) => [
    RUNTIME_RPC_ERROR_CODES[kind],
    kind,
  ]),
);

/**
 * The machine-readable half of an error. `message` is for humans and may be
 * redacted; this is what a consumer branches on.
 */
export type RuntimeFailureData =
  | { kind: "invalidRequest" }
  | { kind: "methodNotFound"; method: string }
  | { kind: "invalidParams" }
  /**
   * `member` and `capability` are here so a consumer can switch off a whole
   * group at once instead of learning member by member that nothing works.
   */
  | { kind: "notSupported"; member: string; capability?: string }
  | { kind: "refused"; reason: string }
  /**
   * No detail: an internal failure's message can carry a path, a command line or
   * a secret. `errorID` correlates with a durable diagnostic, so the detail is
   * still reachable through `diagnostics.list` by someone already authorized to
   * read diagnostics.
   */
  | { kind: "internal"; errorID: string };

/** Marker used instead of `instanceof`, which does not survive a worker hop. */
const FAILURE_MARKER = "nataliaRuntimeFailure";

type MarkedFailure = Error & {
  [FAILURE_MARKER]: RuntimeFailureData;
};

function mark<T extends Error>(error: T, data: RuntimeFailureData): T {
  Object.defineProperty(error, FAILURE_MARKER, {
    value: data,
    enumerable: false,
  });
  return error;
}

/**
 * Reads the failure classification off an error, or `undefined` when the error
 * carries none. An unclassified error is deliberately *not* guessed at: it is
 * treated as internal, because inferring policy from prose is the failure mode
 * this module replaces.
 */
export function runtimeFailureData(
  value: unknown,
): RuntimeFailureData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as Partial<MarkedFailure>)[FAILURE_MARKER];
  return data && typeof data === "object" ? data : undefined;
}

/**
 * Policy or state says no, and the operation has no return value able to say it.
 * Prefer a value; see this module's header.
 */
export class RuntimeRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RuntimeRefusal";
    mark(this, { kind: "refused", reason });
  }
}

/**
 * This runtime does not implement the member, even though the route exists and
 * the type says the member is optional. Thrown by a runtime whose optional
 * dependency is absent — a terminal host that was never configured, for
 * instance — so the consumer hides the feature instead of retrying.
 */
export class RuntimeNotSupported extends Error {
  constructor(member: string, capability?: string) {
    super(`this runtime does not support ${member}`);
    this.name = "RuntimeNotSupported";
    mark(this, { kind: "notSupported", member, capability });
  }
}

/** The caller's arguments are wrong. Its message describes only the input. */
export class RuntimeInvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeInvalidParams";
    mark(this, { kind: "invalidParams" });
  }
}

/**
 * No route by that name. Distinct from `RuntimeNotSupported`, which means the
 * route exists: one says "you and I disagree about the protocol", the other says
 * "this deployment cannot do that".
 */
export class RuntimeMethodNotFound extends Error {
  constructor(method: string) {
    super(`unknown method: ${method}`);
    this.name = "RuntimeMethodNotFound";
    mark(this, { kind: "methodNotFound", method });
  }
}

/** The envelope was not a request object at all. */
export class RuntimeInvalidRequest extends Error {
  constructor() {
    super("Invalid Request");
    this.name = "RuntimeInvalidRequest";
    mark(this, { kind: "invalidRequest" });
  }
}

/** Consumer-side view of a failed call: a code, a kind, and structured data. */
export class RuntimeRPCError extends Error {
  readonly code: number;
  readonly method?: string;
  readonly data?: RuntimeFailureData;
  constructor(input: {
    code: number;
    message: string;
    method?: string;
    data?: RuntimeFailureData;
  }) {
    super(input.message);
    this.name = "RuntimeRPCError";
    this.code = input.code;
    this.method = input.method;
    this.data = input.data;
  }
}

/**
 * What kind of failure this is, for a consumer that caught something. Returns
 * `undefined` for errors that never crossed the protocol (a fetch failure, an
 * abort), which a consumer must handle as a transport problem rather than an
 * answer from the runtime.
 */
export function failureKind(value: unknown): RuntimeFailureKind | undefined {
  if (value instanceof RuntimeRPCError)
    return KIND_BY_CODE.get(value.code) ?? undefined;
  return runtimeFailureData(value)?.kind;
}

/** The failure kind a code stands for, or `undefined` for a code we do not use. */
export function failureKindOfCode(
  code: number,
): RuntimeFailureKind | undefined {
  return KIND_BY_CODE.get(code);
}

/**
 * The SDK understands API version N, and the runtime speaks a newer one. The
 * SDK refuses to guess: a changed protocol read with old assumptions is the
 * silent-breakage class this error exists to make loud. Both versions are on
 * the error so a consumer can decide (upgrade the SDK, or accept the gap).
 */
export class RuntimeVersionMismatchError extends Error {
  readonly serverVersion: number;
  readonly supportedVersion: number;
  constructor(input: { serverVersion: number; supportedVersion: number }) {
    super(
      `runtime API version ${input.serverVersion} is newer than this SDK supports (${input.supportedVersion})`,
    );
    this.name = "RuntimeVersionMismatchError";
    this.serverVersion = input.serverVersion;
    this.supportedVersion = input.supportedVersion;
  }
}
