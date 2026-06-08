import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { scrubbedForwardHeadersFrom } from "./headers";

const makeRequest = (headers: Record<string, string>, remoteAddress = Option.none<string>()) =>
  ({
    headers,
    remoteAddress,
  }) as never;

describe("scrubbedForwardHeadersFrom", () => {
  it("strips caller credentials and internal x-sheet headers before proxying", () => {
    const headers = scrubbedForwardHeadersFrom(
      makeRequest({
        authorization: "Bearer user-token",
        "x-sheet-auth-user-id": "attacker-user",
        "x-sheet-auth-token": "attacker-token",
        "x-sheet-ingress-auth": "attacker-ingress-token",
        "x-sheet-discord-access-token": "attacker-discord-token",
        "x-custom-header": "kept",
        host: "example.test",
      }),
    );

    expect(headers).toEqual({
      "x-custom-header": "kept",
      host: "example.test",
      "x-forwarded-host": "example.test",
      "x-forwarded-proto": "http",
    });
  });

  it("appends the remote address to x-forwarded-for", () => {
    const headers = scrubbedForwardHeadersFrom(
      makeRequest(
        {
          "x-forwarded-for": "203.0.113.1",
          "x-forwarded-host": "ingress.test",
          "x-forwarded-proto": "https",
        },
        Option.some("10.0.0.12"),
      ),
    );

    expect(headers["x-forwarded-for"]).toBe("203.0.113.1, 10.0.0.12");
    expect(headers["x-forwarded-host"]).toBe("ingress.test");
    expect(headers["x-forwarded-proto"]).toBe("https");
  });
});
