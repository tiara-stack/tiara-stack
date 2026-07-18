import type { StructuredData } from "fumadocs-core/mdx-plugins";

export interface DocsSearchPage {
  component: string;
  description?: string | undefined;
  structuredData: StructuredData;
  title: string;
  url: string;
}

export interface DocsSearchRecord {
  component: string;
  content: string;
  contentHash: string;
  description?: string | undefined;
  id: string;
  section: string;
  slug: string;
  title: string;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeContent(parts: string[]) {
  return parts
    .map((part) => part.replaceAll(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// fallow-ignore-next-line complexity
export async function makeDocsSearchRecords(pages: DocsSearchPage[]) {
  const records: DocsSearchRecord[] = [];

  for (const page of pages) {
    const headingNames = new Map(
      page.structuredData.headings.map((heading) => [heading.id, heading.content] as const),
    );
    const groupedContent = new Map<string | undefined, string[]>();

    for (const item of page.structuredData.contents) {
      const group = groupedContent.get(item.heading) ?? [];
      group.push(item.content);
      groupedContent.set(item.heading, group);
    }

    const pageContent = normalizeContent([
      page.description ?? "",
      ...(groupedContent.get(undefined) ?? []),
    ]);
    const pageId = await sha256(`${page.component}|${page.url}|page`);
    const pagePayload = {
      title: page.title,
      ...(page.description === undefined ? {} : { description: page.description }),
      content: pageContent,
      slug: page.url,
      section: "",
      component: page.component,
    };
    records.push({
      id: pageId,
      ...pagePayload,
      contentHash: await sha256(JSON.stringify(pagePayload)),
    });

    for (const heading of page.structuredData.headings) {
      const sectionContent = normalizeContent(groupedContent.get(heading.id) ?? []);
      if (!sectionContent) continue;

      const slug = `${page.url}#${heading.id}`;
      const section = headingNames.get(heading.id) ?? heading.content;
      const sectionPayload = {
        title: page.title,
        ...(page.description === undefined ? {} : { description: page.description }),
        content: sectionContent,
        slug,
        section,
        component: page.component,
      };
      records.push({
        id: await sha256(`${page.component}|${slug}|heading`),
        ...sectionPayload,
        contentHash: await sha256(JSON.stringify(sectionPayload)),
      });
    }
  }

  return records.sort((left, right) => left.slug.localeCompare(right.slug));
}
