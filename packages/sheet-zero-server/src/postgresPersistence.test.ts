import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import postgres from "postgres";
import { vi } from "vitest";
import { makePostgresTrustedSheetPersistenceLayer, TrustedSheetPersistence } from "./persistence";

vi.mock("postgres", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  return { ...actual, default: vi.fn(actual.default) };
});

it.effect("uses pooler-compatible PostgreSQL startup parameters", () =>
  Effect.gen(function* () {
    yield* TrustedSheetPersistence;

    expect(postgres).toHaveBeenCalledTimes(1);
    expect(postgres).toHaveBeenCalledWith("postgresql://test:test@localhost:5432/test", {
      connection: { application_name: "trusted-persistence-test" },
      max: 3,
    });
  }).pipe(
    Effect.provide(
      makePostgresTrustedSheetPersistenceLayer({
        url: Redacted.make("postgresql://test:test@localhost:5432/test"),
        context: {
          principalId: "test",
          visibilityKey: "service:test",
        },
        applicationName: "trusted-persistence-test",
        maxConnections: 3,
        statementTimeoutMillis: 12_345,
      }),
    ),
    Effect.scoped,
  ),
);
