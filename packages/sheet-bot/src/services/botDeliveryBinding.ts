import { Predicate } from "effect";
import type { BotOutboundMessage } from "sheet-bot-api/message";

/**
 * Semantic file binding is opt-in. Existing callers keep strict byte-for-byte input binding;
 * opted-in files bind the stable logical request while allowing safe-retry regeneration.
 */
export const deliveryStoreInput = <A extends { readonly message?: BotOutboundMessage }>(
  payload: A,
): unknown => {
  const files = payload.message?.files;
  if (
    Predicate.isUndefined(files) ||
    files.every(({ deliveryBinding }) => Predicate.isUndefined(deliveryBinding))
  ) {
    return payload;
  }
  return {
    ...payload,
    message: {
      ...payload.message,
      files: files.map(({ content, ...file }) =>
        Predicate.isUndefined(file.deliveryBinding) ? { ...file, content } : file,
      ),
    },
  };
};
