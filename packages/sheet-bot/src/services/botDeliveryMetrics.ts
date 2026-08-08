import { Metric } from "effect";

export const sheetBotDeliveryUnresolvedReservations = Metric.gauge(
  "sheet_bot_delivery_unresolved_reservations",
  {
    description:
      "Approximate upper bound of sheet-bot Delivery Key reservations from the last completed bounded scan cycle, or the startup cycle observed so far",
  },
);

export const sheetBotDeliveryOldestUnresolvedAgeSeconds = Metric.gauge(
  "sheet_bot_delivery_oldest_unresolved_age_seconds",
  {
    description:
      "Age in seconds of the oldest unresolved sheet-bot delivery reservation from the last completed bounded scan cycle, or the startup cycle observed so far",
  },
);

export const sheetBotDeliveryObservabilitySaturated = Metric.gauge(
  "sheet_bot_delivery_observability_saturated",
  {
    description:
      "Whether the last completed sheet-bot unresolved-delivery scan cycle exceeded its per-refresh inspection limit, or the startup cycle has done so",
  },
);

export const sheetBotDeliveryAmbiguousOutcomes = Metric.counter(
  "sheet_bot_delivery_ambiguous_outcomes_total",
  {
    description: "Sheet-bot provider outcomes retained for explicit operator reconciliation",
    incremental: true,
  },
);

export const sheetBotDeliveryReconciliations = Metric.counter(
  "sheet_bot_delivery_reconciliations_total",
  {
    description: "Sheet-bot Delivery Key Recovery Commands grouped by resolution and result",
    incremental: true,
  },
);
