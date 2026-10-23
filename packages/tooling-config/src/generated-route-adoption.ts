import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratorPlugin } from "@tanstack/router-generator";
import { parseSync } from "vite/rolldown/utils";
import { generatedRouteBuiltinSiteIdentity } from "./oxlint-plugins/effect-policy.mjs";

type RouteProof = {
  status: string;
  rule: string;
  base: {
    path: string;
    bytes: number;
    contentSha256: string;
    blob: string;
  };
  decoratedRoute: {
    path: string;
    bytes: number;
    contentSha256: string;
  };
  mappings: ReadonlyArray<{
    ordinal: number;
    baseMatch: {
      expression: string;
      offset: number;
      length: number;
    };
    pluginSite: {
      site: string;
      source: string;
    };
  }>;
};

type AstNode = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  range?: [number, number];
  parent?: AstNode;
};

type RouteSource = {
  readonly ast: AstNode;
  getText(node: AstNode): string;
  getAllComments(): ReadonlyArray<{ readonly value: string; readonly range?: [number, number] }>;
};
type RouteComment = { readonly value: string; readonly range: [number, number] };
type ParsedRouteSource = { readonly ast: AstNode; readonly comments: ReadonlyArray<RouteComment> };

type DirectiveKind = "disable" | "enable";
type DirectiveMarker = { kind: DirectiveKind; start: number; end: number };
type AssertionEdit = { offset: number; text: string };
type ExistingDirectives = { source: string; present: boolean; valid: boolean };

const GENERATED_ROUTE_PATH = "packages/sheet-web/src/routeTree.gen.ts";
const ROUTE_PROOF_SHA256 = "0ed3e7024b0b2f3a83001b741b58be15f1522bc69cc663e963997978ba99c921";
const BASELINE_RULE = "typescript/no-unsafe-type-assertion";
const DIRECTIVE_NOTE = "inherited master site";
const SKIPPED_AST_KEYS = new Set(["parent", "range", "start", "end", "loc", "tokens", "comments"]);

const projectRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const routeProofPath = path.join(
  projectRoot,
  "packages/tooling-config/test/fixtures/route28-base-bijection.json",
);

const hasAcceptedRouteProofIdentity = (proof: RouteProof) =>
  proof.status === "PORTABLE_ROUTE_BASE_BIJECTION" &&
  proof.rule === BASELINE_RULE &&
  proof.mappings.length === 28;

const hasGeneratedRoutePaths = (proof: RouteProof) =>
  proof.base.path === GENERATED_ROUTE_PATH && proof.decoratedRoute.path === GENERATED_ROUTE_PATH;

const readRouteProof = (): RouteProof => {
  const bytes = readFileSync(routeProofPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ROUTE_PROOF_SHA256)
    throw new Error("The checked-in route adoption proof changed without a source grant.");
  const proof: RouteProof = JSON.parse(bytes.toString("utf8"));
  if (!hasAcceptedRouteProofIdentity(proof) || !hasGeneratedRoutePaths(proof))
    throw new Error("The route adoption proof does not describe the accepted 28-site cohort.");
  return proof;
};

const routeProof = readRouteProof();
const acceptedSites = new Set(routeProof.mappings.map(({ pluginSite }) => pluginSite.site));

const hasAstNodeShape = (value: object) =>
  typeof Reflect.get(value, "type") === "string" &&
  typeof Reflect.get(value, "start") === "number" &&
  typeof Reflect.get(value, "end") === "number";

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && hasAstNodeShape(value);

const isAnyTypeAssertion = (node: AstNode) => {
  const typeAnnotation = Reflect.get(node, "typeAnnotation");
  return (
    node.type === "TSAsExpression" &&
    isAstNode(typeAnnotation) &&
    typeAnnotation.type === "TSAnyKeyword"
  );
};

const assertionExpression = (node: AstNode) => {
  const expression = Reflect.get(node, "expression");
  return isAstNode(expression) ? expression : undefined;
};

