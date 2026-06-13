import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";
import { sessionToken } from ".";

describe("sessionToken", () => {
  it("does not replace responses when there is no session cookie", async () => {
    const auth = betterAuth({
      baseURL: "https://auth.example.com",
      basePath: "/",
      plugins: [sessionToken()],
    });

    const response = await auth.handler(new Request("https://auth.example.com/ok"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
