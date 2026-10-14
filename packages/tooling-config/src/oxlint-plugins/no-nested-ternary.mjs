import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const pluginDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(pluginDirectory, "../../../..");
const baselinePath = new URL("./no-nested-ternary-baseline.json", import.meta.url);

const addPendingSpace = (state) => {
  if (state.pendingSpace && state.normalized.length > 0) state.normalized += " ";
  state.pendingSpace = false;
};

const quoteByCharacter = new Map([
  ["'", "'"],
  ['"', '"'],
  ["`", "`"],
]);

const regexPrefixKeywords = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "extends",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const controlParenKeywords = new Set(["catch", "for", "if", "switch", "while", "with"]);
const multiCharacterPunctuators = [
  ">>>=",
  "===",
  "!==",
  ">>>",
  "**=",
  "&&=",
  "||=",
  "??=",
  "...",
  "=>",
  "++",
  "--",
  "?.",
  "**",
  "&&",
  "||",
  "??",
  "==",
  "!=",
  "<=",
  ">=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "<<=",
  ">>=",
];

const isIdentifierStart = (character) => /[$_\p{ID_Start}]/u.test(character);
const isIdentifierPart = (character) => /[$\u200c\u200d\p{ID_Continue}]/u.test(character);
const isDigit = (character) => /[0-9]/u.test(character);

const isQuotedTokenEnd = (character, state) => {
  if (state.escaped) {
    state.escaped = false;
    return false;
  }
  if (character === "\\") {
    state.escaped = true;
    return false;
  }
  return character === state.quote;
};

const readQuotedTokenEnd = (source, start) => {
  const state = { quote: source[start], escaped: false };
  for (let index = start + 1; index < source.length; index++) {
    if (isQuotedTokenEnd(source[index], state)) return index + 1;
  }
  return source.length;
};

const isRegexLineTerminator = (character) => character === "\n" || character === "\r";

const isRegexEscaped = (character, state) => {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  state.escaped = character === "\\";
  return state.escaped;
};

const updateRegexCharacterClass = (character, state) => {
  if (character === "[") state.inCharacterClass = true;
  else if (character === "]") state.inCharacterClass = false;
};

const isRegexLiteralEnd = (character, state) => {
  if (isRegexEscaped(character, state)) return false;
  updateRegexCharacterClass(character, state);
  return character === "/" && !state.inCharacterClass;
};

const readRegexFlagsEnd = (source, start) => {
  let index = start;
  while (/[A-Za-z]/u.test(source[index] ?? "")) index++;
  return index;
};

const readRegexTokenEnd = (source, start) => {
  const state = { escaped: false, inCharacterClass: false };
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (isRegexLineTerminator(character)) return undefined;
    if (isRegexLiteralEnd(character, state)) return readRegexFlagsEnd(source, index + 1);
  }
  return undefined;
};

const skipWhitespace = (source, start) => {
  let index = start;
  while (/\s/u.test(source[index] ?? "")) index++;
  return index;
};

const skipLineComment = (source, start) => {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
};

const skipBlockComment = (source, start) => {
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
};

const commentEndReaders = new Map([
  ["/", skipLineComment],
  ["*", skipBlockComment],
]);

const skipComment = (source, start) => {
  if (source[start] !== "/") return undefined;
  return commentEndReaders.get(source[start + 1])?.(source, start);
};

const skipTrivia = (source, start) => {
  let index = start;
  while (index < source.length) {
    const afterWhitespace = skipWhitespace(source, index);
    const afterComment = skipComment(source, afterWhitespace);
    if (afterComment !== undefined) index = afterComment;
    else if (afterWhitespace === index) return index;
    else index = afterWhitespace;
  }
  return index;
};

const readWordToken = (source, start) => {
  const firstCharacter = String.fromCodePoint(source.codePointAt(start));
  if (!isIdentifierStart(firstCharacter)) return undefined;
  let end = start;
  for (const character of source.slice(start)) {
    if (!isIdentifierPart(character)) break;
    end += character.length;
  }
  return { end, type: "word", value: source.slice(start, end) };
};

