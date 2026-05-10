import { NodeStdio } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";
import { migrate, sqliteLayer } from "../db/client";
import { graphToolkitLayer } from "./toolkit";
import { GraphToolkit } from "./tools";

export const dependencyGraphMcpServerLayer = (input: {
  readonly dbPath: string;
  readonly versionId: string;
}) =>
  McpServer.layerStdio({
    name: "tiara-review-graph",
    version: "0.0.0",
  }).pipe(
    Layer.provide(McpServer.toolkit(GraphToolkit)),
    Layer.provide(graphToolkitLayer({ versionId: input.versionId })),
    Layer.provide(sqliteLayer(input.dbPath)),
    Layer.provide(NodeStdio.layer),
  );

export const runDependencyGraphMcpServer = (input: {
  readonly dbPath: string;
  readonly versionId: string;
}) =>
  Effect.gen(function* () {
    yield* migrate(input.dbPath);
    yield* Layer.launch(dependencyGraphMcpServerLayer(input));
  }).pipe(Effect.provide(sqliteLayer(input.dbPath)));