const astChildren = (node: AstNode) =>
  Object.entries(node)
    .filter(([key]) => !SKIPPED_AST_KEYS.has(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .filter(isAstNode);

const siteMatches = (sites: ReadonlyMap<string, ReadonlyArray<AstNode>>, site: string) =>
  sites.get(site) ?? [];

const setAstParent = (node: AstNode, parent: AstNode | undefined) => {
  if (parent !== undefined) Reflect.set(node, "parent", parent);
};

const linkAstParents = (root: AstNode) => {
  const pending: Array<{ node: AstNode; parent?: AstNode }> = [{ node: root }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    setAstParent(current.node, current.parent);
    Reflect.set(current.node, "range", [current.node.start, current.node.end]);
    for (const child of astChildren(current.node))
      pending.push({ node: child, parent: current.node });
  }
};

const sourceTextRange = (node: AstNode): [number, number] => {
  const range = node.range;
  if (range === undefined) return [node.start, node.end];
  return [range[0] ?? node.start, range[1] ?? node.end];
};

const sourceCodeFor = (
  source: string,
  ast: AstNode,
  comments: ReadonlyArray<RouteComment>,
): RouteSource => ({
  ast,
  getText: (node) => {
    const [start, end] = sourceTextRange(node);
    return source.slice(start, end);
  },
  getAllComments: () => comments,
});

const recordAssertionSite = (
  node: AstNode,
  sourceCode: RouteSource,
  sites: Map<string, AstNode[]>,
) => {
  const expression = assertionExpression(node);
  if (expression === undefined) return;
  const site = generatedRouteBuiltinSiteIdentity(node, sourceCode);
  if (!acceptedSites.has(site)) return;
  const matches = siteMatches(sites, site);
  sites.set(site, [...matches, node]);
};

const directiveText = (kind: DirectiveKind) =>
  `/* oxlint-${kind} ${BASELINE_RULE} -- ${DIRECTIVE_NOTE} */`;

const findDirectiveMarkers = (
  source: string,
  comments: ReadonlyArray<RouteComment>,
): ReadonlyArray<DirectiveMarker> => {
  const markers: DirectiveMarker[] = [];
  for (const comment of comments) {
    const [start, end] = comment.range;
    const text = source.slice(start, end);
    for (const kind of ["disable", "enable"] as const) {
      if (text === directiveText(kind)) markers.push({ kind, start, end });
    }
  }
  return markers.sort((left, right) => left.start - right.start);
};

const directiveSequenceIsPaired = (markers: ReadonlyArray<DirectiveMarker>) => {
  const expectedKind = (index: number) => (index % 2 === 0 ? "disable" : "enable");
  return (
    markers.length % 2 === 0 &&
    markers.every((marker, index) => marker.kind === expectedKind(index))
  );
};

const stripDirectiveMarkers = (
  source: string,
  comments: ReadonlyArray<RouteComment>,
): ExistingDirectives => {
  const markers = findDirectiveMarkers(source, comments);
  if (markers.length === 0) return { source, present: false, valid: true };
  if (!directiveSequenceIsPaired(markers)) return { source, present: true, valid: false };

  const removals = markers.map(({ start, end }) => ({
    start: source[start - 1] === " " ? start - 1 : start,
    end,
  }));
  let stripped = source;
  for (const removal of removals.sort((left, right) => right.start - left.start))
    stripped = stripped.slice(0, removal.start) + stripped.slice(removal.end);
  return { source: stripped, present: true, valid: true };
};

const parsedRouteSourceFor = (source: string): ParsedRouteSource => {
  const parsed = parseSync(GENERATED_ROUTE_PATH, source, { lang: "ts" });
  if (parsed.errors.length > 0)
    throw new Error("The route generator returned invalid TypeScript source.");
  const parsedRoot = parsed.program;
  if (!isAstNode(parsedRoot))
    throw new Error("The route generator returned an invalid TypeScript AST.");
  linkAstParents(parsedRoot);
  return {
    ast: parsedRoot,
    comments: parsed.comments.map(({ value, start, end }) => ({
      value,
      range: [start, end],
    })),
  };
};

const astAndSourceCodeFor = (
  source: string,
  parsed: ParsedRouteSource = parsedRouteSourceFor(source),
) => {
  const sites = new Map<string, AstNode[]>();
  const sourceCode = sourceCodeFor(source, parsed.ast, parsed.comments);
  const collect = (node: AstNode) => {
    if (isAnyTypeAssertion(node)) recordAssertionSite(node, sourceCode, sites);
    for (const child of astChildren(node)) collect(child);
  };
  collect(parsed.ast);
  return { ast: parsed.ast, sites };
};

const assertionForUniqueSite = (matches: ReadonlyArray<AstNode>, site: string) => {
  if (matches.length !== 1) return undefined;
  const assertion = matches[0];
  if (assertion === undefined)
    throw new Error(`The unique accepted route assertion ${site} is missing from its match list.`);
  return assertion;
};

const uniqueAssertionEdits = (
  sites: ReadonlyMap<string, ReadonlyArray<AstNode>>,
): ReadonlyArray<AssertionEdit> => {
  const edits: AssertionEdit[] = [];
  for (const mapping of routeProof.mappings) {
    const matches = siteMatches(sites, mapping.pluginSite.site);
    const assertion = assertionForUniqueSite(matches, mapping.pluginSite.site);
    if (assertion === undefined) continue;
    const expression = Reflect.get(assertion, "expression");
    if (!isAstNode(expression))
      throw new Error(`The accepted route assertion ${mapping.pluginSite.site} has no expression.`);
    edits.push({ offset: expression.end, text: ` ${directiveText("disable")}` });
    edits.push({ offset: assertion.end, text: ` ${directiveText("enable")}` });
  }
  return edits;
};

const insertEdits = (source: string, edits: ReadonlyArray<AssertionEdit>) => {
  let output = source;
  for (const edit of [...edits].sort((left, right) => right.offset - left.offset))
    output = output.slice(0, edit.offset) + edit.text + output.slice(edit.offset);
  return output;
};

export const decorateGeneratedRouteTree = (source: string): string => {
  const parsedSource = parsedRouteSourceFor(source);
  const existing = stripDirectiveMarkers(source, parsedSource.comments);
  if (!existing.valid) return source;
  const parsed =
    existing.source === source
      ? astAndSourceCodeFor(source, parsedSource)
      : astAndSourceCodeFor(existing.source);
  const decorated = insertEdits(existing.source, uniqueAssertionEdits(parsed.sites));
  return existing.present && decorated !== source ? source : decorated;
};

export const createGeneratedRouteAdoptionPlugin = (options: {
  readonly generatedRouteTreePath: string;
}): GeneratorPlugin => ({
  name: "tiara-generated-route-adoption",
  init({ generator }) {
    const expectedPath = path.resolve(options.generatedRouteTreePath);
    const actualPath = path.resolve(generator.config.generatedRouteTree);
    if (actualPath !== expectedPath)
      throw new Error(`Generated route adoption expected ${expectedPath}, received ${actualPath}.`);

    const originalBuildRouteTree = generator.buildRouteTree.bind(generator);
    generator.buildRouteTree = (input) => {
      const output = originalBuildRouteTree(input);
      if (generator.config.disableTypes || input.config?.disableTypes) return output;
      return { ...output, routeTreeContent: decorateGeneratedRouteTree(output.routeTreeContent) };
    };
  },
});
