import { describe, expect, it } from "vitest";
import { makeDocsSearchRecords } from "./search-records";

describe("makeDocsSearchRecords", () => {
  it("creates stable page and heading records", async () => {
    const pages = [
      {
        component: "tiarabot",
        description: "Use TiaraBot during a fill shift.",
        title: "Check in",
        url: "/docs/tiarabot/fillers/check-in",
        structuredData: {
          headings: [{ id: "press-the-button", content: "Press the button" }],
          contents: [
            { heading: undefined, content: "Check your scheduled hour." },
            { heading: "press-the-button", content: "Press Check in once." },
          ],
        },
      },
    ];

    const first = await makeDocsSearchRecords(pages);
    const second = await makeDocsSearchRecords(pages);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[1]).toMatchObject({
      component: "tiarabot",
      section: "Press the button",
      slug: "/docs/tiarabot/fillers/check-in#press-the-button",
    });
  });

  it("updates hashes when displayed metadata changes", async () => {
    const page = {
      component: "tiarabot",
      description: "First description",
      title: "Original title",
      url: "/docs/tiarabot/example",
      structuredData: { headings: [], contents: [{ content: "Same body", heading: undefined }] },
    };
    const [original] = await makeDocsSearchRecords([page]);
    const [renamed] = await makeDocsSearchRecords([{ ...page, title: "Updated title" }]);

    expect(original?.contentHash).not.toBe(renamed?.contentHash);
  });
});