const readNumberToken = (source, start) => {
  if (!isDigit(source[start])) return undefined;
  let end = start + 1;
  while (/[\w.]/u.test(source[end] ?? "")) end++;
  return { end, type: "literal" };
};

const readQuotedToken = (source, start) =>
  quoteByCharacter.has(source[start])
    ? { end: readQuotedTokenEnd(source, start), type: "literal" }
    : undefined;

const readRegexToken = (source, start, state) => {
  if (!state.canStartRegex || source[start] !== "/") return undefined;
  const end = readRegexTokenEnd(source, start);
  return end === undefined ? undefined : { end, type: "regex" };
};

const readLiteralToken = (source, start, state) =>
  readQuotedToken(source, start) ??
  readRegexToken(source, start, state) ??
  readNumberToken(source, start);

const readPunctuatorToken = (source, start) => {
  const value =
    multiCharacterPunctuators.find((candidate) => source.startsWith(candidate, start)) ??
    source[start];
  return { end: start + value.length, type: "punctuator", value };
};

const readNextToken = (source, start, state) => {
  const literal = readLiteralToken(source, start, state);
  if (literal !== undefined) return literal;
  const word = readWordToken(source, start);
  if (word !== undefined) return word;
  return readPunctuatorToken(source, start);
};

const readNextSignificantToken = (source, start, state) => {
  const index = skipTrivia(source, start);
  return index === source.length
    ? { end: index, start: index, type: "end" }
    : { ...readNextToken(source, index, state), start: index };
};

const advanceWordState = (state, word) => {
  state.canStartRegex = regexPrefixKeywords.has(word);
  state.lastWord = word;
  state.lastToken = "word";
};

const advanceParenState = (state, punctuator) => {
  if (punctuator === "(") {
    state.controlParens.push(controlParenKeywords.has(state.lastWord));
    state.canStartRegex = true;
  } else {
    state.canStartRegex = state.controlParens.pop() ?? false;
  }
};

const advanceBraceState = (state, punctuator, canStartBeforePunctuator) => {
  if (punctuator === "{") {
    state.blockBraces.push(!canStartBeforePunctuator || state.lastToken === "=>");
    state.canStartRegex = true;
  } else {
    state.canStartRegex = state.blockBraces.pop() ?? false;
  }
};

const isRegexPostfixPunctuator = (punctuator) => ["]", ".", "?.", "++", "--"].includes(punctuator);

const advanceOtherPunctuatorState = (state, punctuator) => {
  state.canStartRegex = !isRegexPostfixPunctuator(punctuator);
};

const punctuatorStateAdvancers = new Map([
  ["(", advanceParenState],
  [")", advanceParenState],
  ["{", advanceBraceState],
  ["}", advanceBraceState],
]);

const advancePunctuatorState = (state, punctuator) => {
  const advance = punctuatorStateAdvancers.get(punctuator) ?? advanceOtherPunctuatorState;
  advance(state, punctuator, state.canStartRegex);
  state.lastWord = undefined;
  state.lastToken = punctuator;
};

const advanceTokenState = (state, token) => {
  if (token.type === "word") advanceWordState(state, token.value);
  else if (token.type === "punctuator") advancePunctuatorState(state, token.value);
  else {
    state.canStartRegex = false;
    state.lastWord = undefined;
    state.lastToken = "literal";
  }
};

const findRegexLiteralRanges = (source) => {
  const ranges = new Map();
  const state = { canStartRegex: true, controlParens: [], blockBraces: [] };
  let index = 0;
  while (index < source.length) {
    const token = readNextSignificantToken(source, index, state);
    if (token.type === "end") return ranges;
    if (token.type === "regex") ranges.set(token.start, token.end);
    advanceTokenState(state, token);
    index = token.end;
  }
  return ranges;
};

