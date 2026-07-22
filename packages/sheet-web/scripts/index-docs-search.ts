import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import GithubSlugger from "github-slugger";
import matter from "gray-matter";
import { makeDocsSearchRecords } from "../src/lib/docs/search-records";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const output = resolve(argument("output") ?? ".output/server/docs-search-manifest.json");
const contentRoot = resolve("content/docs");

async function findMdxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? findMdxFiles(path)
        : Promise.resolve(extname(entry.name) === ".mdx" ? [path] : []);
    }),
  );
  return files.flat().sort();
}

function plainText(value: string) {
  return value
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll(/[>#*_`~{}|]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

const pages = await Promise.all(
  (await findMdxFiles(contentRoot)).map(async (path) => {
    const { content, data } = matter(await readFile(path, "utf8"));
    const relativePath = relative(contentRoot, path)
      .split(sep)
      .join("/")
      .replace(/\.mdx$/, "");
    const routePath = relativePath.replace(/(^|\/)index$/, "");
    const url = `/docs${routePath ? `/${routePath}` : ""}`;
    const slugger = new GithubSlugger();
    const headings: Array<{ content: string; id: string }> = [];
    const contents: Array<{ content: string; heading: string | undefined }> = [];
    let heading: string | undefined;

    const searchableContent = content.replaceAll(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
    for (const block of searchableContent.split(/\n{2,}/)) {
      const headingMatch = /^(#{2,6})\s+(.+)$/m.exec(block);
      let body = block;
      if (headingMatch) {
        const headingText = plainText(headingMatch[2] ?? "");
        heading = slugger.slug(headingText);
        headings.push({ content: headingText, id: heading });
        body = block.replace(headingMatch[0], "");
      }

      const text = plainText(body);
      if (text && !text.startsWith("import ")) contents.push({ content: text, heading });
    }

    return {
      component: relativePath === "index" ? "docs" : (relativePath.split("/")[0] ?? "docs"),
      description: typeof data.description === "string" ? data.description : undefined,
      structuredData: { headings, contents },
      title: typeof data.title === "string" ? data.title : relativePath,
      url,
    };
  }),
);
const records = await makeDocsSearchRecords(pages);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), records })}\n`);
console.log(`Wrote ${records.length} documentation search records to ${output}`);
