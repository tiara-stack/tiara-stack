import { useMemo } from "react";
import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { SharedProps } from "fumadocs-ui/components/dialog/search";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
} from "fumadocs-ui/components/dialog/search";
import type { SearchClient } from "fumadocs-core/search/client";
import { useDocsSearch } from "fumadocs-core/search/client";
import type { SortedResult } from "fumadocs-core/search";

const SearchResponseSchema = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      breadcrumbs: Schema.optional(Schema.Array(Schema.String)),
      content: Schema.String,
      id: Schema.String,
      type: Schema.Literals(["page", "heading", "text"]),
      url: Schema.String,
    }),
  ),
});

const meilisearchClient: SearchClient = {
  async search(query) {
    return Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* HttpClientRequest.post("/api/docs/search").pipe(
        HttpClientRequest.bodyJsonUnsafe({ query }),
        httpClient.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      );
      const payload = yield* HttpClientResponse.schemaBodyJson(SearchResponseSchema)(response);
      return payload.results.map((result): SortedResult => {
        const { breadcrumbs, ...searchResult } = result;
        return {
          ...searchResult,
          ...(breadcrumbs ? { breadcrumbs: [...breadcrumbs] } : {}),
        };
      });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.runPromise);
  },
};

export function MeilisearchSearchDialog({ open, onOpenChange }: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({
    client: meilisearchClient,
    delayMs: 150,
  });
  const items = useMemo(() => (query.data === "empty" ? [] : query.data), [query.data]);

  return (
    <SearchDialog
      open={open}
      onOpenChange={onOpenChange}
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput placeholder="Search TiaraBot tasks and commands" />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          items={items}
          Empty={() => (
            <div className="px-6 py-12 text-center text-sm text-fd-muted-foreground">
              {query.error
                ? "Search is unavailable. You can still browse by role in the sidebar."
                : "No matching TiaraBot guidance found."}
            </div>
          )}
        />
      </SearchDialogContent>
    </SearchDialog>
  );
}
