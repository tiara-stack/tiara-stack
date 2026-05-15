import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./util";

describe("util", () => {
  it("splits same-line SQL statements", () => {
    expect(
      splitSqlStatements("CREATE TABLE users (id text); INSERT INTO users VALUES ('1');"),
    ).toEqual(["CREATE TABLE users (id text)", "INSERT INTO users VALUES ('1')"]);
  });

  it("does not split semicolons inside quoted literals", () => {
    expect(
      splitSqlStatements("CREATE TABLE users (id text); INSERT INTO users VALUES ('a;b');"),
    ).toEqual(["CREATE TABLE users (id text)", "INSERT INTO users VALUES ('a;b')"]);
  });
});
