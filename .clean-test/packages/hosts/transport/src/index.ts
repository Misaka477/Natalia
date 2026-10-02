/**
 * Consumer-facing transport surface.
 *
 * This is what an externally built UI is allowed to depend on (mainline plan
 * §2.1): the RPC protocol it speaks to a runtime, and the fetch recorder used
 * to pin external HTTP in tests. It deliberately exports no server, no daemon
 * registration and no process spawning — see `./host` for those. Importing the
 * protocol must never give a consumer the ability to host a runtime.
 */
export {
  callRuntimeRPC,
  type RPCRequest,
  type RPCResponse,
} from "./rpc-client";
export {
  createRecordedFetch,
  readCassette,
  type HttpCassette,
  type RecordedFetchMode,
} from "./recorder";
