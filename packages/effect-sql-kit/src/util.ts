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

type SqlQuote = "'" | '"' | "`";

interface SplitSqlState {
  readonly sql: string;
  readonly statements: string[];
  current: string;
  quote: SqlQuote | undefined;
  lineComment: boolean;
  blockComment: boolean;
  index: number;
}

const pushStatement = (state: SplitSqlState) => {
  state.statements.push(state.current);
  state.current = "";
};

const appendCurrentAndAdvance = (state: SplitSqlState, value: string, offset = 0) => {
  state.current += value;
  state.index += offset;
};

const handleLineComment = (state: SplitSqlState, char: string): boolean => {
  if (!state.lineComment) {
    return false;
  }

  appendCurrentAndAdvance(state, char);
  if (char === "\n") {
    state.lineComment = false;
  }
  return true;
};

const handleBlockComment = (
  state: SplitSqlState,
  char: string,
  next: string | undefined,
): boolean => {
  if (!state.blockComment) {
    return false;
  }

  if (char === "*" && next === "/") {
    appendCurrentAndAdvance(state, char + next, 1);
    state.blockComment = false;
    return true;
  }

  appendCurrentAndAdvance(state, char);
  return true;
};

const handleQuotedText = (
  state: SplitSqlState,
  char: string,
  next: string | undefined,
): boolean => {
  if (!state.quote) {
    return false;
  }

  if (char === "\\" && next !== undefined) {
    appendCurrentAndAdvance(state, char + next, 1);
    return true;
  }

  if (char === state.quote && next === state.quote) {
    appendCurrentAndAdvance(state, char + next, 1);
    return true;
  }

  appendCurrentAndAdvance(state, char);
  if (char === state.quote) {
    state.quote = undefined;
  }
  return true;
};

const handleStatementBoundary = (state: SplitSqlState, char: string): boolean => {
  if (state.sql.startsWith(statementDelimiter, state.index)) {
    pushStatement(state);
    state.index += statementDelimiter.length - 1;
    return true;
  }

  if (char === ";") {
    pushStatement(state);
    return true;
  }

  return false;
};

const handleCommentStart = (
  state: SplitSqlState,
  char: string,
  next: string | undefined,
): boolean => {
  if (char === "-" && next === "-") {
    appendCurrentAndAdvance(state, char + next, 1);
    state.lineComment = true;
    return true;
  }

  if (char === "/" && next === "*") {
    appendCurrentAndAdvance(state, char + next, 1);
    state.blockComment = true;
    return true;
  }

  return false;
};

const handleQuoteStart = (state: SplitSqlState, char: string): boolean => {
  if (char !== "'" && char !== '"' && char !== "`") {
    return false;
  }

  appendCurrentAndAdvance(state, char);
  state.quote = char;
  return true;
};

const normalizeStatements = (statements: readonly string[]): readonly string[] =>
  statements
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.endsWith(";") ? part.slice(0, -1).trim() : part));

export const splitSqlStatements = (sql: string): readonly string[] => {
  const state: SplitSqlState = {
    sql,
    statements: [],
    current: "",
    quote: undefined,
    lineComment: false,
    blockComment: false,
    index: 0,
  };

  for (; state.index < sql.length; state.index++) {
    const char = sql[state.index]!;
    const next = sql[state.index + 1];
    const handled =
      handleLineComment(state, char) ||
      handleBlockComment(state, char, next) ||
      handleQuotedText(state, char, next) ||
      handleStatementBoundary(state, char) ||
      handleCommentStart(state, char, next) ||
      handleQuoteStart(state, char);

    if (!handled) {
      appendCurrentAndAdvance(state, char);
    }
  }

  if (state.current.length > 0) {
    pushStatement(state);
  }

  return normalizeStatements(state.statements);
};