const appendQuotedCharacter = (character, state) => {
  state.normalized += character;
  if (state.escaped) {
    state.escaped = false;
  } else if (character === "\\") {
    state.escaped = true;
  } else if (character === state.quote) {
    state.quote = undefined;
  }
};

const appendUnquotedCharacter = (character, state) => {
  const quote = quoteByCharacter.get(character);
  if (quote !== undefined) {
    addPendingSpace(state);
    state.quote = quote;
    state.normalized += quote;
    return;
  }
  if (/\s/u.test(character)) {
    state.pendingSpace = true;
    return;
  }
  addPendingSpace(state);
  state.normalized += character;
};

const normalizeExpression = (source) => {
  const state = { normalized: "", quote: undefined, escaped: false, pendingSpace: false };
  const regexRanges = findRegexLiteralRanges(source);
  for (let index = 0; index < source.length; ) {
    const regexEnd = regexRanges.get(index);
    if (regexEnd !== undefined) {
      addPendingSpace(state);
      state.normalized += source.slice(index, regexEnd);
      index = regexEnd;
      continue;
    }
    const character = String.fromCodePoint(source.codePointAt(index));
    if (state.quote === undefined) appendUnquotedCharacter(character, state);
    else appendQuotedCharacter(character, state);
    index += character.length;
  }
  return state.normalized.trim();
};

const expressionFingerprint = (source) =>
  createHash("sha256").update(normalizeExpression(source)).digest("hex");

const siteNodeTypes = new Set([
  "AssignmentExpression",
  "ArrowFunctionExpression",
  "ExpressionStatement",
  "FunctionExpression",
  "Property",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclarator",
]);

const enclosingSite = (node) => {
  let ancestor = node.parent;
  while (ancestor !== null && ancestor !== undefined) {
    if (siteNodeTypes.has(ancestor.type)) return ancestor;
    ancestor = ancestor.parent;
  }
  return node;
};

export const fingerprintNestedTernarySite = (expressionSource, siteSource) => {
  const expressionFingerprint = expressionFingerprintOf(expressionSource);
  const siteFingerprint = expressionFingerprintOf(siteSource);
  return {
    expressionFingerprint,
    siteFingerprint,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([expressionFingerprint, siteFingerprint]))
      .digest("hex"),
  };
};

const expressionFingerprintOf = (source) =>
  createHash("sha256").update(normalizeExpression(source)).digest("hex");

const hasSupportedBaselineSchema = (parsed) =>
  parsed?.schema === "tiara.no-nested-ternary-baseline.v2";

const hasValidBaselineRevision = (parsed) => /^[a-f0-9]{40}$/u.test(parsed?.base);

const hasSupportedFingerprintAlgorithm = (parsed) =>
  parsed?.algorithm === "normalized-expression-and-enclosing-site-source-sha256-v2";

const hasBaselineEntries = (parsed) => Array.isArray(parsed?.entries);

const isValidBaselineMetadata = (parsed) =>
  [
    hasSupportedBaselineSchema,
    hasValidBaselineRevision,
    hasSupportedFingerprintAlgorithm,
    hasBaselineEntries,
  ].every((validate) => validate(parsed));

const isValidBaselinePath = (path) =>
  typeof path === "string" &&
  [path.length > 0, !path.startsWith("/"), !path.split("/").includes("..")].every(Boolean);

const isValidBaselineCount = (count) => Number.isSafeInteger(count) && count > 0;

const hasValidFingerprint = (fingerprint) => /^[a-f0-9]{64}$/u.test(fingerprint);

const hasValidEntryFingerprints = (entry) =>
  [
    hasValidFingerprint(entry.expressionFingerprint),
    hasValidFingerprint(entry.siteFingerprint),
    hasValidFingerprint(entry.fingerprint),
    baselineEntryFingerprintMatches(entry),
  ].every(Boolean);

const baselineEntryFingerprintMatches = (entry) => {
  const expected = createHash("sha256")
    .update(JSON.stringify([entry.expressionFingerprint, entry.siteFingerprint]))
    .digest("hex");
  return entry.fingerprint === expected;
};

