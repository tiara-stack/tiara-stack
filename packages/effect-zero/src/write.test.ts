import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Project } from "ts-morph";
import { pg } from "effect-sql-schema";
import { many, schema } from "./index";
import { getGeneratedSchema } from "./write";

class User extends pg.Class<User>("User")({
  table: "users",
  fields: {
    id: pg.uuid().primaryKey().defaultRandom(),
    name: pg.text().notNull(),
  },
}) {}

class Post extends pg.Class<Post>("Post")({
  table: "posts",
  fields: {
    id: pg.uuid().primaryKey().defaultRandom(),
    authorId: pg.uuid("author_id").notNull(),
  },
}) {}

describe("generated schema", () => {
  it("emits schema, builder, relationships, and config-based column types", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "effect-zero-generated-"));
    try {
      await writeFile(
        path.join(dir, "effect-zero.config.ts"),
        [
          'import { pg } from "effect-sql-schema";',
          'import { many, schema } from "effect-zero";',
          'class User extends pg.Class<User>("User")({ table: "users", fields: { id: pg.uuid().primaryKey().defaultRandom(), name: pg.text().notNull() } }) {}',
          'class Post extends pg.Class<Post>("Post")({ table: "posts", fields: { id: pg.uuid().primaryKey().defaultRandom(), authorId: pg.uuid("author_id").notNull() } }) {}',
          'export default schema({ users: User, posts: Post }, { relationships: { users: { posts: many(Post, { source: ["id"], dest: ["authorId"] }) } } });',
        ].join("\n"),
      );

      const project = new Project({
        compilerOptions: {
          module: 99,
          moduleResolution: 99,
          target: 9,
        },
        skipAddingFilesFromTsConfig: true,
      });

      const zeroSchema = schema(
        {
          users: User,
          posts: Post,
        },
        {
          relationships: {
            users: {
              posts: many(Post, {
                source: ["id"],
                dest: ["authorId"],
              }),
            },
          },
        },
      );

      const generated = getGeneratedSchema({
        tsProject: project,
        zeroSchema,
        outputFilePath: path.join(dir, "zero-schema.gen.ts"),
        configImport: {
          exportName: "default",
          configFilePath: path.join(dir, "effect-zero.config.ts"),
        },
      });

      expect(generated).toContain('from "./effect-zero.config.js"');
      expect(generated).toContain("customType: null as unknown as string");
      expect(generated).toContain("createBuilder(schema)");
      expect(generated).toContain('"destSchema": "posts"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits server names for prefixed SQL tables", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "effect-zero-generated-"));
    try {
      await writeFile(
        path.join(dir, "effect-zero.config.ts"),
        [
          'import { pg } from "effect-sql-schema";',
          'import { schema } from "effect-zero";',
          'class User extends pg.Class<User>("User")({ table: "users", fields: { id: pg.uuid().primaryKey().defaultRandom(), name: pg.text().notNull() } }) {}',
          'export default schema({ users: User }, { tablePrefix: "app" });',
        ].join("\n"),
      );

      const project = new Project({
        compilerOptions: {
          module: 99,
          moduleResolution: 99,
          target: 9,
        },
        skipAddingFilesFromTsConfig: true,
      });

      const zeroSchema = schema(
        {
          users: User,
        },
        {
          tablePrefix: "app",
        },
      );

      const generated = getGeneratedSchema({
        tsProject: project,
        zeroSchema,
        outputFilePath: path.join(dir, "zero-schema.gen.ts"),
        configImport: {
          exportName: "default",
          configFilePath: path.join(dir, "effect-zero.config.ts"),
        },
      });

      expect(generated).toContain('serverName: "app_users"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
