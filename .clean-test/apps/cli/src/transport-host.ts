import {
  createRuntimeHttpServer,
  type RuntimeHttpServer,
  type RuntimeHttpServerOptions,
} from "@natalia/transport/host";

/** Starts the CLI-owned framework transport and owns its process lifecycle. */
export function createHttpTransportHost(
  options: RuntimeHttpServerOptions,
  createServer: (
    options: RuntimeHttpServerOptions,
  ) => RuntimeHttpServer = createRuntimeHttpServer,
) {
  const server = createServer(options);
  let closed = false;
  return {
    server,
    async close() {
      if (closed) return;
      closed = true;
      await server.stop(true);
    },
  };
}
