import { createServer as createHttpsServer } from "node:https";
import { NodeHttpServer } from "@effect/platform-node";

/** Shared TLS-only runtime boundary for the preview controller and probe gateway. */
export const previewHttpsServerLayer = (options: {
  readonly certificate: string;
  readonly privateKey: string;
  readonly host: string;
  readonly port: number;
}) =>
  NodeHttpServer.layer(
    () => createHttpsServer({ cert: options.certificate, key: options.privateKey }),
    { host: options.host, port: options.port },
  );
