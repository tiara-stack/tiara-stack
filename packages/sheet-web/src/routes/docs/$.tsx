import { Suspense } from "react";
import { Schema } from "effect";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import browserCollections from "collections/browser";
import { useMDXComponents } from "#/components/docs/mdx";
import { docsLayoutOptions } from "#/lib/docs/layout";
import { docsSource } from "#/lib/docs/source";

const SlugsSchema = Schema.Array(Schema.String);

export const Route = createFileRoute("/docs/$")({
  component: DocsRoute,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/").filter(Boolean) ?? [];
    const data = await loadDocsPage({ data: slugs });
    await docsClientLoader.preload(data.path);
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.title} · TiaraDocs` },
          { name: "description", content: loaderData.description },
        ]
      : [],
  }),
});

const loadDocsPage = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => Array.from(Schema.decodeUnknownSync(SlugsSchema)(input)))
  .handler(async ({ data: slugs }) => {
    const page = docsSource.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description ?? "Public TiaraBot documentation.",
      pageTree: await docsSource.serializePageTree(docsSource.getPageTree()),
    };
  });

const docsClientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function DocsRoute() {
  const data = useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout {...docsLayoutOptions()} tree={data.pageTree}>
      <Suspense>{docsClientLoader.useContent(data.path)}</Suspense>
    </DocsLayout>
  );
}
