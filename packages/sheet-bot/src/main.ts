import { NodeFileSystem, NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import { channelCommandLayer } from "./commands/channel";
import { checkinCommandLayer } from "./commands/checkin";
import { kickoutCommandLayer } from "./commands/kickout";
import { roomOrderCommandLayer } from "./commands/roomOrder";
import { oauthClientCommandLayer } from "./commands/oauthClient";
import { scheduleCommandLayer } from "./commands/schedule";
import { screenshotCommandLayer } from "./commands/screenshot";
import { serverCommandLayer } from "./commands/server";
import { slotCommandLayer } from "./commands/slot";
import { statusCommandLayer } from "./commands/status";
import { teamCommandLayer } from "./commands/team";
import { guildWelcomeEventLayer } from "./events/guildWelcome";
import { updateAnnouncementsEventLayer } from "./events/updateAnnouncements";
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
  oauthClientCommandLayer,
  screenshotCommandLayer,
  scheduleCommandLayer,
  serverCommandLayer,
  slotCommandLayer,
  statusCommandLayer,
  teamCommandLayer,
  guildWelcomeEventLayer,
  updateAnnouncementsEventLayer,
  checkinButtonLayer,
  roomOrderButtonLayer,
  slotButtonLayer,
);

const configProviderLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

// fallow-ignore-next-line code-duplication
// fallow-ignore-next-line complexity
const botMainLayer = Layer.mergeAll(botLayer, httpLayer).pipe(
  // fallow-ignore-next-line code-duplication
  Layer.provide(MetricsLive),
  Layer.provide(TracesLive),
  Layer.provide(Logger.layer([Logger.consoleLogFmt])),
  Layer.provide(NodeHttpClient.layerFetch),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(configProviderLayer),
);

NodeRuntime.runMain(Effect.orDie(Layer.launch(botMainLayer)) as Effect.Effect<never, never, never>);
