import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import { many, one } from "./relationships";
import { schema } from "./schema";
import { table } from "./table";

class User extends Model.Class<User>("User")({
  id: Model.Generated(Schema.String),
}) {}

class Post extends Model.Class<Post>("Post")({
  id: Model.Generated(Schema.String),
  authorId: Schema.String,
}) {}

class UserToGroup extends Model.Class<UserToGroup>("UserToGroup")({
  userId: Schema.String,
  groupId: Schema.String,
}) {}

class Group extends Model.Class<Group>("Group")({
  id: Model.Generated(Schema.String),
}) {}

const users = table(User, { name: "users", key: ["id"] });
const posts = table(Post, { name: "posts", key: ["id"] });
const usersToGroups = table(UserToGroup, { name: "usersToGroups", key: ["userId", "groupId"] });
const groups = table(Group, { name: "groups", key: ["id"] });

describe("relationships", () => {
  it("creates one and many relationship metadata", () => {
    const zeroSchema = schema(
      { users, posts },
      {
        relationships: {
          users: {
            posts: many(posts, { source: ["id"], dest: ["authorId"] }),
          },
          posts: {
            author: one(users, { source: ["authorId"], dest: ["id"] }),
          },
        },
      },
    );

    expect(zeroSchema.relationships.users.posts).toEqual([
      {
        sourceField: ["id"],
        destField: ["authorId"],
        destSchema: "posts",
        cardinality: "many",
      },
    ]);
    expect(zeroSchema.relationships.posts.author).toEqual([
      {
        sourceField: ["authorId"],
        destField: ["id"],
        destSchema: "users",
        cardinality: "one",
      },
    ]);
  });

  it("creates multi-hop many relationship metadata", () => {
    expect(
      many(groups, [
        { dest: usersToGroups, source: ["id"], destField: ["userId"] },
        { dest: groups, source: ["groupId"], destField: ["id"] },
      ]),
    ).toEqual([
      {
        sourceField: ["id"],
        destField: ["userId"],
        destSchema: "usersToGroups",
        cardinality: "many",
      },
      {
        sourceField: ["groupId"],
        destField: ["id"],
        destSchema: "groups",
        cardinality: "many",
      },
    ]);
  });
});
