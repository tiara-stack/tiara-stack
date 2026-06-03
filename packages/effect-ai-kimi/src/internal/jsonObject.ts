import * as Tool from "effect/unstable/ai/Tool";

const hasRequiredKeys = (value: unknown, requiredKeys: ReadonlyArray<string>) =>
  requiredKeys.length === 0 ||
  (value !== null &&
    typeof value === "object" &&
    requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));

type JsonBoundaryState = {
  depth: number;
  inString: boolean;
  escaped: boolean;
};

const advanceStringState = (state: JsonBoundaryState, char: string): boolean => {
  if (!state.inString) {
    return false;
  }
  if (state.escaped) {
    state.escaped = false;
  } else if (char === "\\") {
    state.escaped = true;
  } else if (char === '"') {
    state.inString = false;
  }
  return true;
};

const advanceBoundaryState = (state: JsonBoundaryState, char: string): boolean => {
  if (char === '"') {
    state.inString = true;
  } else if (char === "{") {
    state.depth++;
  } else if (char === "}") {
    state.depth--;
    return state.depth === 0;
  }
  return false;
};

const candidateEndIndex = (text: string, start: number): number | undefined => {
  const state: JsonBoundaryState = { depth: 0, inString: false, escaped: false };
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (!advanceStringState(state, char) && advanceBoundaryState(state, char)) {
      return index;
    }
  }
  return undefined;
};

const isMatchingCandidate = (candidate: string, requiredKeys: ReadonlyArray<string>): boolean => {
  try {
    return hasRequiredKeys(Tool.unsafeSecureJsonParse(candidate), requiredKeys);
  } catch {
    return false;
  }
};

export const extractJsonObject = (text: string, requiredKeys: ReadonlyArray<string>): string => {
  let fallbackCandidate: string | undefined;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = candidateEndIndex(text, start);
    if (end === undefined) {
      continue;
    }
    const candidate = text.slice(start, end + 1);
    if (isMatchingCandidate(candidate, requiredKeys)) {
      if (requiredKeys.length === 0) {
        fallbackCandidate = candidate;
        start = end;
        continue;
      }
      return candidate;
    }
    // Keep scanning inside valid wrapper objects so a nested response object can be recovered when
    // the provider wraps the requested schema under an extra key. Parse failures also continue so
    // nested braces inside code-like preamble can still lead to the final JSON object.
  }
  return fallbackCandidate ?? text;
};
