import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Layer, Logger } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { channelCommandLayer } from "./commands/channel";
import { checkinCommandLayer } from "./commands/checkin";
import { kickoutCommandLayer } from "./commands/kickout";
import { roomOrderCommandLayer } from "./commands/roomOrder";
import { scheduleCommandLayer } from "./commands/schedule";
import { screenshotCommandLayer } from "./commands/screenshot";
import { serverCommandLayer } from "./commands/server";
import { slotCommandLayer } from "./commands/slot";
import { teamCommandLayer } from "./commands/team";
import { httpLayer } from "./http";
import { checkinButtonLayer } from "./messageComponents/buttons/checkin";
import { roomOrderButtonLayer } from "./messageComponents/buttons/roomOrder";
import { slotButtonLayer } from "./messageComponents/buttons/slot";
import { MetricsLive } from "./metrics";
import { TracesLive } from "./traces";

const botLayer = Layer.mergeAll(
  channelCommandLayer,
  checkinCommandLayer,
  kickoutCommandLayer,
  roomOrderCommandLayer,
  screenshotCommandLayer,
  scheduleCommandLayer,
  serverCommandLayer,
  slotCommandLayer,
  teamCommandLayer,
  checkinButtonLayer,
  roomOrderButtonLayer,
  slotButtonLayer,
);

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

Layer.mergeAll(botLayer, httpLayer).pipe(
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(configProviderLayer),
  Layer.launch,
  NodeRuntime.runMain(),
);
