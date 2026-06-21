import { Effect } from "effect";
import { Activity } from "effect/unstable/workflow";
import { AutoCheckinService } from "@/services";
import {
  AutoCheckinConversationResult,
  AutoCheckinConversationWorkflow,
} from "./autoCheckinContract";

export const autoCheckinWorkflowLayer = AutoCheckinConversationWorkflow.toLayer(
  Effect.fn("AutoCheckinConversationWorkflow.handler")(function* (payload, executionId) {
    const service = yield* AutoCheckinService;
    const attributes = {
      executionId,
      workspaceId: payload.workspaceId,
      conversationName: payload.conversationName,
      hour: payload.hour,
    };
    yield* Effect.annotateCurrentSpan(attributes);
    return yield* Activity.make({
      name: `autoCheckin.conversation.${executionId}.execute`,
      success: AutoCheckinConversationResult,
      error: AutoCheckinConversationWorkflow.errorSchema,
      execute: service
        .processConversation(payload)
        .pipe(Effect.withSpan("AutoCheckinConversationWorkflow.execute", { attributes })),
    }).pipe(
      Effect.annotateLogs(attributes),
      Effect.withSpan("AutoCheckinConversationWorkflow.handler", { attributes }),
    );
  }),
);
