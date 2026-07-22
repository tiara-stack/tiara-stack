import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { Meilisearch, MeilisearchApiError } from "meilisearch";
import type { DocsSearchRecord } from "../src/lib/docs/search-records";

const DocsSearchRecordSchema = Schema.Struct({
  component: Schema.String,
  content: Schema.String,
  contentHash: Schema.String,
  description: Schema.optional(Schema.String),
  id: Schema.String,
  section: Schema.String,
  slug: Schema.String,
  title: Schema.String,
});
const ManifestSchema = Schema.Struct({ records: Schema.Array(DocsSearchRecordSchema) });

function argument(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const mode = argument("mode", process.env.DOCS_SEARCH_REINDEX_MODE ?? "incremental");
if (mode !== "incremental" && mode !== "full") {
  throw new Error("Index mode must be incremental or full");
}

const manifestPath = resolve(argument("manifest", ".output/server/docs-search-manifest.json"));
const manifest = Schema.decodeUnknownSync(ManifestSchema)(
  JSON.parse(await readFile(manifestPath, "utf8")),
);
const indexUid = process.env.MEILISEARCH_INDEX_UID ?? "sheet-web-docs";
const client = new Meilisearch({
  host: requiredEnvironment("MEILISEARCH_HOST"),
  apiKey: requiredEnvironment("MEILISEARCH_ADMIN_API_KEY"),
  timeout: 10_000,
});

const settings = {
  searchableAttributes: ["title", "section", "description", "content"],
  filterableAttributes: ["component"],
  displayedAttributes: ["id", "title", "content", "slug", "section", "component", "description"],
};

async function wait(task: Parameters<typeof client.tasks.waitForTask>[0]) {
  const result = await client.tasks.waitForTask(task, { timeout: 60_000, interval: 200 });
  if (result.status !== "succeeded") throw new Error(`Meilisearch task ${result.uid} failed`);
}

async function indexExists(uid: string) {
  try {
    await client.getIndex(uid);
    return true;
  } catch (error) {
    if (error instanceof MeilisearchApiError && error.cause?.code === "index_not_found")
      return false;
    throw error;
  }
}

async function configure(uid: string) {
  if (!(await indexExists(uid))) await wait(await client.createIndex(uid, { primaryKey: "id" }));
  const index = client.index<DocsSearchRecord>(uid);
  await wait(await index.updateSettings(settings));
  return index;
}

async function configureAndPopulate(uid: string) {
  const index = await configure(uid);
  for (let offset = 0; offset < manifest.records.length; offset += 250) {
    await wait(
      await index.addDocuments(manifest.records.slice(offset, offset + 250), {
        primaryKey: "id",
      }),
    );
  }
}

async function incrementalSync() {
  const index = await configure(indexUid);
  const existing: Array<Pick<DocsSearchRecord, "id" | "contentHash">> = [];
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await index.getDocuments<Pick<DocsSearchRecord, "id" | "contentHash">>({
      fields: ["id", "contentHash"],
      limit: pageSize,
      offset,
    });
    existing.push(...page.results);
    if (page.results.length < pageSize) break;
  }
  const desired = new Map(manifest.records.map((record) => [record.id, record]));
  const existingHashes = new Map(existing.map((record) => [record.id, record.contentHash]));
  const changed = manifest.records.filter(
    (record) => existingHashes.get(record.id) !== record.contentHash,
  );
  const stale = existing.filter((record) => !desired.has(record.id)).map((record) => record.id);

  for (let offset = 0; offset < changed.length; offset += 250) {
    await wait(await index.addDocuments(changed.slice(offset, offset + 250), { primaryKey: "id" }));
  }
  if (stale.length > 0) await wait(await index.deleteDocuments(stale));
  console.log(
    `Indexed ${changed.length} changed records and removed ${stale.length} stale records.`,
  );
}

async function fullSync() {
  const temporaryUid = `${indexUid}-build-${Date.now()}`;
  let completed = false;
  try {
    await configureAndPopulate(temporaryUid);
    if (!(await indexExists(indexUid)))
      await wait(await client.createIndex(indexUid, { primaryKey: "id" }));
    await wait(await client.swapIndexes([{ indexes: [indexUid, temporaryUid], rename: false }]));
    await wait(await client.deleteIndex(temporaryUid));
    completed = true;
    console.log(`Atomically replaced ${indexUid} with ${manifest.records.length} records.`);
  } finally {
    if (!completed) {
      try {
        if (await indexExists(temporaryUid)) await wait(await client.deleteIndex(temporaryUid));
      } catch (cleanupError) {
        console.error(`Could not remove temporary index ${temporaryUid}:`, cleanupError);
      }
    }
  }
}

await (mode === "full" ? fullSync() : incrementalSync());
