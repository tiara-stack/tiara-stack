import { describe, expect, it } from "@effect/vitest";
import { splitSqlStatements, statementDelimiter } from "./util";

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

  it("does not split semicolons inside comments", () => {
    expect(
      splitSqlStatements(
        "CREATE TABLE users (id text); -- keep ; in line comment\n/* keep ; in block comment */ INSERT INTO users VALUES ('1');",
      ),
    ).toEqual([
      "CREATE TABLE users (id text)",
      "-- keep ; in line comment\n/* keep ; in block comment */ INSERT INTO users VALUES ('1')",
    ]);
  });

  it("handles escaped and doubled quote characters", () => {
    expect(
      splitSqlStatements(
        String.raw`INSERT INTO users VALUES ('escaped \'; semicolon'); INSERT INTO users VALUES ('doubled ''; semicolon');`,
      ),
    ).toEqual([
      String.raw`INSERT INTO users VALUES ('escaped \'; semicolon')`,
      "INSERT INTO users VALUES ('doubled ''; semicolon')",
    ]);
  });

  it("splits explicit statement breakpoints outside quoted text", () => {
    expect(
      splitSqlStatements(
        `CREATE TABLE users (id text)\n${statementDelimiter}\nINSERT INTO users VALUES ('${statementDelimiter}')`,
      ),
    ).toEqual([
      "CREATE TABLE users (id text)",
      `INSERT INTO users VALUES ('${statementDelimiter}')`,
    ]);
  });
});
