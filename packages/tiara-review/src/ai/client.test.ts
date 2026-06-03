import { describe, expect, it } from "vitest";
import { ProviderAiReviewClient } from "./client";

describe("ProviderAiReviewClient", () => {
  it("exposes the structured review entrypoint", () => {
    const client = new ProviderAiReviewClient();

    expect("runStructured" in client).toBe(true);
  });
});
