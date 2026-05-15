// The dialect parameter is accepted for future identifier-quoting differences.
// Postgres and SQLite currently both use double quotes here.
export const quoteIdentifier = (identifier: string, dialect: "postgresql" | "sqlite"): string => {
  const quoteByDialect: Record<typeof dialect, '"'> = {
    postgresql: '"',
    sqlite: '"',
  };
  const quote = quoteByDialect[dialect];
  return `${quote}${identifier.replaceAll(quote, `${quote}${quote}`)}${quote}`;
};

export const quoteQualified = (
  dialect: "postgresql" | "sqlite",
  table: string,
  schema?: string,
): string =>
  schema && dialect === "postgresql"
    ? `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(table, dialect)}`
    : quoteIdentifier(table, dialect);

export const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "migration";

export const statementDelimiter = "--> statement-breakpoint";

export const splitSqlStatements = (sql: string): readonly string[] => {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;

  const push = () => {
    statements.push(current);
    current = "";
  };

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (!quote && !lineComment && !blockComment && sql.startsWith(statementDelimiter, index)) {
      push();
      index += statementDelimiter.length - 1;
      continue;
    }

    if (lineComment) {
      current += char;
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index++;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      current += char;
      if (char === "\\" && next !== undefined) {
        current += next;
        index++;
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          current += next;
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      current += char + next;
      index++;
      lineComment = true;
      continue;
    }

    if (char === "/" && next === "*") {
      current += char + next;
      index++;
      blockComment = true;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      current += char;
      quote = char;
      continue;
    }

    if (char === ";") {
      push();
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    push();
  }

  return statements
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.endsWith(";") ? part.slice(0, -1).trim() : part));
};