const isValidBaselineEntry = (entry) =>
  isValidBaselinePath(entry?.path) &&
  hasValidEntryFingerprints(entry) &&
  isValidBaselineCount(entry.count);

const addBaselineEntry = (byPath, entry) => {
  const pathEntries = byPath.get(entry.path) ?? new Map();
  if (pathEntries.has(entry.fingerprint))
    throw new Error("Duplicate nested-ternary baseline entry");
  pathEntries.set(entry.fingerprint, entry.count);
  byPath.set(entry.path, pathEntries);
};

const collectBaselineEntries = (entries) => {
  const byPath = new Map();
  for (const entry of entries) {
    if (!isValidBaselineEntry(entry)) throw new Error("Invalid nested-ternary baseline entry");
    addBaselineEntry(byPath, entry);
  }
  return byPath;
};

const countBaselineOccurrences = (entries) =>
  entries.reduce((total, entry) => total + entry.count, 0);

export const validateNestedTernaryBaseline = (parsed) => {
  if (!isValidBaselineMetadata(parsed)) throw new Error("Invalid nested-ternary baseline metadata");
  const byPath = collectBaselineEntries(parsed.entries);
  const total = countBaselineOccurrences(parsed.entries);
  if (total !== parsed.totalOccurrences || total === 0) {
    throw new Error("Nested-ternary baseline occurrence count is inconsistent");
  }
  return byPath;
};

const readProjectBaseline = () => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (cause) {
    throw new Error("Unable to read nested-ternary baseline", { cause });
  }
  return validateNestedTernaryBaseline(parsed);
};

const isNestedBranch = (node) =>
  node.consequent?.type === "ConditionalExpression" ||
  node.alternate?.type === "ConditionalExpression";

const resolveRuleBaseline = (options) =>
  options?.baseline === "project" ? readProjectBaseline() : new Map();

const resolveRelativeFilename = (context) => {
  const filename = context.filename ?? context.getFilename();
  const absoluteFilename = isAbsolute(filename) ? filename : resolve(process.cwd(), filename);
  return relative(repositoryRoot, absoluteFilename).split(sep).join("/");
};

const nextOccurrence = (seen, fingerprint) => {
  const occurrence = (seen.get(fingerprint) ?? 0) + 1;
  seen.set(fingerprint, occurrence);
  return occurrence;
};

const nestedConditionalFingerprint = (node, sourceCode) => {
  if (!isNestedBranch(node)) return undefined;
  const site = enclosingSite(node);
  return fingerprintNestedTernarySite(sourceCode.getText(node), sourceCode.getText(site))
    .fingerprint;
};

const isRecordedOccurrence = (fingerprint, allowed, seen) =>
  nextOccurrence(seen, fingerprint) <= (allowed.get(fingerprint) ?? 0);

const reportNestedConditional = (context, node, allowed, seen) => {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const fingerprint = nestedConditionalFingerprint(node, sourceCode);
  if (fingerprint === undefined || isRecordedOccurrence(fingerprint, allowed, seen)) return;
  context.report({ node, messageId: "nested" });
};

const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow nested conditional expressions",
    },
    messages: {
      nested: "Do not nest conditional expressions; use a named helper or explicit control flow.",
    },
    schema: [
      {
        type: "object",
        properties: { baseline: { enum: ["project"] } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const baseline = resolveRuleBaseline(context.options[0]);
    const relativePath = resolveRelativeFilename(context);
    const allowed = baseline.get(relativePath) ?? new Map();
    const seen = new Map();

    return {
      ConditionalExpression: (node) => reportNestedConditional(context, node, allowed, seen),
    };
  },
};

export const normalizeNestedTernaryExpression = normalizeExpression;
export const fingerprintNestedTernaryExpression = expressionFingerprint;
export default {
  meta: { name: "tiara", version: "1.0.0" },
  rules: { "no-nested-ternary": rule },
};
