import { createFileRoute } from "@tanstack/react-router";
import { Schema } from "effect";
import type { SortedResult } from "fumadocs-core/search";

const SearchRequestSchema = Schema.Struct({ query: Schema.optional(Schema.String) });
const SearchHitSchema = Schema.Struct({
  component: Schema.String,
  content: Schema.String,
  id: Schema.String,
  section: Schema.String,
  slug: Schema.String,
  title: Schema.String,
});
type SearchHit = typeof SearchHitSchema.Type;

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

async function readCappedBody(request: Request, maximumBytes: number) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return body + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      return undefined;
    }
    body += decoder.decode(value, { stream: true });
  }
}

export const Route = createFileRoute("/api/docs/search")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (contentLength > 2_048) {
          return Response.json(
            { error: "Search request is too large." },
            { headers: jsonHeaders, status: 413 },
          );
        }

        const requestBody = await readCappedBody(request, 2_048);
        if (requestBody === undefined) {
          return Response.json(
            { error: "Search request is too large." },
            { headers: jsonHeaders, status: 413 },
          );
        }

        let body: typeof SearchRequestSchema.Type;
        try {
          body = Schema.decodeUnknownSync(SearchRequestSchema)(JSON.parse(requestBody));
        } catch {
          return Response.json(
            { error: "Invalid JSON request." },
            { headers: jsonHeaders, status: 400 },
          );
        }

        const query = body.query?.trim() ?? "";
        if (query.length === 0) return Response.json({ results: [] }, { headers: jsonHeaders });
        if (query.length > 120) {
          return Response.json(
            { error: "Search query is too long." },
            { headers: jsonHeaders, status: 400 },
          );
        }

        const host = process.env.MEILISEARCH_HOST;
        const apiKey = process.env.MEILISEARCH_SEARCH_API_KEY;
        const indexUid = process.env.MEILISEARCH_INDEX_UID ?? "sheet-web-docs";
        if (!host || !apiKey) {
          return Response.json(
            { error: "Documentation search is not configured." },
            { headers: jsonHeaders, status: 503 },
          );
        }

        try {
          const { Meilisearch } = await import("meilisearch");
          const client = new Meilisearch({ host, apiKey, timeout: 3_000 });
          const response = await client.index<SearchHit>(indexUid).search(query, {
            limit: 12,
            attributesToRetrieve: ["id", "title", "content", "slug", "section", "component"],
            attributesToCrop: ["content"],
            cropLength: 24,
          });
          const hits = Schema.decodeUnknownSync(Schema.Array(SearchHitSchema))(response.hits);
          const results: SortedResult[] = hits.map((hit) => {
            const content = hit.section || hit.content || hit.title;
            return {
              id: hit.id,
              url: hit.slug,
              type: hit.section ? "heading" : "page",
              content,
              breadcrumbs: ["TiaraBot", ...(hit.section ? [hit.title] : [])],
            };
          });

          return Response.json({ results }, { headers: jsonHeaders });
        } catch {
          return Response.json(
            { error: "Documentation search is temporarily unavailable." },
            { headers: jsonHeaders, status: 502 },
          );
        }
      },
    },
  },
});
