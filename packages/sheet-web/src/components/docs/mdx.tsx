import type { MDXComponents } from "mdx/types";
import defaultMdxComponents from "fumadocs-ui/mdx";
import {
  AutoCheckinSummaryExample,
  CheckinAnnouncementExample,
  CheckinButtonResultExample,
  CheckinPromptExample,
  CheckedInPromptExample,
  DiscordMessage,
  FillerReminderExample,
  ManualCheckinResultExample,
  MonitorPingExample,
  PublishedRoomOrderExample,
  RoomOrderDraftExample,
  RoomOrderSendResultExample,
  TentativeRoomOrderExample,
  TentativeRoomOrderPinResultExample,
} from "./discord";

function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    AutoCheckinSummaryExample,
    CheckinAnnouncementExample,
    CheckinButtonResultExample,
    CheckinPromptExample,
    CheckedInPromptExample,
    DiscordMessage,
    FillerReminderExample,
    ManualCheckinResultExample,
    MonitorPingExample,
    PublishedRoomOrderExample,
    RoomOrderDraftExample,
    RoomOrderSendResultExample,
    TentativeRoomOrderExample,
    TentativeRoomOrderPinResultExample,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
