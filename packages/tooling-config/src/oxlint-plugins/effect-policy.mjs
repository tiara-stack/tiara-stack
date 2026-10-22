import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const baselinePath = path.join(
  root,
  "packages/tooling-config/src/oxlint-plugins/no-nested-ternary-baseline.json",
);
const BASELINE_SHA256 = "1cdeb54a8fcb051a5460428d9a247fcdb26a3db96227940c9154df6d98b3090c";
const requestedBaselinePath = process.env.TIARA_NESTED_TERNARY_BASELINE_PATH;
const testBaselineOverride =
  process.env.NODE_ENV === "test" &&
  process.env.TIARA_NESTED_TERNARY_TEST_BASELINE === "1" &&
  requestedBaselinePath !== undefined;
if (requestedBaselinePath !== undefined && !testBaselineOverride) {
  throw new Error("TIARA_NESTED_TERNARY_BASELINE_PATH is only available to test fixtures.");
}
const baselineBytes = readFileSync(testBaselineOverride ? requestedBaselinePath : baselinePath);
if (
  !testBaselineOverride &&
  createHash("sha256").update(baselineBytes).digest("hex") !== BASELINE_SHA256
) {
  throw new Error("Nested-ternary baseline changed without an explicit policy update.");
}
const baseline = JSON.parse(baselineBytes.toString("utf8"));
const read = (object, key) => (object === null || object === undefined ? undefined : object[key]);
const allOf = (checks) => checks.every(Boolean);
const anyOf = (checks) => checks.some(Boolean);
const isType = (node, type) => read(node, "type") === type;
const member = (node, name) =>
  allOf([
    isType(node, "MemberExpression"),
    !read(node, "computed"),
    read(read(node, "property"), "name") === name,
  ]);
const id = (node, name) => allOf([isType(node, "Identifier"), read(node, "name") === name]);
const literal = (node) => (isType(node, "Literal") ? read(node, "value") : undefined);
const tagAccess = (node) => {
  const property = read(node, "property");
  return allOf([
    isType(node, "MemberExpression"),
    anyOf([
      allOf([read(node, "computed"), literal(property) === "_tag"]),
      allOf([!read(node, "computed"), read(property, "name") === "_tag"]),
    ]),
  ]);
};
const globalTimerApiNames = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
]);
const wallClockTimerNames = new Set(["setTimeout", "setInterval"]);
const callbackFileSystemApis = [
  "access",
  "appendFile",
  "chmod",
  "chown",
  "close",
  "copyFile",
  "cp",
  "exists",
  "fchmod",
  "fchown",
  "fdatasync",
  "fstat",
  "fsync",
  "ftruncate",
  "futimes",
  "glob",
  "lchmod",
  "lchown",
  "link",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "read",
  "readdir",
  "readFile",
  "readlink",
  "readv",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "truncate",
  "unlink",
  "unwatchFile",
  "utimes",
  "watch",
  "watchFile",
  "write",
  "writeFile",
  "writev",
];
const filesystemSyncApis = [
  "accessSync",
  "appendFileSync",
  "chmodSync",
  "chownSync",
  "closeSync",
  "copyFileSync",
  "cpSync",
  "existsSync",
  "fchmodSync",
  "fchownSync",
  "fdatasyncSync",
  "fstatSync",
  "fsyncSync",
  "ftruncateSync",
  "futimesSync",
  "globSync",
  "lchownSync",
  "lutimesSync",
  "lstatSync",
  "linkSync",
  "lchmodSync",
  "mkdirSync",
  "mkdtempSync",
  "mkdtempDisposableSync",
  "openSync",
  "opendirSync",
  "readFileSync",
  "readSync",
  "readvSync",
  "readdirSync",
  "readlinkSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "rmdirSync",
  "statSync",
  "statfsSync",
  "symlinkSync",
  "truncateSync",
  "unlinkSync",
  "utimesSync",
  "writeFileSync",
  "writeSync",
  "writevSync",
];
const nodeFileSystemApis = new Set([
  ...callbackFileSystemApis,
  ...filesystemSyncApis,
  "createReadStream",
  "createWriteStream",
  "openAsBlob",
]);
const effectCallbackPositions = new Map([
  ["gen", [0]],
  ["promise", [0]],
  ["sync", [0]],
  ["suspend", [0]],
  ["async", [0]],
  ["forEach", [1]],
  ["tryPromise", [0]],
  ["acquireRelease", [0, 1]],
  ["acquireUseRelease", [0, 1, 2]],
  ["map", [1]],
  ["flatMap", [1]],
  ["andThen", [1]],
  ["tap", [1]],
  ["catch", [1]],
]);
const staticMemberName = (node) => {
  if (!isType(node, "MemberExpression")) return undefined;
  const property = read(node, "property");
  return read(node, "computed") ? literal(property) : read(property, "name");
};
const isEffectPipeStageCall = (call) => {
  const parent = read(call, "parent");
  return allOf([
    isType(parent, "CallExpression"),
    member(read(parent, "callee"), "pipe"),
    (read(parent, "arguments") ?? []).includes(call),
  ]);
};
const testRegistrationModifiers = new Set(["only", "fails", "prop"]);
const testMethodReference = (node, method, isVitestItReference, allowCurried = false) => {
  if (member(node, method) && isVitestItReference(read(node, "object"))) return true;
  if (testRegistrationModifiers.has(staticMemberName(node)))
    return testMethodReference(read(node, "object"), method, isVitestItReference, true);
  if (!allowCurried || !isType(node, "CallExpression")) return false;
  const factory = read(node, "callee");
  if (!["each", "runIf", "skipIf"].includes(staticMemberName(factory))) return false;
  return testMethodReference(read(factory, "object"), method, isVitestItReference, true);
};
const appliedTestRegistrationFactory = (factory, method, isVitestItReference) => {
  const factoryMethod = staticMemberName(factory);
  if (!["each", "runIf", "skipIf"].includes(factoryMethod)) return false;
  return testMethodReference(read(factory, "object"), method, isVitestItReference, true);
};
const testCallForMethod = (call, method, isVitestItReference) => {
  const callee = read(call, "callee");
  if (testMethodReference(callee, method, isVitestItReference)) return true;
  if (!isType(callee, "CallExpression")) return false;
  return appliedTestRegistrationFactory(read(callee, "callee"), method, isVitestItReference);
};
const isControlledClockAdjust = (node, namespaces) => {
  const callee = read(node, "callee");
  if (!allOf([isType(node, "CallExpression"), member(callee, "adjust")])) return false;
  const clock = read(callee, "object");
  const clockNamespace =
    read(read(clock, "property"), "name") === "TestClock" && isType(clock, "MemberExpression");
  const namespace = clockNamespace ? read(clock, "object") : clock;
  const name = read(namespace, "name");
  return allOf([namespaces.has(name), !isShadowedAtNode(namespace, name, { ignoreProgram: true })]);
};
const stableConstInitializerForBinding = (binding) => {
  const declarator = read(binding, "parent");
  const declaration = read(declarator, "parent");
  const isStableConst = allOf([
    isType(declarator, "VariableDeclarator"),
    read(declarator, "id") === binding,
    isType(declaration, "VariableDeclaration"),
    read(declaration, "kind") === "const",
    writeExpressionsForBinding(binding).length === 0,
  ]);
  return isStableConst ? read(declarator, "init") : undefined;
};
const stableConstAliasMatches = (node, matches) => {
  const resolve = (value, seen) => {
    if (matches(value)) return true;
    if (!isType(value, "Identifier")) return false;
    const binding = resolvedBindingIdentifier(value);
    if (binding === undefined || seen.has(binding)) return false;
    const initializer = stableConstInitializerForBinding(binding);
    return initializer !== undefined && resolve(initializer, new Set(seen).add(binding));
  };
  return resolve(node, new Set());
};
const unshadowedGlobalObjectNames = new Set(["globalThis", "global"]);
const isUnshadowedGlobalObject = (node) =>
  stableConstAliasMatches(
    node,
    (value) =>
      isType(value, "Identifier") &&
      unshadowedGlobalObjectNames.has(read(value, "name")) &&
      !isShadowedAtNode(value, read(value, "name")),
  );
const isGlobalObjectMember = (node, propertyName) =>
  allOf([
    isType(node, "MemberExpression"),
    staticMemberName(node) === propertyName,
    isUnshadowedGlobalObject(read(node, "object")),
  ]);
const isUnshadowedNativePromiseConstructor = (node) =>
  stableConstAliasMatches(node, (value) =>
    anyOf([
      allOf([id(value, "Promise"), !isShadowedAtNode(value, "Promise")]),
      isGlobalObjectMember(value, "Promise"),
    ]),
  );
const isGlobalObjectTimerCall = (callee, names = globalTimerApiNames) =>
  allOf([
    isType(callee, "MemberExpression"),
    names.has(staticMemberName(callee)),
    isUnshadowedGlobalObject(read(callee, "object")),
  ]);
const stableConstValueForBinding = (binding, readValue, seen) => {
  if (binding === undefined || seen.has(binding)) return undefined;
  const initializer = stableConstInitializerForBinding(binding);
  if (initializer === undefined) return undefined;
  return stableConstValueFor(initializer, readValue, new Set(seen).add(binding));
};
const stableConstValueFor = (node, readValue, seen = new Set()) => {
  const value = readValue(node);
  if (value !== undefined) return value;
  if (!isType(node, "Identifier")) return undefined;
  return stableConstValueForBinding(resolvedBindingIdentifier(node), readValue, seen);
};
const staticStringLiteralValue = (node) => {
  const value = literal(node);
  return typeof value === "string" ? value : undefined;
};
const staticStringForPolicy = (node, seen = new Set()) =>
  stableConstValueFor(node, staticStringLiteralValue, seen);
const enqueueAstChildren = (node, pending) =>
  Object.entries(node)
    .filter(([key]) => !["parent", "tokens", "comments"].includes(key))
    .forEach(([, value]) => pending.push(value));
const staticBooleanValue = (node) => {
  if (isType(node, "BooleanLiteral")) return read(node, "value");
  const value = literal(node);
  return typeof value === "boolean" ? value : undefined;
};
const staticBooleanValueForStableConst = (node, seen = new Set()) =>
  stableConstValueFor(node, staticBooleanValue, seen);
const reachableExecutionChildren = (node, booleanValue = staticBooleanValue) => {
  if (anyOf([isType(node, "IfStatement"), isType(node, "ConditionalExpression")])) {
    const condition = read(node, "test");
    const value = booleanValue(condition);
    if (value !== undefined) return [condition, read(node, value ? "consequent" : "alternate")];
  }
  return Object.entries(node)
    .filter(([key]) => !["parent", "tokens", "comments"].includes(key))
    .map(([, value]) => value);
};
const effectExecutionRoot = (rootNode, sleepNode, isEffectGenCallback) => {
  for (let current = sleepNode; current; current = read(current, "parent")) {
    if (isEffectGenCallback(current)) {
      return read(current, "body");
    }
  }
  return rootNode;
};
const isNestedFunctionBoundary = (node, rootNode) =>
  node !== rootNode &&
  anyOf([
    isType(node, "ArrowFunctionExpression"),
    isType(node, "FunctionExpression"),
    isType(node, "FunctionDeclaration"),
  ]);
const isAstObject = (node) => node !== null && typeof node === "object";
const isReachableExecutionNode = (node, rootNode) =>
  isAstObject(node) && !isNestedFunctionBoundary(node, rootNode);
const firstReachableExecutionNode = (rootNode, predicate) => {
  const pending = [rootNode];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isReachableExecutionNode(node, rootNode)) continue;
    if (predicate(node)) return node;
    pending.push(...reachableExecutionChildren(node));
  }
  return undefined;
};
const processVisitorAction = (action, node, pending) => {
  if (action === false) return false;
  if (action !== null) enqueueAstChildren(node, pending);
  return true;
};
const processWalkNode = (node, visit, pending) => {
  if (Array.isArray(node)) {
    pending.push(...node);
    return true;
  }
  if (!node || typeof node !== "object") return true;
  return processVisitorAction(visit(node), node, pending);
};
const walkAst = (rootNode, visit) => {
  const pending = [rootNode];
  while (pending.length > 0) if (!processWalkNode(pending.pop(), visit, pending)) return;
};
const isTagLiteralComparison = (node) =>
  allOf([
    isType(node, "BinaryExpression"),
    ["===", "==", "!==", "!="].includes(read(node, "operator")),
    anyOf([
      allOf([
        tagAccess(read(node, "left")),
        staticStringForPolicy(read(node, "right")) !== undefined,
      ]),
      allOf([
        tagAccess(read(node, "right")),
        staticStringForPolicy(read(node, "left")) !== undefined,
      ]),
    ]),
  ]);
const isStaticMemberProperty = (node, parent) =>
  allOf([
    isType(parent, "MemberExpression"),
    read(parent, "property") === node,
    !read(parent, "computed"),
  ]);
const isNonShorthandPropertyKey = (node, parent) =>
  allOf([
    isType(parent, "Property"),
    read(parent, "key") === node,
    !read(parent, "computed"),
    !read(parent, "shorthand"),
  ]);
const isIdentifierReference = (node, name, declarationIdentifier) =>
  allOf([
    isType(node, "Identifier"),
    read(node, "name") === name,
    node !== declarationIdentifier,
    !isBindingIdentifier(node),
    !isStaticMemberProperty(node, read(node, "parent")),
    !isNonShorthandPropertyKey(node, read(node, "parent")),
    !isNonReferenceName(node),
  ]);
const predicateFunctionNode = (node) =>
  anyOf([
    isType(node, "ArrowFunctionExpression"),
    isType(node, "FunctionExpression"),
    isType(node, "FunctionDeclaration"),
  ]);
const predicateFunctionBinding = (node) => {
  if (isType(node, "FunctionDeclaration")) return read(node, "id");
  const declaration = read(node, "parent");
  return allOf([
    isType(declaration, "VariableDeclarator"),
    read(declaration, "init") === node,
    isType(read(declaration, "id"), "Identifier"),
  ])
    ? read(declaration, "id")
    : undefined;
};
const predicateFunctionNodeForBinding = (binding) => {
  const declaration = read(binding, "parent");
  if (isType(declaration, "FunctionDeclaration") && read(declaration, "id") === binding)
    return declaration;
  if (!isType(declaration, "VariableDeclarator") || read(declaration, "id") !== binding)
    return undefined;
  const initializer = read(declaration, "init");
  return predicateFunctionNode(initializer) ? initializer : undefined;
};
const stablePredicateFunctionAliasBinding = (binding, seen) => {
  if (binding === undefined || seen.has(binding)) return undefined;
  const initializer = stableConstInitializerForBinding(binding);
  if (!isType(initializer, "Identifier")) return undefined;
  return localPredicateFunctionBinding(initializer, new Set(seen).add(binding));
};
const localPredicateFunctionBinding = (reference, seen = new Set()) => {
  if (!isType(reference, "Identifier")) return undefined;
  const binding = resolvedBindingIdentifier(reference);
  if (binding === undefined) return undefined;
  return predicateFunctionNodeForBinding(binding) !== undefined
    ? binding
    : stablePredicateFunctionAliasBinding(binding, seen);
};
const predicateFunctionCallTarget = (node) => {
  if (!isType(node, "CallExpression")) return undefined;
  return localPredicateFunctionBinding(read(node, "callee"));
};
const predicateLogicalRightIsUnreachable = (node) => {
  if (!isType(node, "LogicalExpression")) return false;
  const value = staticBooleanValueForStableConst(read(node, "left"));
  if (value === undefined) return false;
  return (read(node, "operator") === "&&" && !value) || (read(node, "operator") === "||" && value);
};
const predicateExecutionChildren = (node) => {
  const children = reachableExecutionChildren(node, staticBooleanValueForStableConst);
  return predicateLogicalRightIsUnreachable(node) ? [read(node, "left")] : children;
};
const enqueueCalledPredicateFunction = (binding, visited, pendingBodies) => {
  if (binding === undefined || visited.has(binding)) return;
  visited.add(binding);
  const body = read(predicateFunctionNodeForBinding(binding), "body");
  if (body !== undefined) pendingBodies.push(body);
};
const inspectPredicateFunctionCalls = (rootNode, visited, pendingBodies) => {
  const pending = [rootNode];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isReachableExecutionNode(node, rootNode)) continue;
    enqueueCalledPredicateFunction(predicateFunctionCallTarget(node), visited, pendingBodies);
    pending.push(...predicateExecutionChildren(node));
  }
};
const calledFunctionBindingsInBody = (rootNode) => {
  const visited = new Set();
  const pendingBodies = [rootNode];
  while (pendingBodies.length > 0)
    inspectPredicateFunctionCalls(pendingBodies.pop(), visited, pendingBodies);
  return visited;
};
const hasManualPredicateCheck = (rootNode) => {
  const found = { instance: false, tag: false };
  const calledBindings = calledFunctionBindingsInBody(rootNode);
  walkAst(rootNode, (node) => {
    if (node !== rootNode && predicateFunctionNode(node)) {
      const binding = predicateFunctionBinding(node);
      if (binding === undefined || !calledBindings.has(binding)) return null;
    }
    found.instance ||= allOf([
      isType(node, "BinaryExpression"),
      read(node, "operator") === "instanceof",
    ]);
    found.tag ||= isTagLiteralComparison(node);
    return allOf([found.instance, found.tag]) ? false : undefined;
  });
  return found;
};
const identifierUseCount = (rootNode, name, declaration) => {
  const declarationScope = predicateDeclarationScope(declaration);
  if (declarationScope === undefined) return 0;
  let count = 0;
  walkAst(rootNode, (node) => {
    if (
      isIdentifierReference(node, name, read(declaration, "id")) &&
      !hasAncestor(node, (ancestor) => ancestor === declaration) &&
      nearestBindingScope(node, name) === declarationScope
    )
      count += 1;
  });
  return count;
};
const isAttachedExport = (node) =>
  anyOf([
    isType(read(node, "parent"), "ExportNamedDeclaration"),
    isType(read(node, "parent"), "ExportDefaultDeclaration"),
    isType(read(read(node, "parent"), "parent"), "ExportNamedDeclaration"),
    isType(read(read(node, "parent"), "parent"), "ExportDefaultDeclaration"),
  ]);
const hasExportedBinding = (body, binding) =>
  binding !== undefined &&
  body.some((statement) =>
    anyOf([
      allOf([
        isType(statement, "ExportNamedDeclaration"),
        read(statement, "source") === null,
        (read(statement, "specifiers") ?? []).some(
          (specifier) => resolvedBindingIdentifier(read(specifier, "local")) === binding,
        ),
      ]),
      allOf([
        isType(statement, "ExportDefaultDeclaration"),
        resolvedBindingIdentifier(read(statement, "declaration")) === binding,
      ]),
    ]),
  );
const isExportedPredicate = (node, body) =>
  isAttachedExport(node) || hasExportedBinding(body, read(node, "id"));
const isTypePredicate = (node) => {
  const declaration = isType(node, "VariableDeclarator") ? read(node, "init") : node;
  return (
    read(read(read(declaration, "returnType"), "typeAnnotation"), "type") === "TSTypePredicate"
  );
};
const terminalStatement = (node) => {
  const body = read(node, "body");
  const statement = isType(node, "BlockStatement") ? body.at(-1) : node;
  return anyOf([isType(statement, "ReturnStatement"), isType(statement, "ThrowStatement")]);
};
const selectTaggedOperand = (node) =>
  tagAccess(read(node, "left")) ? read(node, "left") : read(node, "right");
const taggedStringValue = (node, tagged) =>
  tagged === read(node, "left")
    ? staticStringForPolicy(read(node, "right"))
    : staticStringForPolicy(read(node, "left"));
const taggedCase = (node, source) => {
  if (!isTagComparison(node)) return undefined;
  const tagged = selectTaggedOperand(node);
  const value = taggedStringValue(node, tagged);
  return allOf([tagged !== undefined, typeof value === "string"])
    ? { discriminant: source.getText(read(tagged, "object")).replace(/\s+/g, " "), value }
    : undefined;
};
const isTagComparison = (node) =>
  allOf([
    isType(node, "BinaryExpression"),
    ["===", "=="].includes(read(node, "operator")),
    anyOf([tagAccess(read(node, "left")), tagAccess(read(node, "right"))]),
  ]);
const taggedGuard = (node, source) => {
  if (!allOf([isType(node, "IfStatement"), terminalStatement(read(node, "consequent"))]))
    return undefined;
  const branch = taggedCase(read(node, "test"), source);
  return branch ? { ...branch, node } : undefined;
};
const directElseIfGuards = (node, source) => {
  const guards = [];
  for (let current = node; isType(current, "IfStatement"); ) {
    const guard = taggedGuard(current, source);
    if (!guard) return { guards, alternate: undefined, lastGuard: undefined };
    guards.push(guard);
    const alternate = read(current, "alternate");
    if (!isType(alternate, "IfStatement")) return { guards, alternate, lastGuard: guard };
    current = alternate;
  }
  return { guards, alternate: undefined, lastGuard: guards.at(-1) };
};
const hasBracedFallbackContext = (alternate, lastGuard) =>
  isType(alternate, "BlockStatement") && lastGuard !== undefined;
const collectBracedFallbackPrefix = (alternate, lastGuard, source) => {
  const guards = [];
  for (const statement of read(alternate, "body") ?? []) {
    const guard = taggedGuard(statement, source);
    if (!isSameTaggedDispatch(guard, lastGuard)) break;
    guards.push(guard);
  }
  return guards;
};
const bracedFallbackGuards = (alternate, lastGuard, source) =>
  hasBracedFallbackContext(alternate, lastGuard)
    ? collectBracedFallbackPrefix(alternate, lastGuard, source)
    : [];
const collectElseIfGuards = (node, source) => {
  const direct = directElseIfGuards(node, source);
  return [...direct.guards, ...bracedFallbackGuards(direct.alternate, direct.lastGuard, source)];
};
const collectSequentialGuards = (body, start, source) => {
  const first = taggedGuard(body[start], source);
  const guards = first ? [first, ...followingTaggedGuards(body, start + 1, first, source)] : [];
  return { guards, next: first ? start + guards.length : start + 1 };
};
const followingTaggedGuards = (body, start, first, source) => {
  const guards = [];
  for (let index = start; index < body.length; index += 1) {
    const candidate = taggedGuard(body[index], source);
    if (!isSameTaggedDispatch(candidate, first)) break;
    guards.push(candidate);
  }
  return guards;
};
const isSameTaggedDispatch = (candidate, first) =>
  allOf([candidate !== undefined, read(candidate, "discriminant") === read(first, "discriminant")]);
const contextFilename = (context) => context.filename ?? context.getFilename?.() ?? "";
const filename = (context) => {
  const value = contextFilename(context);
  return (path.isAbsolute(value) ? path.relative(root, value) : path.normalize(value))
    .split(path.sep)
    .join("/");
};
const fileIs = (context, relativePath) => filename(context) === relativePath;
const testFile = (context) => /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/.test(contextFilename(context));
const enclosingCall = (node, predicate) => {
  for (let current = node; current; current = current.parent)
    if (current.type === "CallExpression" && predicate(current)) return current;
  return undefined;
};
const hasAncestor = (node, predicate) => {
  for (let current = node; current; current = read(current, "parent"))
    if (predicate(current)) return true;
  return false;
};
const callbackAncestor = (node, predicate) => {
  const call = enclosingCall(node, predicate);
  if (!call) return false;
  const callback = call.arguments.find(
    (argument) =>
      argument?.type === "ArrowFunctionExpression" || argument?.type === "FunctionExpression",
  );
  for (let current = node; current; current = current.parent) if (current === callback) return true;
  return false;
};
const callbackFunction = (node, predicate) => {
  const call = enclosingCall(node, predicate);
  return call?.arguments.find(
    (argument) =>
      argument?.type === "ArrowFunctionExpression" || argument?.type === "FunctionExpression",
  );
};
const objectPatternBindingChild = (property) =>
  isType(property, "RestElement") ? read(property, "argument") : read(property, "value");
const patternChildReaders = {
  ObjectPattern: (pattern) => (read(pattern, "properties") ?? []).map(objectPatternBindingChild),
  ArrayPattern: (pattern) => read(pattern, "elements") ?? [],
  RestElement: (pattern) => [read(pattern, "argument")],
  AssignmentPattern: (pattern) => [read(pattern, "left")],
  TSParameterProperty: (pattern) => [read(pattern, "parameter")],
};
const objectPatternChildren = (pattern) => {
  if (pattern === null || typeof pattern !== "object") return [];
  const readChildren = patternChildReaders[read(pattern, "type")];
  if (readChildren === undefined) return [];
  return readChildren(pattern);
};
const patternChildren = (pattern) =>
  Array.isArray(pattern) ? pattern : objectPatternChildren(pattern);
const patternBindsName = (pattern, name) =>
  anyOf([
    allOf([isType(pattern, "Identifier"), read(pattern, "name") === name]),
    patternChildren(pattern).some((child) => patternBindsName(child, name)),
  ]);
const patternContainsNode = (pattern, target) =>
  pattern === target ||
  patternChildren(pattern).some((child) => patternContainsNode(child, target));
const isVariableBindingIdentifier = (node, parent) =>
  isType(parent, "VariableDeclarator") && patternContainsNode(read(parent, "id"), node);
const isFunctionBindingIdentifier = (node, parent) =>
  anyOf([
    isType(parent, "FunctionDeclaration"),
    isType(parent, "FunctionExpression"),
    isType(parent, "ArrowFunctionExpression"),
  ]) &&
  (read(parent, "id") === node ||
    (read(parent, "params") ?? []).some((parameter) => patternContainsNode(parameter, node)));
const isClassBindingIdentifier = (node, parent) =>
  anyOf([isType(parent, "ClassDeclaration"), isType(parent, "ClassExpression")]) &&
  read(parent, "id") === node;
const isCatchBindingIdentifier = (node, parent) =>
  isType(parent, "CatchClause") && patternContainsNode(read(parent, "param"), node);
const isImportBindingIdentifier = (node, parent) =>
  isType(parent, "ImportSpecifier") && read(parent, "local") === node;
const typeDeclarationNodes = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
  "TSTypeParameter",
]);
const isTypeBindingIdentifier = (node, parent) =>
  typeDeclarationNodes.has(read(parent, "type")) && read(parent, "id") === node;
const bindingIdentifierPredicates = {
  VariableDeclarator: isVariableBindingIdentifier,
  FunctionDeclaration: isFunctionBindingIdentifier,
  FunctionExpression: isFunctionBindingIdentifier,
  ArrowFunctionExpression: isFunctionBindingIdentifier,
  ClassDeclaration: isClassBindingIdentifier,
  ClassExpression: isClassBindingIdentifier,
  CatchClause: isCatchBindingIdentifier,
  ImportSpecifier: isImportBindingIdentifier,
  TSTypeAliasDeclaration: isTypeBindingIdentifier,
  TSInterfaceDeclaration: isTypeBindingIdentifier,
  TSEnumDeclaration: isTypeBindingIdentifier,
  TSModuleDeclaration: isTypeBindingIdentifier,
  TSTypeParameter: isTypeBindingIdentifier,
};
const isBindingIdentifierAt = (node, parent) =>
  bindingIdentifierPredicates[read(parent, "type")]?.(node, parent) ?? false;
const isBindingIdentifier = (node) => {
  for (let current = node; current?.parent; current = current.parent)
    if (isBindingIdentifierAt(node, current.parent)) return true;
  return false;
};
const isNonReferenceName = (node) => {
  const parent = read(node, "parent");
  return anyOf([
    allOf([isType(parent, "LabeledStatement"), read(parent, "label") === node]),
    allOf([
      anyOf([isType(parent, "BreakStatement"), isType(parent, "ContinueStatement")]),
      read(parent, "label") === node,
    ]),
    allOf([
      anyOf([
        isType(parent, "TSPropertySignature"),
        isType(parent, "TSMethodSignature"),
        isType(parent, "MethodDefinition"),
        isType(parent, "PropertyDefinition"),
      ]),
      read(parent, "key") === node,
      !read(parent, "computed"),
    ]),
    allOf([isType(parent, "TSQualifiedName"), read(parent, "right") === node]),
  ]);
};
const declarationIsVar = (declaration, parent) =>
  isType(declaration, "VariableDeclarator") && read(parent, "kind") === "var";
const isFunctionOrProgramScope = (scope) =>
  functionScopeTypes.has(read(scope, "type")) || isType(scope, "Program");
const declarationScopeMatchers = {
  lexical: (scope) => isBindingScope(scope),
  function: isFunctionOrProgramScope,
};
const firstMatchingScope = (node, matches) => {
  for (let current = node; current; current = read(current, "parent"))
    if (matches(current)) return current;
  return undefined;
};
const declarationParent = (declaration) => {
  const parent = read(declaration, "parent");
  return anyOf([
    isType(parent, "ExportNamedDeclaration"),
    isType(parent, "ExportDefaultDeclaration"),
  ])
    ? read(parent, "parent")
    : parent;
};
const predicateDeclarationScope = (declaration) => {
  const parent = read(declaration, "parent");
  const kind = declarationIsVar(declaration, parent) ? "function" : "lexical";
  return firstMatchingScope(declarationParent(declaration), declarationScopeMatchers[kind]);
};
const nearestBindingScope = (identifier, name) => {
  for (let current = read(identifier, "parent"); current; current = read(current, "parent"))
    if (isBindingScope(current) && scopeBindsName(current, name)) return current;
  return undefined;
};
const functionScopeTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);
const directDeclarationBinds = (statement, name, includeImports) => {
  const declaration =
    read(statement, "type") === "ExportNamedDeclaration"
      ? read(statement, "declaration")
      : statement;
  const binder = declarationBinders[read(declaration, "type")];
  return binder ? binder(declaration, name, includeImports) : false;
};
const bindsPatternDeclarations = (statement, name) =>
  statement.declarations.some((declaration) => patternBindsName(declaration.id, name));
const declarationBinders = {
  VariableDeclaration: bindsPatternDeclarations,
  FunctionDeclaration: (statement, name) => statement.id?.name === name,
  ClassDeclaration: (statement, name) => statement.id?.name === name,
  ImportDeclaration: (statement, name, includeImports) =>
    includeImports && statement.specifiers.some((specifier) => specifier.local.name === name),
};
const directStatementsBind = (statements, name, includeImports = false) =>
  statements?.some((statement) => directDeclarationBinds(statement, name, includeImports)) ?? false;
const isNestedBindingScope = (node) =>
  anyOf([
    functionScopeTypes.has(read(node, "type")),
    read(node, "type") === "ClassDeclaration",
    read(node, "type") === "ClassExpression",
  ]);
const isVarBinding = (node, name) =>
  allOf([
    isType(node, "VariableDeclaration"),
    read(node, "kind") === "var",
    (read(node, "declarations") ?? []).some((declaration) =>
      patternBindsName(read(declaration, "id"), name),
    ),
  ]);
const containsVarBinding = (node, name, root = node) => {
  let found = false;
  walkAst(node, (current) => {
    if (current !== root && isNestedBindingScope(current)) return null;
    if (!isVarBinding(current, name)) return;
    found = true;
    return false;
  });
  return found;
};
const functionScopeBinds = (scope, name) => {
  const body = read(scope, "body");
  const statements = isType(body, "BlockStatement") ? read(body, "body") : [];
  return anyOf([
    read(read(scope, "id"), "name") === name,
    read(scope, "params").some((parameter) => patternBindsName(parameter, name)),
    directStatementsBind(statements, name),
    containsVarBinding(body, name),
  ]);
};
const loopScopeBinds = (declaration, name) =>
  declaration?.type === "VariableDeclaration" &&
  declaration.declarations.some((item) => patternBindsName(item.id, name));
const scopeBinders = {
  Program: (scope, name) => directStatementsBind(scope.body, name, true),
  BlockStatement: (scope, name) => directStatementsBind(scope.body, name),
  CatchClause: (scope, name) =>
    patternBindsName(scope.param, name) || directStatementsBind(scope.body?.body, name),
  ForStatement: (scope, name) => loopScopeBinds(scope.init, name),
  ForInStatement: (scope, name) => loopScopeBinds(scope.left, name),
  ForOfStatement: (scope, name) => loopScopeBinds(scope.left, name),
  SwitchStatement: (scope, name) =>
    scope.cases.some((item) => directStatementsBind(item.consequent, name)),
  ClassDeclaration: (scope, name) => read(read(scope, "id"), "name") === name,
  ClassExpression: (scope, name) => read(read(scope, "id"), "name") === name,
};
const scopeBindsName = (scope, name) =>
  functionScopeTypes.has(scope.type)
    ? functionScopeBinds(scope, name)
    : (scopeBinders[scope.type]?.(scope, name) ?? false);
const isBoundBindingScope = (node, name) =>
  allOf([isBindingScope(node), scopeBindsName(node, name)]);
const isShadowedAtNode = (node, name, { ignoreProgram = false } = {}) => {
  for (let current = node; current; current = current.parent) {
    if (isIgnoredProgramBoundary(current, ignoreProgram)) return false;
    if (isBoundBindingScope(current, name)) return true;
  }
  return false;
};
const hasLocalTypeBinding = (node, name) => {
  for (let current = read(node, "parent"); current; current = read(current, "parent")) {
    if (hasLocalTypeBindingInScope(current, name)) return true;
    if (isType(current, "Program")) return false;
  }
  return false;
};
const hasLocalTypeBindingInScope = (scope, name) =>
  isLocalTypeBindingScope(scope) &&
  (read(scope, "body") ?? []).some((statement) => isNamedTypeBinding(statement, name));
const isLocalTypeBindingScope = (node) =>
  anyOf([isType(node, "BlockStatement"), isType(node, "Program"), isType(node, "TSModuleBlock")]);
const isNamedTypeBinding = (statement, name) =>
  [
    "TSTypeAliasDeclaration",
    "TSInterfaceDeclaration",
    "TSEnumDeclaration",
    "TSModuleDeclaration",
  ].includes(read(statement, "type")) && read(read(statement, "id"), "name") === name;
const isIgnoredProgramBoundary = (node, ignoreProgram) =>
  allOf([ignoreProgram, isType(node, "Program")]);
const bindingScopeTypes = new Set([
  "Program",
  "BlockStatement",
  "CatchClause",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "ClassDeclaration",
  "ClassExpression",
]);
const isBindingScope = (node) =>
  functionScopeTypes.has(node.type) || bindingScopeTypes.has(node.type);
const identifierFromPattern = (pattern, name) => {
  if (id(pattern, name)) return pattern;
  for (const child of patternChildren(pattern)) {
    const binding = identifierFromPattern(child, name);
    if (binding !== undefined) return binding;
  }
  return undefined;
};
const variableDeclarationBinding = (declaration, name) =>
  isType(declaration, "VariableDeclaration")
    ? (read(declaration, "declarations") ?? [])
        .map((item) => identifierFromPattern(read(item, "id"), name))
        .find((binding) => binding !== undefined)
    : undefined;
const importDeclarationBinding = (declaration, name, includeImports) =>
  includeImports && isType(declaration, "ImportDeclaration")
    ? (read(declaration, "specifiers") ?? [])
        .map((item) => read(item, "local"))
        .find((binding) => id(binding, name))
    : undefined;
const namedDeclarationBinding = (declaration, name) => {
  const idNode = read(declaration, "id");
  return id(idNode, name) ? idNode : undefined;
};
const declarationIdentifier = (statement, name, includeImports) => {
  const declaration = isType(statement, "ExportNamedDeclaration")
    ? read(statement, "declaration")
    : statement;
  return (
    variableDeclarationBinding(declaration, name) ??
    importDeclarationBinding(declaration, name, includeImports) ??
    namedDeclarationBinding(declaration, name)
  );
};
const blockScopeStatements = (scope) => read(scope, "body") ?? [];
const functionScopeStatements = (scope) => {
  const body = read(scope, "body");
  return isType(body, "BlockStatement") ? (read(body, "body") ?? []) : [];
};
const scopeStatementReaders = new Map([
  ["Program", blockScopeStatements],
  ["BlockStatement", blockScopeStatements],
  ["TSModuleBlock", blockScopeStatements],
  ...Array.from(functionScopeTypes, (type) => [type, functionScopeStatements]),
]);
const statementsInScope = (scope) => {
  return scopeStatementReaders.get(read(scope, "type"))?.(scope) ?? [];
};
const functionScopeBinding = (scope, name) => {
  const idNode = read(scope, "id");
  return (
    (id(idNode, name) ? idNode : undefined) ??
    (read(scope, "params") ?? [])
      .map((parameter) => identifierFromPattern(parameter, name))
      .find((binding) => binding !== undefined)
  );
};
const statementScopeBinding = (scope, name) =>
  statementsInScope(scope)
    .map((statement) => declarationIdentifier(statement, name, isType(scope, "Program")))
    .find((binding) => binding !== undefined);
const bindingIdentifierInScope = (scope, name) => {
  return functionScopeBinding(scope, name) ?? statementScopeBinding(scope, name);
};
const resolvedBindingIdentifier = (node) => {
  if (!isType(node, "Identifier")) return undefined;
  const scope = nearestBindingScope(node, read(node, "name"));
  return scope === undefined ? undefined : bindingIdentifierInScope(scope, read(node, "name"));
};
const effectApiImportSource = (statement) => {
  const source = read(read(statement, "source"), "value");
  return ["effect", "effect/Effect"].includes(source) ? source : undefined;
};
const isEffectApiValueImport = (statement, specifier, source) =>
  source !== undefined &&
  read(statement, "importKind") !== "type" &&
  read(specifier, "importKind") !== "type";
const isRootEffectNamespaceImport = (source, specifier) =>
  source === "effect" &&
  isType(specifier, "ImportSpecifier") &&
  read(read(specifier, "imported"), "name") === "Effect";
const effectApiNamespaceImportKind = (source, specifier) => {
  if (isType(specifier, "ImportNamespaceSpecifier")) {
    if (source === "effect") return "module";
    return "subpath-api";
  }
  return isRootEffectNamespaceImport(source, specifier) ? "root-api" : undefined;
};
const effectApiImport = (statement, specifier) => {
  const source = effectApiImportSource(statement);
  if (!isEffectApiValueImport(statement, specifier, source)) return undefined;
  const namespace = effectApiNamespaceImportKind(source, specifier);
  if (namespace !== undefined) return { namespace };
  if (!isType(specifier, "ImportSpecifier") || source !== "effect/Effect") return undefined;
  return { method: read(read(specifier, "imported"), "name") };
};
const registerEffectApiBinding = (statement, specifier, namespaces, methods) => {
  const imported = effectApiImport(statement, specifier);
  if (imported === undefined) return;
  const binding = read(specifier, "local");
  if (imported.namespace !== undefined) namespaces.set(binding, imported.namespace);
  if (imported.method !== undefined) methods.set(binding, imported.method);
};
const registerEffectApiImportDeclaration = (statement, namespaces, methods) => {
  for (const specifier of read(statement, "specifiers") ?? [])
    registerEffectApiBinding(statement, specifier, namespaces, methods);
};
const effectApiBindingsForProgram = (program) => {
  const namespaces = new Map();
  const methods = new Map();
  for (const statement of read(program, "body") ?? []) {
    if (isType(statement, "ImportDeclaration"))
      registerEffectApiImportDeclaration(statement, namespaces, methods);
  }
  return { namespaces, methods };
};
const createEffectApiResolver = (program) => {
  const { namespaces, methods } = effectApiBindingsForProgram(program);
  const apiNamespaceKinds = new Set(["root-api", "subpath-api"]);
  const namespaceKindForBinding = (binding, seen) => {
    if (binding === undefined || seen.has(binding)) return undefined;
    if (namespaces.has(binding)) return namespaces.get(binding);
    const initializer = stableConstInitializerForBinding(binding);
    return initializer === undefined
      ? undefined
      : namespaceKindForExpression(initializer, new Set(seen).add(binding));
  };
  const rootEffectNamespaceMemberKind = (node, seen) => {
    if (!isType(node, "MemberExpression") || staticMemberName(node) !== "Effect") return undefined;
    return namespaceKindForExpression(read(node, "object"), seen) === "module"
      ? "root-api"
      : undefined;
  };
  const namespaceKindForExpression = (node, seen = new Set()) =>
    isType(node, "Identifier")
      ? namespaceKindForBinding(resolvedBindingIdentifier(node), seen)
      : rootEffectNamespaceMemberKind(node, seen);
  const namespaceKind = (node) => namespaceKindForExpression(node);
  const methodForBinding = (binding, seen) => {
    if (binding === undefined || seen.has(binding)) return undefined;
    if (methods.has(binding)) return methods.get(binding);
    const initializer = stableConstInitializerForBinding(binding);
    return initializer === undefined
      ? undefined
      : methodForExpression(initializer, new Set(seen).add(binding));
  };
  const methodForMember = (node) => {
    if (!isType(node, "MemberExpression")) return undefined;
    const method = staticMemberName(node);
    if (typeof method !== "string") return undefined;
    return apiNamespaceKinds.has(namespaceKindForExpression(read(node, "object")))
      ? method
      : undefined;
  };
  const methodForExpression = (node, seen = new Set()) =>
    isType(node, "Identifier")
      ? methodForBinding(resolvedBindingIdentifier(node), seen)
      : methodForMember(node);
  const methodForCall = (call) =>
    isType(call, "CallExpression") ? methodForExpression(read(call, "callee")) : undefined;
  return {
    isEffectApiNamespace: (node) => apiNamespaceKinds.has(namespaceKind(node)),
    isRootEffectObjectNamespace: (node) => namespaceKind(node) === "root-api",
    isEffectModuleNamespace: (node) => namespaceKind(node) === "module",
    methodForCall,
    methodForCallee: methodForExpression,
  };
};
const destructuringWriteParentChecks = new Map([
  [
    "Property",
    (node, parent) =>
      read(parent, "value") === node && isType(read(parent, "parent"), "ObjectPattern"),
  ],
  ["AssignmentPattern", (node, parent) => read(parent, "left") === node],
  ["RestElement", (node, parent) => read(parent, "argument") === node],
  ["ArrayPattern", (node, parent) => (read(parent, "elements") ?? []).includes(node)],
  ["ObjectPattern", (node, parent) => (read(parent, "properties") ?? []).includes(node)],
]);
const destructuringWriteParent = (node, parent) =>
  destructuringWriteParentChecks.get(read(parent, "type"))?.(node, parent) ?? false;
const bindingWriteTargetNames = new Map([
  ["AssignmentExpression", "left"],
  ["UpdateExpression", "argument"],
  ["ForInStatement", "left"],
  ["ForOfStatement", "left"],
]);
const bindingWriteTargetForIdentifier = (identifier) => {
  let current = identifier;
  while (current !== undefined) {
    const parent = read(current, "parent");
    const target = bindingWriteTargetNames.get(read(parent, "type"));
    if (target !== undefined) return read(parent, target) === current ? parent : undefined;
    if (!destructuringWriteParent(current, parent)) return undefined;
    current = parent;
  }
  return undefined;
};
const bindingWriteExpressionsCache = new WeakMap();
const writeScanScopeForBinding = (binding) => {
  const name = read(binding, "name");
  const declaration = read(binding, "parent");
  return isType(declaration, "FunctionDeclaration") && read(declaration, "id") === binding
    ? (predicateDeclarationScope(declaration) ?? nearestBindingScope(binding, name))
    : nearestBindingScope(binding, name);
};
const writeExpressionsForBinding = (binding) => {
  if (binding === undefined) return [];
  if (bindingWriteExpressionsCache.has(binding)) return bindingWriteExpressionsCache.get(binding);
  const name = read(binding, "name");
  const scope = writeScanScopeForBinding(binding);
  if (scope === undefined) return [];
  const writes = new Set();
  walkAst(scope, (node) => {
    if (!isIdentifierReference(node, name, binding)) return;
    if (resolvedBindingIdentifier(node) !== binding) return;
    const write = bindingWriteTargetForIdentifier(node);
    if (write !== undefined) writes.add(write);
  });
  const result = Array.from(writes);
  bindingWriteExpressionsCache.set(binding, result);
  return result;
};
const bindingWriteStatementFor = (write, scope) => {
  const body = read(scope, "body");
  const boundary =
    functionScopeTypes.has(read(scope, "type")) && isType(body, "BlockStatement") ? body : scope;
  for (let current = write; current; current = read(current, "parent")) {
    const parent = read(current, "parent");
    if (parent === boundary) return current;
  }
  return undefined;
};
const functionOrProgramScopeFor = (node) =>
  firstMatchingScope(
    node,
    (scope) => functionScopeTypes.has(read(scope, "type")) || isType(scope, "Program"),
  );
const laterWriteThanReference = (write, reference, binding, scope) =>
  sharesFunctionExecutionScope(write, reference, binding) &&
  writeIsAfterReferenceInScope(write, reference, scope) === true;
const functionValuesForBindingWrite = (
  write,
  scope,
  initialFunctionForBinding,
  isFunctionNode,
  seen,
  writeCanAffectReference,
) => {
  if (!isType(write, "AssignmentExpression") || read(write, "operator") !== "=") return undefined;
  const statement = bindingWriteStatementFor(write, scope);
  const values = possibleFunctionValuesForExpression(
    read(write, "right"),
    initialFunctionForBinding,
    isFunctionNode,
    seen,
    read(write, "right"),
    writeCanAffectReference,
  );
  return {
    values,
    definite: isType(statement, "ExpressionStatement") && read(statement, "expression") === write,
  };
};
const functionValuesForBindingWrites = (
  writes,
  scope,
  initialFunctionForBinding,
  isFunctionNode,
  seen,
  binding,
  reference,
  writeCanAffectReference,
) => {
  const values = [];
  let opaqueWrite = false;
  for (const write of writes) {
    if (reference !== undefined && laterWriteThanReference(write, reference, binding, scope))
      continue;
    if (writeCanAffectReference && !writeCanAffectReference(write, reference, binding, scope))
      continue;
    const assigned = functionValuesForBindingWrite(
      write,
      scope,
      initialFunctionForBinding,
      isFunctionNode,
      seen,
      writeCanAffectReference,
    );
    if (assigned === undefined) {
      opaqueWrite = true;
      continue;
    }
    if (!assigned.definite || assigned.values.length === 0) opaqueWrite = true;
    values.push(...assigned.values);
  }
  return { values: Array.from(new Set(values)), opaqueWrite };
};
const possibleFunctionValuesForBinding = (
  binding,
  initialFunctionForBinding,
  isFunctionNode,
  seen = new Set(),
  reference,
  writeCanAffectReference,
) => {
  if (binding === undefined || seen.has(binding)) return [];
  const writes = writeExpressionsForBinding(binding);
  const scope = writeScanScopeForBinding(binding);
  if (scope === undefined) return [];
  const nextSeen = new Set(seen).add(binding);
  const writeValues = functionValuesForBindingWrites(
    writes,
    scope,
    initialFunctionForBinding,
    isFunctionNode,
    nextSeen,
    binding,
    reference,
    writeCanAffectReference,
  );
  if (writeValues.opaqueWrite) {
    const initial = initialFunctionForBinding(binding);
    if (initial !== undefined) writeValues.values.push(initial);
  }
  if (writeValues.values.length > 0) return Array.from(new Set(writeValues.values));
  const initial = initialFunctionForBinding(binding);
  return initial === undefined ? [] : [initial];
};
const possibleFunctionValuesForExpression = (
  value,
  initialFunctionForBinding,
  isFunctionNode,
  seen,
  reference = value,
  writeCanAffectReference,
) => {
  if (isFunctionNode(value)) return [value];
  if (isType(value, "Identifier"))
    return possibleFunctionValuesForBinding(
      resolvedBindingIdentifier(value),
      initialFunctionForBinding,
      isFunctionNode,
      seen,
      reference,
      writeCanAffectReference,
    );
  if (isType(value, "ConditionalExpression"))
    return Array.from(
      new Set(
        [read(value, "consequent"), read(value, "alternate")].flatMap((branch) =>
          possibleFunctionValuesForExpression(
            branch,
            initialFunctionForBinding,
            isFunctionNode,
            seen,
            reference,
            writeCanAffectReference,
          ),
        ),
      ),
    );
  if (isType(value, "LogicalExpression"))
    return Array.from(
      new Set(
        [read(value, "left"), read(value, "right")].flatMap((branch) =>
          possibleFunctionValuesForExpression(
            branch,
            initialFunctionForBinding,
            isFunctionNode,
            seen,
            reference,
            writeCanAffectReference,
          ),
        ),
      ),
    );
  return [];
};
const isWithinAstBranch = (node, branch, boundary) => {
  if (branch === undefined) return false;
  for (let current = node; current && current !== boundary; current = read(current, "parent"))
    if (read(current, "parent") === boundary) return current === branch;
  return false;
};
const isWithinUnselectedConditionalBranch = (node, conditional) => {
  const test = read(conditional, "test");
  const value = staticBooleanValueForStableConst(test);
  if (value === undefined || isWithinAstBranch(node, test, conditional)) return false;
  return !isWithinAstBranch(
    node,
    read(conditional, value ? "consequent" : "alternate"),
    conditional,
  );
};
const isWithinSkippedLogicalRight = (node, expression) => {
  const operator = read(expression, "operator");
  const value = staticBooleanValueForStableConst(read(expression, "left"));
  const rightIsSkipped =
    (operator === "&&" && value === false) || (operator === "||" && value === true);
  return rightIsSkipped && isWithinAstBranch(node, read(expression, "right"), expression);
};
const writeIsStaticallyUnreachable = (write) => {
  for (let current = write; current; current = read(current, "parent")) {
    if (
      (isType(current, "IfStatement") || isType(current, "ConditionalExpression")) &&
      isWithinUnselectedConditionalBranch(write, current)
    )
      return true;
    if (isType(current, "LogicalExpression") && isWithinSkippedLogicalRight(write, current))
      return true;
  }
  return false;
};
const repeatedExecutionStatementTypes = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);
const directStatementInBlockFor = (node, block) => {
  for (let current = node; current && current !== block; current = read(current, "parent"))
    if (read(current, "parent") === block) return current;
  return undefined;
};
const hasRepeatedExecutionBetween = (block, executionScope) => {
  for (
    let current = read(block, "parent");
    current && current !== executionScope;
    current = read(current, "parent")
  )
    if (repeatedExecutionStatementTypes.has(read(current, "type"))) return true;
  return false;
};
const nodeOrderInList = (nodes, referenceNode, writeNode) => {
  if (!Array.isArray(nodes)) return undefined;
  const referenceIndex = nodes.indexOf(referenceNode);
  const writeIndex = nodes.indexOf(writeNode);
  if (referenceIndex < 0 || writeIndex < 0 || referenceIndex === writeIndex) return undefined;
  return writeIndex > referenceIndex;
};
const statementOrderInScope = (write, reference, scope) =>
  nodeOrderInList(
    statementsInScope(scope),
    bindingWriteStatementFor(reference, scope),
    bindingWriteStatementFor(write, scope),
  );
const directExpressionInSequenceFor = (node, sequence) => {
  for (let current = node; current && current !== sequence; current = read(current, "parent"))
    if (read(current, "parent") === sequence) return current;
  return undefined;
};
const sequenceOrderInNestedExpression = (write, reference, executionScope) => {
  for (let sequence = read(reference, "parent"); sequence; sequence = read(sequence, "parent")) {
    if (!isType(sequence, "SequenceExpression")) continue;
    const referenceExpression = directExpressionInSequenceFor(reference, sequence);
    const writeExpression = directExpressionInSequenceFor(write, sequence);
    if (referenceExpression === undefined || writeExpression === undefined) continue;
    if (referenceExpression === writeExpression) return undefined;
    if (hasRepeatedExecutionBetween(sequence, executionScope)) return undefined;
    return nodeOrderInList(read(sequence, "expressions"), referenceExpression, writeExpression);
  }
  return undefined;
};
const conditionalBranchNodesAreExclusive = (first, second, conditional) => {
  if (!isType(conditional, "IfStatement") && !isType(conditional, "ConditionalExpression"))
    return false;
  const consequent = read(conditional, "consequent");
  const alternate = read(conditional, "alternate");
  return (
    (isWithinAstBranch(first, consequent, conditional) &&
      isWithinAstBranch(second, alternate, conditional)) ||
    (isWithinAstBranch(second, consequent, conditional) &&
      isWithinAstBranch(first, alternate, conditional))
  );
};
const writeAndReferenceAreInExclusiveBranches = (write, reference, executionScope) => {
  for (
    let conditional = read(write, "parent");
    conditional && conditional !== executionScope;
    conditional = read(conditional, "parent")
  ) {
    if (conditionalBranchNodesAreExclusive(write, reference, conditional))
      return !hasRepeatedExecutionBetween(conditional, executionScope);
  }
  return false;
};
const statementOrderInNestedBlock = (write, reference, executionScope) => {
  for (let block = read(reference, "parent"); block; block = read(block, "parent")) {
    if (isType(block, "BlockStatement")) {
      const referenceStatement = directStatementInBlockFor(reference, block);
      const writeStatement = directStatementInBlockFor(write, block);
      if (
        referenceStatement !== undefined &&
        writeStatement !== undefined &&
        referenceStatement !== writeStatement
      ) {
        if (hasRepeatedExecutionBetween(block, executionScope)) return undefined;
        return nodeOrderInList(read(block, "body"), referenceStatement, writeStatement);
      }
    }
    if (block === executionScope) break;
  }
  return undefined;
};
// Keep local-call values at their execution point; writes in other scopes stay conservative.
const sharesFunctionExecutionScope = (write, reference, binding) => {
  const executionScope = functionOrProgramScopeFor(reference);
  return (
    executionScope !== undefined &&
    executionScope === functionOrProgramScopeFor(writeScanScopeForBinding(binding)) &&
    executionScope === functionOrProgramScopeFor(write)
  );
};
const writeIsAfterReferenceInScope = (write, reference, scope) => {
  const scopeOrder = statementOrderInScope(write, reference, scope);
  if (scopeOrder !== undefined) return scopeOrder;
  const executionScope = functionOrProgramScopeFor(reference);
  const expressionOrder = sequenceOrderInNestedExpression(write, reference, executionScope);
  if (expressionOrder !== undefined) return expressionOrder;
  return statementOrderInNestedBlock(write, reference, executionScope);
};
const localFunctionWriteCanAffectReference = (write, reference, binding, scope) => {
  if (writeIsStaticallyUnreachable(write)) return false;
  if (reference === undefined || !sharesFunctionExecutionScope(write, reference, binding))
    return true;
  if (
    writeAndReferenceAreInExclusiveBranches(write, reference, functionOrProgramScopeFor(reference))
  )
    return false;
  const isAfterReference = writeIsAfterReferenceInScope(write, reference, scope);
  return isAfterReference === undefined || !isAfterReference;
};
const localFunctionNodesForBinding = (binding, reference, seen = new Set()) => {
  if (binding === undefined || seen.has(binding)) return [];
  const nextSeen = new Set(seen).add(binding);
  const isFunctionNode = (node) => functionScopeTypes.has(read(node, "type"));
  const initialFunctionForBinding = (candidate) => {
    const declaration = read(candidate, "parent");
    if (isType(declaration, "FunctionDeclaration") && read(declaration, "id") === candidate)
      return declaration;
    if (!isType(declaration, "VariableDeclarator") || read(declaration, "id") !== candidate)
      return undefined;
    const initializer = read(declaration, "init");
    if (isFunctionNode(initializer)) return initializer;
    return isType(initializer, "Identifier")
      ? localFunctionNodesForBinding(
          resolvedBindingIdentifier(initializer),
          initializer,
          nextSeen,
        )[0]
      : undefined;
  };
  const values = possibleFunctionValuesForBinding(
    binding,
    initialFunctionForBinding,
    isFunctionNode,
    seen,
    reference,
    localFunctionWriteCanAffectReference,
  );
  return values.flatMap((value) => {
    if (isFunctionNode(value)) return [value];
    if (isType(value, "Identifier"))
      return localFunctionNodesForBinding(resolvedBindingIdentifier(value), value, nextSeen);
    return [];
  });
};
const statementIndexesForNodes = (nodes, scope) => {
  const statements = statementsInScope(scope);
  const indexes = nodes.map((node) => statements.indexOf(bindingWriteStatementFor(node, scope)));
  return indexes.some((index) => index < 0) ? undefined : indexes;
};
const nodeWithinSourceRange = (node, first, second, firstIndex, secondIndex) => {
  const positions = [
    read(first, "start"),
    read(second, "start"),
    read(node, "start"),
    read(node, "end"),
    read(first, "end"),
    read(second, "end"),
  ];
  if (positions.some((position) => typeof position !== "number")) return true;
  const [firstStart, secondStart, nodeStart, nodeEnd, firstEnd, secondEnd] = positions;
  const firstComesBeforeSecond =
    firstIndex < secondIndex || (firstIndex === secondIndex && firstStart <= secondStart);
  const earlierEnd = firstComesBeforeSecond ? firstEnd : secondEnd;
  const laterStart = firstComesBeforeSecond ? secondStart : firstStart;
  return nodeStart >= earlierEnd && nodeEnd <= laterStart;
};
const nodeIsBetweenReferences = (node, first, second, scope) => {
  const indexes = statementIndexesForNodes([first, second, node], scope);
  if (indexes === undefined) return true;
  const [firstIndex, secondIndex, nodeIndex] = indexes;
  const lowerIndex = Math.min(firstIndex, secondIndex);
  const upperIndex = Math.max(firstIndex, secondIndex);
  if (nodeIndex > lowerIndex && nodeIndex < upperIndex) return true;
  if (nodeIndex !== lowerIndex && nodeIndex !== upperIndex) return false;
  return nodeWithinSourceRange(node, first, second, firstIndex, secondIndex);
};
const nestedFunctionForWrite = (write, scope) => {
  for (let current = write; current && current !== scope; current = read(current, "parent"))
    if (functionScopeTypes.has(read(current, "type"))) return current;
  return undefined;
};
const localFunctionsForCall = (call) => {
  const callee = read(call, "callee");
  if (functionScopeTypes.has(read(callee, "type"))) return [callee];
  if (!isType(callee, "Identifier")) return [];
  return localFunctionNodesForBinding(resolvedBindingIdentifier(callee), callee);
};
const reachableExecutionCalls = (rootNode) => {
  const pending = [rootNode];
  const calls = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isReachableExecutionNode(node, rootNode)) continue;
    if (isType(node, "CallExpression")) calls.push(node);
    pending.push(...reachableExecutionChildren(node));
  }
  return calls;
};
const localFunctionIsCalledBetween = (nestedFunction, first, second, scope) => {
  const pending = [scope];
  const visited = new Set();
  while (pending.length > 0) {
    const caller = pending.pop();
    if (visited.has(caller)) continue;
    visited.add(caller);
    for (const call of reachableExecutionCalls(caller)) {
      if (
        (caller === scope && !nodeIsBetweenReferences(call, first, second, scope)) ||
        writeIsStaticallyUnreachable(call)
      )
        continue;
      const callees = localFunctionsForCall(call);
      if (callees.includes(nestedFunction)) return true;
      pending.push(...callees);
    }
  }
  return false;
};
const writeCanSeparateAliasValues = (write, first, second, scope) => {
  if (writeIsStaticallyUnreachable(write)) return false;
  const nestedFunction = nestedFunctionForWrite(write, scope);
  return nestedFunction === undefined
    ? nodeIsBetweenReferences(write, first, second, scope)
    : localFunctionIsCalledBetween(nestedFunction, first, second, scope);
};
const typeDeclarationIdentifierInScope = (scope, name) =>
  statementsInScope(scope)
    .filter((statement) => isNamedTypeBinding(statement, name))
    .map((statement) => read(statement, "id"))[0];
const importedTypeIdentifierInProgram = (scope, name) => {
  if (!isType(scope, "Program")) return undefined;
  return (read(scope, "body") ?? [])
    .filter((statement) => isType(statement, "ImportDeclaration"))
    .flatMap((statement) => read(statement, "specifiers") ?? [])
    .map((specifier) => read(specifier, "local"))
    .find((binding) => id(binding, name));
};
const typeBindingIdentifierInScope = (scope, name) =>
  typeDeclarationIdentifierInScope(scope, name) ?? importedTypeIdentifierInProgram(scope, name);
const firstTypeBindingIdentifierInAncestors = (identifier, name) => {
  for (let scope = read(identifier, "parent"); scope; scope = read(scope, "parent")) {
    const binding = typeBindingIdentifierInScope(scope, name);
    if (binding !== undefined) return binding;
  }
  return undefined;
};
const resolvedTypeBindingIdentifier = (node) =>
  isType(node, "Identifier")
    ? firstTypeBindingIdentifierInAncestors(node, read(node, "name"))
    : undefined;
const report = (context, node, message) => context.report({ node, message });
export const consumeBaselineSite = (remaining, key) => {
  const count = remaining.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) remaining.delete(key);
  else remaining.set(key, count - 1);
  return true;
};
const semanticChildIndex = (siblings, index) =>
  siblings
    .slice(0, index)
    .filter(
      (item) =>
        item?.type !== "JSXExpressionContainer" || item.expression?.type !== "JSXEmptyExpression",
    ).length;
const pathSegment = (parent, key) => String(read(parent, "type")) + "." + String(key);
const directChildPathSegment = (parent, key, value, child) =>
  value === child ? pathSegment(parent, key) : undefined;
const anonymousSuiteCallForBody = (parent, key) => {
  if (!allOf([isType(parent, "BlockStatement"), key === "body"])) return undefined;
  const callback = read(parent, "parent");
  const call = read(callback, "parent");
  const callee = read(call, "callee");
  const isCallArgumentCallback = allOf([
    anyOf([isType(callback, "ArrowFunctionExpression"), isType(callback, "FunctionExpression")]),
    read(callback, "body") === parent,
    isType(call, "CallExpression"),
    (read(call, "arguments") ?? []).includes(callback),
  ]);
  return isCallArgumentCallback ? { call, callee } : undefined;
};
const isSuiteCallWithIdentity = (call, callee, options) =>
  options?.isSuiteCall?.(call) ?? isUnresolvedSuiteCall(callee);
const isAnonymousSuiteBody = (parent, key, options) => {
  const suiteCall = anonymousSuiteCallForBody(parent, key);
  if (suiteCall === undefined) return false;
  return isSuiteCallWithIdentity(suiteCall.call, suiteCall.callee, options);
};
const isUnresolvedSuiteName = (callee) => {
  const name = read(callee, "name");
  return (name === "describe" || name === "suite") && !isShadowedAtNode(callee, name);
};
const isUnresolvedSuiteCall = (callee) =>
  isType(callee, "Identifier") && isUnresolvedSuiteName(callee);
const isPathIndexFreeArray = (parent, key, options) =>
  anyOf([
    allOf([read(parent, "type") === "Program", key === "body"]),
    allOf([read(parent, "type") === "JSXElement", key === "children"]),
    allOf([options?.anonymousSuiteBodies === true, isAnonymousSuiteBody(parent, key, options)]),
  ]);
const arrayChildPathSegment = (parent, key, value, child, options) => {
  if (!Array.isArray(value)) return undefined;
  const index = value.indexOf(child);
  if (index < 0) return undefined;
  if (isPathIndexFreeArray(parent, key, options)) return pathSegment(parent, key);
  return pathSegment(parent, key) + "[" + String(semanticChildIndex(value, index)) + "]";
};
const childPathSegment = (parent, key, value, child, options) =>
  directChildPathSegment(parent, key, value, child) ??
  arrayChildPathSegment(parent, key, value, child, options);
const parentPathSegment = (parent, child, options) => {
  for (const [key, value] of Object.entries(parent)) {
    if (["parent", "tokens", "comments"].includes(key)) continue;
    const segment = childPathSegment(parent, key, value, child, options);
    if (segment) return segment;
  }
  return undefined;
};
const astPath = (node, options) => {
  const parts = [];
  for (let current = node; current?.parent; current = current.parent) {
    const segment = parentPathSegment(current.parent, current, options);
    if (segment) parts.unshift(segment);
  }
  return parts.join("/");
};
const inheritedPolicyComment = (comment) =>
  /^(?:\s*)(?:oxlint-disable-(?:line|next-line) (?:no-nested-ternary|typescript\/(?:no-unsafe-type-assertion|restrict-template-expressions))|oxlint-(?:disable|enable) typescript\/(?:no-unsafe-type-assertion|restrict-template-expressions)) -- inherited master site(?:\s*)$/.test(
    read(comment, "value") ?? "",
  );
const normalizedPolicyExpression = (source, node) => {
  const nodeRange = read(node, "range");
  if (!Array.isArray(nodeRange) || nodeRange.length !== 2)
    return source.getText(node).replace(/\s+/g, " ").trim();
  let text = source.getText(node);
  const comments = source
    .getAllComments()
    .filter((comment) => {
      const range = read(comment, "range");
      return (
        inheritedPolicyComment(comment) &&
        Array.isArray(range) &&
        range[0] >= nodeRange[0] &&
        range[1] <= nodeRange[1]
      );
    })
    .sort((left, right) => right.range[0] - left.range[0]);
  for (const comment of comments) {
    const [start, end] = comment.range;
    text = text.slice(0, start - nodeRange[0]) + " " + text.slice(end - nodeRange[0]);
  }
  return text.replace(/\s+/g, " ").trim();
};
const astFingerprint = (node) => {
  if (Array.isArray(node)) return node.map(astFingerprint);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.keys(node)
      .filter(
        (key) => !["parent", "tokens", "comments", "loc", "range", "start", "end"].includes(key),
      )
      .sort()
      .map((key) => [key, astFingerprint(node[key])]),
  );
};
const variableAnchor = (node) =>
  allOf([isType(node, "VariableDeclarator"), isType(read(node, "id"), "Identifier")])
    ? "variable:" + read(read(node, "id"), "name")
    : undefined;
const functionAnchor = (node) =>
  anyOf([isType(node, "FunctionDeclaration"), isType(node, "FunctionExpression")]) &&
  read(read(node, "id"), "name")
    ? "function:" + read(read(node, "id"), "name")
    : undefined;
const classAnchor = (node) =>
  isType(node, "ClassDeclaration") && read(read(node, "id"), "name")
    ? "class:" + read(read(node, "id"), "name")
    : undefined;
const memberAnchor = (node) =>
  allOf([
    anyOf([isType(node, "MethodDefinition"), isType(node, "Property")]),
    !read(node, "computed"),
    read(read(node, "key"), "name"),
  ])
    ? "member:" + read(read(node, "key"), "name")
    : undefined;
const anchorForNode = (node) =>
  variableAnchor(node) ?? functionAnchor(node) ?? classAnchor(node) ?? memberAnchor(node);
const namedAstAnchors = (node) => {
  const anchors = [];
  for (let current = node; current; current = current.parent) {
    const anchor = anchorForNode(current);
    if (anchor) anchors.push(anchor);
  }
  return anchors.reverse();
};
const isCallbackFunction = (node) =>
  anyOf([isType(node, "ArrowFunctionExpression"), isType(node, "FunctionExpression")]);
const callbackArguments = (node) => {
  const call = read(node, "parent");
  if (!isType(call, "CallExpression")) return undefined;
  const args = read(call, "arguments") ?? [];
  return args.includes(node) ? args : undefined;
};
const callbackLabels = (args, callbackIndex) =>
  args
    .slice(0, callbackIndex)
    .filter(
      (argument) => isType(argument, "Literal") && typeof read(argument, "value") === "string",
    )
    .map((argument) => read(argument, "value"));
const callbackSiteAnchor = (node) => {
  if (!isCallbackFunction(node)) return undefined;
  const args = callbackArguments(node);
  if (args === undefined) return undefined;
  const labels = callbackLabels(args, args.indexOf(node));
  return labels.length === 0 ? undefined : "callback:" + JSON.stringify(labels);
};
const enclosingCallbackAnchors = (node) => {
  const anchors = [];
  for (let current = node; current; current = read(current, "parent")) {
    const anchor = callbackSiteAnchor(current);
    if (anchor) anchors.push(anchor);
  }
  return anchors;
};
const policyCallbackAnchors = (node) => enclosingCallbackAnchors(node).reverse();
const siteIdentity = (node, source, options) =>
  String(astPath(node, options)) +
  "::" +
  JSON.stringify(namedAstAnchors(node)) +
  "::" +
  String(normalizedPolicyExpression(source, node));
const policySiteIdentity = (node, source, ruleName, additionalIdentity, identityOptions) => {
  const identity =
    ruleName === "effect-live-test"
      ? siteIdentity(node, source, { anonymousSuiteBodies: true, ...identityOptions })
      : siteIdentity(node, source);
  return ruleName === "effect-live-test"
    ? identity +
        "::callbacks:" +
        JSON.stringify(policyCallbackAnchors(node)) +
        "::test-sites:" +
        JSON.stringify(additionalIdentity ?? [])
    : identity;
};
const builtinSiteIdentityLegacy = (node, rule, source) => {
  const path = siteIdentity(node, source).split("::", 1)[0];
  const identity = JSON.stringify({
    rule,
    anchors: namedAstAnchors(node),
    path,
    ast: astFingerprint(node),
  });
  return createHash("sha256").update(identity).digest("hex");
};
const builtinSiteIdentity = (node, rule, source, identityOptions) => {
  const path = siteIdentity(node, source, {
    anonymousSuiteBodies: true,
    ...identityOptions,
  }).split("::", 1)[0];
  const identity = {
    rule,
    anchors: namedAstAnchors(node),
    path,
    ast: astFingerprint(node),
  };
  const callbacks = policyCallbackAnchors(node);
  if (callbacks.length > 0) identity.callbacks = callbacks;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
};
export const generatedRouteBuiltinSiteIdentity = (node, source) =>
  builtinSiteIdentity(node, "typescript/no-unsafe-type-assertion", source);
const builtinLineSiteNode = (node) => node;
const policyEntries = (context, ruleName) =>
  (baseline.$policy?.[filename(context)] ?? []).filter((entry) => entry.rule === ruleName);
const countPolicyEntries = (entries) => {
  const remaining = new Map();
  for (const { key } of entries) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  return remaining;
};
const reportPolicySite = (
  context,
  ruleName,
  remaining,
  node,
  message,
  additionalIdentity,
  identityOptions,
) => {
  const key = policySiteIdentity(
    node,
    context.getSourceCode(),
    ruleName,
    additionalIdentity,
    identityOptions,
  );
  if (process.env.TIARA_POLICY_BASELINE_MODE === "1") {
    const detail = JSON.stringify({ file: filename(context), rule: ruleName, key });
    report(context, node, "policybaseline:" + detail);
    return;
  }
  if (!consumeBaselineSite(remaining, key)) report(context, node, message);
};
const makePolicyReporter = (context, ruleName, additionalIdentity, identityOptions) => {
  const remaining = countPolicyEntries(policyEntries(context, ruleName));
  return (node, message) =>
    reportPolicySite(
      context,
      ruleName,
      remaining,
      node,
      message,
      additionalIdentity?.(node),
      identityOptions,
    );
};
const isNestedTernary = (node) =>
  anyOf([
    isType(read(node, "test"), "ConditionalExpression"),
    isType(read(node, "consequent"), "ConditionalExpression"),
    isType(read(node, "alternate"), "ConditionalExpression"),
  ]);
const reportNestedTernary = (context, remaining, source, node) => {
  const key = siteIdentity(node, source);
  if (process.env.TIARA_NESTED_TERNARY_BASELINE_MODE === "1") {
    const detail = JSON.stringify({ file: filename(context), key });
    report(context, node, "baseline:" + detail);
    return;
  }
  if (!consumeBaselineSite(remaining, key)) report(context, node, "nested");
};
const noNestedTernaryAdoption = {
  meta: {
    type: "problem",
    docs: { description: "reject nested ternaries beyond the inherited AST baseline" },
    schema: [],
    messages: {
      nested:
        "Avoid nested conditional expressions; inherited occurrences are tracked in the checked baseline.",
      orphan: "A nested-ternary baseline entry no longer has a matching site in this file.",
    },
  },
  create(context) {
    const remaining = new Map();
    for (const key of baseline[filename(context)] ?? [])
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    const source = context.getSourceCode();
    const reportOrphanBaselineEntries = (program) => {
      if (process.env.TIARA_NESTED_TERNARY_BASELINE_MODE === "1") return;
      const unused = [...remaining.values()].reduce((total, count) => total + count, 0);
      if (unused > 0) context.report({ node: program, messageId: "orphan" });
    };
    return {
      ConditionalExpression(node) {
        if (isNestedTernary(node)) reportNestedTernary(context, remaining, source, node);
      },
      "Program:exit": reportOrphanBaselineEntries,
    };
  },
};

const requirePredicateCombinators = {
  meta: {
    type: "suggestion",
    docs: { description: "use Effect Predicate for reusable tagged error predicates" },
    schema: [],
    messages: {
      predicate:
        "Reusable tagged-error predicates should compose Effect Predicate helpers instead of handwritten tag or instanceof checks.",
    },
  },
  create(context) {
    const reportPolicy = makePolicyReporter(context, "effect-predicate");
    const isExported = (node) => isExportedPredicate(node, context.getSourceCode().ast.body);
    const isTypeGuard = isTypePredicate;
    const isReusablePredicate = (node, name) =>
      isExported(node) || identifierUseCount(context.getSourceCode().ast, name, node) >= 2;
    const requiresPredicateCombinator = (node, name) => {
      const checks = hasManualPredicateCheck(node.body ?? node.init ?? node);
      return anyOf([
        checks.tag,
        allOf([checks.instance, anyOf([isTypeGuard(node), /(?:Error|Failure|Fault)$/.test(name)])]),
      ]);
    };
    const inspectPredicate = (node, name) =>
      allOf([
        anyOf([/^is[A-Z_$]/.test(name), isTypeGuard(node)]),
        isReusablePredicate(node, name),
      ]) && requiresPredicateCombinator(node, name)
        ? reportPolicy(node, "predicate")
        : undefined;
    const inspect = (node, name) => {
      inspectPredicate(node, name);
    };
    const isFunctionExpression = (node) =>
      anyOf([isType(node, "ArrowFunctionExpression"), isType(node, "FunctionExpression")]);
    return {
      FunctionDeclaration(node) {
        inspect(node, node.id?.name ?? "");
      },
      VariableDeclarator(node) {
        if (isFunctionExpression(read(node, "init")))
          inspect(node, read(read(node, "id"), "name") ?? "");
      },
    };
  },
};

const preferMatchForTaggedDispatch = {
  meta: {
    type: "suggestion",
    docs: { description: "use Effect Match for tagged union dispatch" },
    schema: [],
    messages: { match: "Multi-case tagged union dispatch should use Effect Match." },
  },
  create(context) {
    const reportPolicy = makePolicyReporter(context, "effect-match");
    const source = context.getSourceCode();
    const reported = new WeakSet();
    const reportDispatch = (node) => {
      if (!reported.has(node)) {
        reported.add(node);
        reportPolicy(node, "match");
      }
    };
    const isDispatch = (guards) => {
      if (guards.length < 3) return false;
      const discriminant = guards[0].discriminant;
      const caseNames = new Set(guards.map(({ value }) => value));
      return allOf([
        guards.every((guard) => guard.discriminant === discriminant),
        caseNames.size >= 3,
      ]);
    };
    const isElseIfContinuation = (node) =>
      allOf([
        isType(read(node, "parent"), "IfStatement"),
        read(read(node, "parent"), "alternate") === node,
      ]);
    const isTaggedDispatchRoot = (node) =>
      allOf([!isElseIfContinuation(node), isDispatch(collectElseIfGuards(node, source))]);
    return {
      SwitchStatement(node) {
        if (!tagAccess(node.discriminant)) return;
        const cases = node.cases;
        if (cases.length < 2) return;
        if (cases.every(({ consequent }) => terminalStatement(consequent.at(-1))))
          reportDispatch(node);
      },
      IfStatement(node) {
        if (isTaggedDispatchRoot(node)) reportDispatch(node);
      },
      BlockStatement(node) {
        let index = 0;
        while (index < node.body.length) {
          const run = collectSequentialGuards(node.body, index, source);
          const first = run.guards[0];
          if (first && isDispatch(run.guards)) reportDispatch(first.node);
          index = run.next;
        }
      },
    };
  },
};

const filesystemPromiseApis = new Set([
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "cp",
  "glob",
  "lchmod",
  "lchown",
  "link",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "mkdtempDisposable",
  "open",
  "opendir",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "watch",
  "writeFile",
]);
const liveApis = new Map([
  ["node:fs", nodeFileSystemApis],
  ["fs", nodeFileSystemApis],
  ["fs/promises", filesystemPromiseApis],
  ["node:fs/promises", filesystemPromiseApis],
  [
    "node:child_process",
    new Set(["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]),
  ],
  [
    "child_process",
    new Set(["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]),
  ],
  [
    "node:timers",
    new Set([
      "setTimeout",
      "setInterval",
      "setImmediate",
      "clearTimeout",
      "clearInterval",
      "clearImmediate",
    ]),
  ],
  [
    "timers",
    new Set([
      "setTimeout",
      "setInterval",
      "setImmediate",
      "clearTimeout",
      "clearInterval",
      "clearImmediate",
    ]),
  ],
  ["node:timers/promises", new Set(["setTimeout", "setInterval", "setImmediate", "scheduler"])],
  ["timers/promises", new Set(["setTimeout", "setInterval", "setImmediate", "scheduler"])],
]);
const forEachProgramImport = (program, visit) =>
  (read(program, "body") ?? [])
    .filter((statement) => isType(statement, "ImportDeclaration"))
    .forEach(visit);
const isEffectVitestImport = (node, specifier, type) =>
  allOf([read(node, "source").value === "@effect/vitest", isType(specifier, type)]);
const registerEffectVitestNamespace = (node, specifier, namespaces) => {
  if (isEffectVitestImport(node, specifier, "ImportNamespaceSpecifier"))
    namespaces.add(read(read(specifier, "local"), "name"));
};
const reportWhen = (node, predicate, reportNode) => {
  if (predicate(node)) reportNode(node);
};
const requireLiveInEffectTests = {
  meta: {
    type: "problem",
    docs: { description: "require it.live for real runtime APIs inside it.effect" },
    schema: [],
    messages: {
      live: "Real filesystem, subprocess, environment, and timer APIs inside it.effect require it.live.",
    },
  },
  create(context) {
    if (!testFile(context)) return {};
    const effectApi = createEffectApiResolver(context.getSourceCode().ast);
    const imports = new Map();
    const vitestImports = new Map();
    const vitestNamespaceImports = new Set();
    const suiteNamespaceImports = new Set();
    const suiteImportModes = new Map();
    const namespaceImports = new Map();
    const schedulerImports = new Map();
    const environmentImportBindings = new Set();
    const processAliases = new Set();
    const processEnvironmentBindings = new Map();
    const processEnvironmentBindingNodes = new Set();
    const processEnvironmentBindingsBeingChecked = new Set();
    const trackedProcessEnvironmentBindingFor = (node) => {
      const name = read(node, "name");
      const candidates = processEnvironmentBindings.get(name);
      const scope = nearestBindingScope(node, name);
      return scope === undefined ? undefined : candidates?.get(scope);
    };
    const isProcessEnvironmentBinding = (node) => {
      const binding = trackedProcessEnvironmentBindingFor(node);
      const scope = nearestBindingScope(node, read(node, "name"));
      if (binding === undefined) return false;
      if (processEnvironmentBindingsBeingChecked.has(binding)) return true;
      processEnvironmentBindingsBeingChecked.add(binding);
      const current = processEnvironmentBindingIsCurrent(binding, node, scope);
      processEnvironmentBindingsBeingChecked.delete(binding);
      return current;
    };
    const isImportedBinding = (binding) =>
      anyOf([
        isType(read(binding, "parent"), "ImportSpecifier"),
        isType(read(binding, "parent"), "ImportDefaultSpecifier"),
        isType(read(binding, "parent"), "ImportNamespaceSpecifier"),
      ]);
    const isGlobalIdentifierTimer = (callee) =>
      allOf([isType(callee, "Identifier"), globalTimerApiNames.has(read(callee, "name"))]) &&
      !isShadowedAtNode(callee, read(callee, "name"));
    const isGlobalTimerCall = (callee) =>
      anyOf([isGlobalIdentifierTimer(callee), isGlobalObjectTimerCall(callee)]);
    const importedDirectCall = (callee) => {
      const imported = runtimeImportedFunctionForIdentifier(callee);
      return allOf([
        isType(callee, "Identifier"),
        imported !== undefined,
        liveApis.get(read(imported, "source"))?.has(read(imported, "imported")) ?? false,
      ]);
    };
    const schedulerImportSource = (object, seen = new Set()) => {
      if (!isType(object, "Identifier")) return undefined;
      const binding = resolvedBindingIdentifier(object);
      if (binding === undefined || seen.has(binding)) return undefined;
      const name = read(binding, "name");
      if (isImportedBinding(binding)) return schedulerImports.get(name);
      const initializer = stableConstInitializerForBinding(binding);
      if (isType(initializer, "Identifier"))
        return schedulerImportSource(initializer, new Set(seen).add(binding));
      if (
        isType(initializer, "MemberExpression") &&
        staticMemberName(initializer) === "scheduler"
      ) {
        const source = namespaceImportSource(read(initializer, "object"));
        return ["node:timers/promises", "timers/promises"].includes(source) ? source : undefined;
      }
      return undefined;
    };
    const directNamespaceTarget = (callee, object) => ({
      apiName: staticMemberName(callee),
      namespace: object,
      throughPromises: false,
      schedulerMethod: false,
      methodName: staticMemberName(callee),
    });
    const promiseNamespaceTarget = (callee, object) => ({
      apiName: staticMemberName(callee),
      namespace: read(object, "object"),
      throughPromises: true,
      schedulerMethod: false,
      methodName: staticMemberName(callee),
    });
    const schedulerNamespaceTarget = (callee, object, schedulerSource) => ({
      apiName: "scheduler",
      namespace: schedulerSource === undefined ? read(object, "object") : object,
      throughPromises: false,
      schedulerMethod: true,
      schedulerSource,
      methodName: staticMemberName(callee),
    });
    const schedulerPropertyTarget = (callee, object) => schedulerNamespaceTarget(callee, object);
    const namespaceTargetBuilders = new Map([
      ["promises", promiseNamespaceTarget],
      ["scheduler", schedulerPropertyTarget],
    ]);
    const fallbackNamespaceTarget = (callee, object) => {
      const source = schedulerImportSource(object);
      return source === undefined
        ? directNamespaceTarget(callee, object)
        : schedulerNamespaceTarget(callee, object, source);
    };
    const namespaceCallTarget = (callee) => {
      const object = read(callee, "object");
      const builder = namespaceTargetBuilders.get(staticMemberName(object));
      return builder === undefined
        ? fallbackNamespaceTarget(callee, object)
        : builder(callee, object);
    };
    const namespaceImportSource = (namespace, seen = new Set()) => {
      if (!isType(namespace, "Identifier")) return undefined;
      const binding = resolvedBindingIdentifier(namespace);
      if (binding === undefined || seen.has(binding)) return undefined;
      if (isImportedBinding(binding)) return namespaceImports.get(read(binding, "name"));
      const initializer = stableConstInitializerForBinding(binding);
      const nextSeen = new Set(seen).add(binding);
      if (isType(initializer, "Identifier")) return namespaceImportSource(initializer, nextSeen);
      if (isType(initializer, "MemberExpression") && staticMemberName(initializer) === "promises") {
        const source = namespaceImportSource(read(initializer, "object"), nextSeen);
        return ["node:fs", "fs"].includes(source) ? source + "/promises" : undefined;
      }
      return undefined;
    };
    const runtimeImportedFunctionForExpression = (value, seen) => {
      if (isType(value, "Identifier")) return runtimeImportedFunctionForIdentifier(value, seen);
      if (!isType(value, "MemberExpression")) return undefined;
      const target = namespaceCallTarget(value);
      const source = namespaceImportSource(target.namespace);
      if (!isSupportedNamespaceApi(target, source)) return undefined;
      return { source: source ?? target.schedulerSource, imported: target.apiName };
    };
    const runtimeImportedFunctionForIdentifier = (identifier, seen = new Set()) => {
      if (!isType(identifier, "Identifier")) return undefined;
      const binding = resolvedBindingIdentifier(identifier);
      if (binding === undefined || seen.has(binding)) return undefined;
      if (isImportedBinding(binding)) return imports.get(read(binding, "name"));
      const initializer = stableConstInitializerForBinding(binding);
      if (initializer === undefined) return undefined;
      return runtimeImportedFunctionForExpression(initializer, new Set(seen).add(binding));
    };
    const supportsPromiseNamespace = (target, source) =>
      !target.throughPromises || ["node:fs", "fs"].includes(source);
    const isSupportedSchedulerWait = (target, source, apiNames) =>
      ["node:timers/promises", "timers/promises"].includes(source) &&
      apiNames?.has("scheduler") === true &&
      target.methodName === "wait";
    const isSupportedDirectNamespaceApi = (target, apiNames) =>
      apiNames !== undefined && apiNames.has(target.apiName);
    const namespaceHasLiveApi = (target, source) => {
      const apiNames = liveApis.get(source);
      if (target.schedulerMethod) return isSupportedSchedulerWait(target, source, apiNames);
      return isSupportedDirectNamespaceApi(target, apiNames);
    };
    const isSupportedNamespaceApi = (target, source) => {
      const resolvedSource = source ?? target.schedulerSource;
      if (resolvedSource === undefined) return false;
      if (!supportsPromiseNamespace(target, resolvedSource)) return false;
      return namespaceHasLiveApi(target, resolvedSource);
    };
    const importedNamespaceCall = (callee) => {
      if (!isType(callee, "MemberExpression")) return false;
      const target = namespaceCallTarget(callee);
      const source = namespaceImportSource(target.namespace);
      return isSupportedNamespaceApi(target, source);
    };
    const realCall = (node) => {
      const callee = node.callee;
      return (
        isGlobalTimerCall(callee) || importedDirectCall(callee) || importedNamespaceCall(callee)
      );
    };
    const isNamedVitestIt = (object) =>
      isType(object, "Identifier") &&
      vitestImports.get(read(object, "name")) === "it" &&
      !isShadowedAtNode(object, read(object, "name"), { ignoreProgram: true });
    const isNamespaceVitestIt = (object) => {
      if (!member(object, "it")) return false;
      const namespace = read(object, "object");
      if (!isType(namespace, "Identifier")) return false;
      const name = read(namespace, "name");
      return (
        vitestNamespaceImports.has(name) &&
        !isShadowedAtNode(namespace, name, { ignoreProgram: true })
      );
    };
    const isVitestItReference = (object) => isNamedVitestIt(object) || isNamespaceVitestIt(object);
    const isTestCall = (call, method) => testCallForMethod(call, method, isVitestItReference);
    const suiteCallModes = new Map([
      ["describe", "suite:describe"],
      ["suite", "suite:suite"],
    ]);
    const suiteModifierMethods = new Set(["only", "skip", "concurrent", "sequential", "shuffle"]);
    const suiteFactoryMethods = new Set(["each", "for", "runIf", "skipIf"]);
    const suiteMemberName = (callee) =>
      isType(callee, "MemberExpression") && !read(callee, "computed")
        ? read(read(callee, "property"), "name")
        : undefined;
    const globalSuiteMode = (callee, name) =>
      !isShadowedAtNode(callee, name) ? suiteCallModes.get(name) : undefined;
    const directSuiteMode = (callee) => {
      if (!isType(callee, "Identifier")) return undefined;
      const name = read(callee, "name");
      if (isShadowedAtNode(callee, name, { ignoreProgram: true })) return undefined;
      return suiteImportModes.get(name) ?? globalSuiteMode(callee, name);
    };
    const isLiveVitestNamespace = (namespace) => {
      if (!isType(namespace, "Identifier")) return false;
      const name = read(namespace, "name");
      return (
        suiteNamespaceImports.has(name) &&
        !isShadowedAtNode(namespace, name, { ignoreProgram: true })
      );
    };
    const namespaceSuiteMode = (callee) => {
      const memberName = suiteMemberName(callee);
      if (memberName === undefined) return undefined;
      return isLiveVitestNamespace(read(callee, "object"))
        ? suiteCallModes.get(memberName)
        : undefined;
    };
    const isSuiteFactoryCall = (node) =>
      isType(node, "CallExpression") &&
      suiteFactoryMethods.has(suiteMemberName(read(node, "callee")));
    const suiteCalleeMode = (callee) => {
      if (isType(callee, "Identifier")) return directSuiteMode(callee);
      if (isType(callee, "MemberExpression")) {
        const memberName = suiteMemberName(callee);
        if (suiteModifierMethods.has(memberName)) return suiteCalleeMode(read(callee, "object"));
        return namespaceSuiteMode(callee);
      }
      return isSuiteFactoryCall(callee)
        ? suiteCalleeMode(read(read(callee, "callee"), "object"))
        : undefined;
    };
    const suiteCallMode = (call) => {
      const callee = read(call, "callee");
      if (suiteFactoryMethods.has(suiteMemberName(callee))) return undefined;
      return suiteCalleeMode(callee);
    };
    const suiteModuleImport = (node) =>
      ["@effect/vitest", "vitest"].includes(read(node, "source").value);
    const registerSuiteAlias = (node, specifier) => {
      if (!suiteModuleImport(node)) return;
      if (isType(specifier, "ImportNamespaceSpecifier")) {
        suiteNamespaceImports.add(read(read(specifier, "local"), "name"));
        return;
      }
      if (
        allOf([
          isType(specifier, "ImportSpecifier"),
          suiteCallModes.has(read(read(specifier, "imported"), "name")),
        ])
      )
        suiteImportModes.set(
          read(read(specifier, "local"), "name"),
          "suite:" + read(read(specifier, "imported"), "name"),
        );
    };
    const testCallMode = (call) => {
      if (isTestCall(call, "effect")) return "effect";
      if (isTestCall(call, "live")) return "live";
      return suiteCallMode(call);
    };
    const executedEffectHelpers = new Set();
    const executedLiveHelpers = new Set();
    const registeredTestCalls = new Set();
    const functionNodeTypes = new Set([
      "ArrowFunctionExpression",
      "FunctionExpression",
      "FunctionDeclaration",
    ]);
    const functionExpressionTypes = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
    const isFunctionNode = (node) => functionNodeTypes.has(read(node, "type"));
    const variableFunctionForDefinition = (node) => {
      const parent = read(node, "parent");
      return read(parent, "init") === node && isType(read(parent, "id"), "Identifier")
        ? node
        : undefined;
    };
    const localFunctionForDefinition = (node) =>
      isType(node, "FunctionDeclaration") ? node : variableFunctionForDefinition(node);
    const functionDeclarationForBinding = (parent, binding) =>
      isType(parent, "FunctionDeclaration") && read(parent, "id") === binding ? parent : undefined;
    const variableFunctionForBinding = (parent, binding) => {
      if (!isType(parent, "VariableDeclarator") || read(parent, "id") !== binding) return undefined;
      const initializer = read(parent, "init");
      return functionExpressionTypes.has(read(initializer, "type")) ? initializer : undefined;
    };
    const helperFunctionForBinding = (binding) => {
      const parent = read(binding, "parent");
      return (
        functionDeclarationForBinding(parent, binding) ??
        variableFunctionForBinding(parent, binding)
      );
    };
    const localFunctionValueNodes = (binding, reference) =>
      possibleFunctionValuesForBinding(
        binding,
        helperFunctionForBinding,
        (node) => isCallbackFunction(node) || isType(node, "FunctionDeclaration"),
        new Set(),
        reference,
      );
    const localFunctionsForCall = (call) => {
      const callee = read(call, "callee");
      if (!isType(callee, "Identifier")) return [];
      return localFunctionValueNodes(resolvedBindingIdentifier(callee), callee);
    };
    const isEffectPromiseCall = (call) => effectApi.methodForCall(call) === "promise";
    const effectDataLastCallbackMethods = new Set(["map", "flatMap", "andThen", "tap"]);
    const effectOptionCallbackMethods = new Set(["try", "tryPromise"]);
    const effectOptionCallbackNames = new Set(["try", "catch"]);
    const effectMethodForCall = effectApi.methodForCall;
    const isFunctionValueArgument = (node) => {
      if (isCallbackFunction(node)) return true;
      if (!isType(node, "Identifier")) return false;
      return localFunctionValueNodes(resolvedBindingIdentifier(node), node).length > 0;
    };
    const isForEachOptionsArgument = (node) =>
      isType(node, "ObjectExpression") ||
      allOf([id(node, "undefined"), !isShadowedAtNode(node, "undefined")]) ||
      (isType(node, "Identifier") && effectOptionObjectForIdentifier(node) !== undefined);
    const isAppliedDataLastCall = (call) => {
      const parent = read(call, "parent");
      return isType(parent, "CallExpression") && read(parent, "callee") === call;
    };
    const isForEachDataLastArguments = (args) =>
      args.length === 1 ||
      (args.length === 2 && isFunctionValueArgument(args[0]) && isForEachOptionsArgument(args[1]));
    const isSingleAppliedFunctionCallbackCall = (call, args) =>
      (isAppliedDataLastCall(call) || isEffectPipeStageCall(call)) &&
      args.length === 1 &&
      isFunctionValueArgument(args[0]);
    const effectDataLastCallbackPositionsForCall = (call, method) => {
      if (!effectDataLastCallbackMethods.has(method)) return undefined;
      const args = read(call, "arguments");
      if (args.length !== 1) return undefined;
      return isSingleAppliedFunctionCallbackCall(call, args) ? [0] : [];
    };
    const forEachCallbackPositionsForCall = (call) => {
      if (!isAppliedDataLastCall(call)) return effectCallbackPositions.get("forEach");
      if (isForEachDataLastArguments(read(call, "arguments"))) return [0];
      return [];
    };
    const effectCallbackPositionsForCall = (call, method) => {
      if (method === "forEach") return forEachCallbackPositionsForCall(call);
      const positions = effectDataLastCallbackPositionsForCall(call, method);
      return positions === undefined ? effectCallbackPositions.get(method) : positions;
    };
    const effectCallbackArgument = (call, argument) => {
      const method = effectMethodForCall(call);
      if (method === undefined) return false;
      const positions = effectCallbackPositionsForCall(call, method);
      if (positions === undefined) return false;
      return positions.includes((read(call, "arguments") ?? []).indexOf(argument));
    };
    const isEffectOptionCallbackProperty = (property) =>
      isType(property, "Property") && read(property, "kind") === "init";
    const effectOptionCallbackPropertyName = (property) => {
      if (!isEffectOptionCallbackProperty(property)) return undefined;
      const key = read(property, "key");
      if (read(property, "computed")) return literal(key);
      return isType(key, "Identifier") ? read(key, "name") : literal(key);
    };
    const effectOptionCallbackProperties = (call) => {
      if (!effectOptionCallbackMethods.has(effectMethodForCall(call))) return [];
      const options = (read(call, "arguments") ?? [])[0];
      return effectOptionCallbackPropertiesFromOptions(options);
    };
    const isStaticEffectOptionProperty = (property) => {
      if (!isEffectOptionCallbackProperty(property)) return false;
      const key = read(property, "key");
      return !read(property, "computed") || typeof literal(key) === "string";
    };
    const isConstObjectBinding = (binding) => {
      const declarator = read(binding, "parent");
      const declaration = read(declarator, "parent");
      return (
        isType(declarator, "VariableDeclarator") &&
        read(declarator, "id") === binding &&
        isType(declaration, "VariableDeclaration") &&
        read(declaration, "kind") === "const"
      );
    };
    const effectOptionObjectForIdentifier = (options, seen = new Set()) => {
      if (!isType(options, "Identifier")) return undefined;
      const binding = resolvedBindingIdentifier(options);
      if (!isConstObjectBinding(binding) || seen.has(binding)) return undefined;
      const declarator = read(binding, "parent");
      const initializer = read(declarator, "init");
      const nextSeen = new Set(seen).add(binding);
      if (isType(initializer, "ObjectExpression"))
        return { object: initializer, bindings: [binding] };
      if (isType(initializer, "Identifier")) {
        const nested = effectOptionObjectForIdentifier(initializer, nextSeen);
        return nested === undefined
          ? undefined
          : { object: nested.object, bindings: [binding, ...nested.bindings] };
      }
      return undefined;
    };
    const effectOptionObjectForArgument = (options) => {
      if (isType(options, "ObjectExpression")) return { object: options, bindings: [] };
      if (isType(options, "Identifier")) return effectOptionObjectForIdentifier(options);
      return undefined;
    };
    const effectOptionBindingStability = new Map();
    const effectOptionBindingsBeingChecked = new Set();
    const effectOptionConsumerReference = (reference) => {
      const call = read(reference, "parent");
      return (
        isType(call, "CallExpression") &&
        (read(call, "arguments") ?? [])[0] === reference &&
        effectOptionCallbackMethods.has(effectMethodForCall(call))
      );
    };
    const effectOptionReferenceIsMemberObject = (reference, parent) =>
      allOf([isType(parent, "MemberExpression"), read(parent, "object") === reference]);
    const effectOptionPropertyAccessForReference = (reference) => {
      let access = reference;
      let parent = read(access, "parent");
      if (!effectOptionReferenceIsMemberObject(access, parent)) return undefined;
      access = parent;
      parent = read(access, "parent");
      while (effectOptionReferenceIsMemberObject(access, parent)) {
        access = parent;
        parent = read(access, "parent");
      }
      return access;
    };
    const effectOptionPropertyWriteTargetNames = new Map([
      ["AssignmentExpression", "left"],
      ["UpdateExpression", "argument"],
      ["UnaryExpression", "argument"],
    ]);
    const effectOptionPropertyWriteTarget = (parent) => {
      const type = read(parent, "type");
      return type === "UnaryExpression" && read(parent, "operator") !== "delete"
        ? undefined
        : read(parent, effectOptionPropertyWriteTargetNames.get(type));
    };
    const effectOptionDestructuringChildProperties = new Map([
      ["AssignmentPattern", "left"],
      ["RestElement", "argument"],
    ]);
    const effectOptionDestructuringChildrenProperties = new Map([
      ["ArrayPattern", "elements"],
      ["ObjectPattern", "properties"],
    ]);
    const effectOptionDestructuringParent = (node, parent) => {
      const objectPattern = read(parent, "parent");
      if (
        allOf([
          isType(parent, "Property"),
          read(parent, "value") === node,
          isType(objectPattern, "ObjectPattern"),
          (read(objectPattern, "properties") ?? []).includes(parent),
        ])
      ) {
        return objectPattern;
      }
      const childProperty = effectOptionDestructuringChildProperties.get(read(parent, "type"));
      if (childProperty !== undefined && read(parent, childProperty) === node) return parent;
      const childrenProperty = effectOptionDestructuringChildrenProperties.get(
        read(parent, "type"),
      );
      if (childrenProperty !== undefined && (read(parent, childrenProperty) ?? []).includes(node))
        return parent;
      return undefined;
    };
    const effectOptionAssignmentTarget = (parent, target) =>
      allOf([
        isType(parent, "AssignmentExpression"),
        read(parent, "operator") === "=",
        read(parent, "left") === target,
      ]) ||
      allOf([
        anyOf([isType(parent, "ForInStatement"), isType(parent, "ForOfStatement")]),
        read(parent, "left") === target,
      ]);
    const effectOptionPropertyAccessIsDestructuredWrite = (access) => {
      let target = access;
      while (true) {
        const parent = read(target, "parent");
        if (effectOptionAssignmentTarget(parent, target)) return true;
        const pattern = effectOptionDestructuringParent(target, parent);
        if (pattern === undefined) return false;
        target = pattern;
      }
    };
    const effectOptionPropertyAccessIsWritten = (access) =>
      effectOptionPropertyWriteTarget(read(access, "parent")) === access ||
      effectOptionPropertyAccessIsDestructuredWrite(access);
    const effectOptionPropertyAccessIsCalled = (access) => {
      const parent = read(access, "parent");
      return isType(parent, "CallExpression") && read(parent, "callee") === access;
    };
    const effectOptionPropertyAccessIsReadOnly = (reference) => {
      const access = effectOptionPropertyAccessForReference(reference);
      return (
        access !== undefined &&
        !effectOptionPropertyAccessIsWritten(access) &&
        !effectOptionPropertyAccessIsCalled(access)
      );
    };
    const effectOptionBindingReference = (node, binding, name) =>
      allOf([
        isIdentifierReference(node, name, binding),
        resolvedBindingIdentifier(node) === binding,
      ]);
    const effectOptionAliasBindingForReference = (reference, binding, name) => {
      if (!effectOptionBindingReference(reference, binding, name)) return undefined;
      const declarator = read(reference, "parent");
      const declaration = read(declarator, "parent");
      return allOf([
        isType(declarator, "VariableDeclarator"),
        read(declarator, "init") === reference,
        isType(read(declarator, "id"), "Identifier"),
        isType(declaration, "VariableDeclaration"),
        read(declaration, "kind") === "const",
      ])
        ? read(declarator, "id")
        : undefined;
    };
    const effectOptionSpreadSourceReference = (reference, binding, name) => {
      const spread = read(reference, "parent");
      return allOf([
        effectOptionBindingReference(reference, binding, name),
        isType(spread, "SpreadElement"),
        read(spread, "argument") === reference,
        isType(read(spread, "parent"), "ObjectExpression"),
      ]);
    };
    const effectOptionBindingIsExported = (binding) => {
      const declaration = read(read(binding, "parent"), "parent");
      if (isType(read(declaration, "parent"), "ExportNamedDeclaration")) return true;
      return (context.getSourceCode().ast.body ?? []).some(
        (statement) =>
          isType(statement, "ExportNamedDeclaration") &&
          read(statement, "source") === null &&
          (read(statement, "specifiers") ?? []).some(
            (specifier) => resolvedBindingIdentifier(read(specifier, "local")) === binding,
          ),
      );
    };
    // Consumers, const aliases, object spreads, and read-only property access cannot replace callbacks.
    const effectOptionBindingReferenceIsStable = (node, binding, name) => {
      if (!effectOptionBindingReference(node, binding, name)) return true;
      const alias = effectOptionAliasBindingForReference(node, binding, name);
      return (
        effectOptionConsumerReference(node) ||
        effectOptionPropertyAccessIsReadOnly(node) ||
        effectOptionSpreadSourceReference(node, binding, name) ||
        (alias !== undefined && effectOptionBindingIsStable(alias))
      );
    };
    const effectOptionBindingIsStable = (binding) => {
      if (effectOptionBindingStability.has(binding))
        return effectOptionBindingStability.get(binding);
      if (binding === undefined || effectOptionBindingsBeingChecked.has(binding)) return false;
      effectOptionBindingsBeingChecked.add(binding);
      const name = read(binding, "name");
      const scope = nearestBindingScope(binding, name);
      if (scope === undefined) {
        effectOptionBindingsBeingChecked.delete(binding);
        effectOptionBindingStability.set(binding, false);
        return false;
      }
      let stable = !effectOptionBindingIsExported(binding);
      if (stable)
        walkAst(scope, (node) => {
          if (effectOptionBindingReferenceIsStable(node, binding, name)) return;
          stable = false;
          return false;
        });
      effectOptionBindingsBeingChecked.delete(binding);
      effectOptionBindingStability.set(binding, stable);
      return stable;
    };
    const effectOptionBindingsAreStable = (bindings) =>
      Array.from(bindings).every(effectOptionBindingIsStable);
    const unknownEffectOptionProperty = Symbol("unknown-effect-option-property");
    const effectiveEffectOptionCallbackProperties = (properties) => {
      const effectiveCallbacks = new Map();
      for (const property of properties) {
        if (property === unknownEffectOptionProperty) {
          for (const name of effectOptionCallbackNames) effectiveCallbacks.set(name, undefined);
          continue;
        }
        const name = effectOptionCallbackPropertyName(property);
        if (effectOptionCallbackNames.has(name)) effectiveCallbacks.set(name, property);
      }
      return Array.from(effectiveCallbacks.values()).filter((property) => property !== undefined);
    };
    const effectOptionSpreadProperties = (argument, seen) => {
      if (isType(argument, "ObjectExpression"))
        return effectOptionPropertiesForObject(argument, seen);
      if (!isType(argument, "Identifier"))
        return { properties: [unknownEffectOptionProperty], bindings: [] };
      const source = effectOptionObjectForIdentifier(argument);
      if (source === undefined) return { properties: [unknownEffectOptionProperty], bindings: [] };
      const expanded = effectOptionPropertiesForObject(source.object, seen);
      return {
        properties: expanded.properties,
        bindings: [...source.bindings, ...expanded.bindings],
      };
    };
    const effectOptionPropertiesForProperty = (property, seen) => {
      if (isType(property, "SpreadElement"))
        return effectOptionSpreadProperties(read(property, "argument"), seen);
      if (!isStaticEffectOptionProperty(property))
        return { properties: [unknownEffectOptionProperty], bindings: [] };
      return { properties: [property], bindings: [] };
    };
    const effectOptionPropertiesForObject = (object, seen = new Set()) => {
      if (!isType(object, "ObjectExpression") || seen.has(object))
        return { properties: [unknownEffectOptionProperty], bindings: [] };
      const nextSeen = new Set(seen).add(object);
      const properties = [];
      const bindings = [];
      for (const property of read(object, "properties") ?? []) {
        const expanded = effectOptionPropertiesForProperty(property, nextSeen);
        if (expanded === undefined) {
          properties.push(unknownEffectOptionProperty);
          continue;
        }
        properties.push(...expanded.properties);
        bindings.push(...expanded.bindings);
      }
      return { properties, bindings };
    };
    const effectOptionCallbackPropertiesFromOptions = (options) => {
      const object = effectOptionObjectForArgument(options);
      if (object === undefined) return [];
      const expanded = effectOptionPropertiesForObject(object.object);
      const bindings = new Set([...object.bindings, ...expanded.bindings]);
      if (!effectOptionBindingsAreStable(bindings)) return [];
      return effectiveEffectOptionCallbackProperties(expanded.properties);
    };
    const isEffectOptionCallbackFunction = (node) => {
      if (!isCallbackFunction(node)) return false;
      const property = read(node, "parent");
      const options = read(property, "parent");
      const call = read(options, "parent");
      return effectOptionCallbackProperties(call).some(
        (candidate) => read(candidate, "value") === node,
      );
    };
    const effectOptionCallbackFunctionNodesForProperty = (property) => {
      const value = read(property, "value");
      if (isCallbackFunction(value)) return [value];
      return isType(value, "Identifier")
        ? localFunctionValueNodes(resolvedBindingIdentifier(value), value)
        : [];
    };
    const effectOptionCallbackFunctionsForCall = (call) =>
      effectOptionCallbackProperties(call).flatMap(effectOptionCallbackFunctionNodesForProperty);
    const parameterForArgument = (helper, call, argument) => {
      const index = (read(call, "arguments") ?? []).indexOf(argument);
      const parameter = (read(helper, "params") ?? [])[index];
      return isType(parameter, "Identifier") ? parameter : undefined;
    };
    const parameterReference = (node, parameter) =>
      isType(node, "Identifier") && resolvedBindingIdentifier(node) === parameter;
    const effectOptionObjectReceivesParameter = (call, argument, parameter) => {
      if (argument !== (read(call, "arguments") ?? [])[0]) return false;
      return effectOptionCallbackProperties(call).some((property) =>
        parameterReference(read(property, "value"), parameter),
      );
    };
    const effectCallbackReceivesParameter = (call, argument, parameter) =>
      (parameterReference(argument, parameter) && effectCallbackArgument(call, argument)) ||
      effectOptionObjectReceivesParameter(call, argument, parameter);
    const localParameterForwarding = (call, argument, parameter) => {
      if (!parameterReference(argument, parameter)) return undefined;
      return localFunctionsForCall(call)
        .map((helper) => ({ helper, parameter: parameterForArgument(helper, call, argument) }))
        .filter((forwarding) => forwarding.parameter !== undefined);
    };
    const forwardedParameterExecutes = (call, argument, parameter, ancestors) => {
      if (effectCallbackReceivesParameter(call, argument, parameter)) return true;
      const forwardings = localParameterForwarding(call, argument, parameter);
      return (
        forwardings !== undefined &&
        forwardings.some((forwarding) =>
          parameterIsInvoked(forwarding.helper, forwarding.parameter, ancestors),
        )
      );
    };
    const callExecutesParameter = (call, parameter, ancestors) => {
      if (!isType(call, "CallExpression")) return false;
      if (parameterReference(read(call, "callee"), parameter)) return true;
      return (read(call, "arguments") ?? []).some((argument) =>
        forwardedParameterExecutes(call, argument, parameter, ancestors),
      );
    };
    const parameterBodyVisitor = (parameter, ancestors, setInvoked) => (node) => {
      if (isFunctionNode(node)) return null;
      if (!callExecutesParameter(node, parameter, ancestors)) return undefined;
      setInvoked();
      return false;
    };
    const parameterIsInvoked = (helper, parameter, ancestors = new Set()) => {
      if (ancestors.has(helper)) return false;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(helper);
      let invoked = false;
      walkAst(
        read(helper, "body"),
        parameterBodyVisitor(parameter, nextAncestors, () => {
          invoked = true;
        }),
      );
      return invoked;
    };
    const localCallExecutesArgument = (call, argument) => {
      return localFunctionsForCall(call).some((helper) => {
        const parameter = parameterForArgument(helper, call, argument);
        return parameter !== undefined && parameterIsInvoked(helper, parameter);
      });
    };
    const effectPromiseThunkFunctionNodesForCall = (call) => {
      if (!isEffectPromiseCall(call)) return [];
      const thunk = (read(call, "arguments") ?? [])[0];
      return isType(thunk, "Identifier")
        ? localFunctionValueNodes(resolvedBindingIdentifier(thunk), thunk)
        : [];
    };
    const isExecutedCallArgument = (call, argument) =>
      effectCallbackArgument(call, argument) || localCallExecutesArgument(call, argument);
    const isCallArgumentFunction = (node) => {
      const parent = read(node, "parent");
      return (
        isType(parent, "CallExpression") &&
        (read(parent, "arguments") ?? []).includes(node) &&
        isExecutedCallArgument(parent, node)
      );
    };
    const isImmediatelyCalledFunction = (node) => {
      const parent = read(node, "parent");
      return isType(parent, "CallExpression") && read(parent, "callee") === node;
    };
    const isUnshadowedPromiseConstruction = (node) => {
      const callee = read(node, "callee");
      return allOf([isType(node, "NewExpression"), isUnshadowedNativePromiseConstructor(callee)]);
    };
    const isPromiseExecutorFunction = (node) => {
      const construction = read(node, "parent");
      return (
        isFunctionNode(node) &&
        isUnshadowedPromiseConstruction(construction) &&
        (read(construction, "arguments") ?? [])[0] === node
      );
    };
    const promiseExecutorFunctionNodesForValue = (executor, seen = new Set()) => {
      if (isCallbackFunction(executor) || isType(executor, "FunctionDeclaration"))
        return [executor];
      if (!isType(executor, "Identifier")) return [];
      const binding = resolvedBindingIdentifier(executor);
      if (binding === undefined || seen.has(binding)) return [];
      const nextSeen = new Set(seen).add(binding);
      const initializer = stableConstInitializerForBinding(binding);
      return initializer === undefined
        ? localFunctionValueNodes(binding, executor)
        : promiseExecutorFunctionNodesForValue(initializer, nextSeen);
    };
    const promiseExecutorFunctionNodesForConstruction = (construction) =>
      isUnshadowedPromiseConstruction(construction)
        ? promiseExecutorFunctionNodesForValue((read(construction, "arguments") ?? [])[0])
        : [];
    const isTransparentFunction = (node) =>
      anyOf([
        isCallArgumentFunction(node),
        isPromiseExecutorFunction(node),
        isEffectOptionCallbackFunction(node),
        isImmediatelyCalledFunction(node),
      ]);
    const skipFunctionBody = (node) => isFunctionNode(node) && !isTransparentFunction(node);
    const executedCallbackHelperNodesForArgument = (call, argument) => {
      if (!isType(argument, "Identifier") || !isExecutedCallArgument(call, argument)) return [];
      return localFunctionValueNodes(resolvedBindingIdentifier(argument), argument);
    };
    const unvisitedLocalHelpersForInvocation = (invocation, executed) => {
      const isCall = isType(invocation, "CallExpression");
      const isPromiseConstruction = isUnshadowedPromiseConstruction(invocation);
      if (!isCall && !isPromiseConstruction) return [];
      const args = read(invocation, "arguments") ?? [];
      const helpers = [
        ...(isCall ? localFunctionsForCall(invocation) : []),
        ...(isCall ? effectPromiseThunkFunctionNodesForCall(invocation) : []),
        ...promiseExecutorFunctionNodesForConstruction(invocation),
        ...(isCall
          ? args.flatMap((argument) => executedCallbackHelperNodesForArgument(invocation, argument))
          : []),
        ...(isCall ? effectOptionCallbackFunctionsForCall(invocation) : []),
      ];
      return [...new Set(helpers)].filter((helper) => !executed.has(helper));
    };
    const visitExecutedBody = (rootNode, executed) =>
      walkAst(rootNode, (node) => {
        if (skipFunctionBody(node)) return null;
        const helpers = unvisitedLocalHelpersForInvocation(node, executed);
        if (helpers.length === 0) return undefined;
        for (const helper of helpers) {
          executed.add(helper);
          visitExecutedBody(read(helper, "body"), executed);
        }
        return undefined;
      });
    const registeredTestMode = (node) => {
      if (isTestCall(node, "effect")) return "effect";
      if (isTestCall(node, "live")) return "live";
      return undefined;
    };
    const executedHelpersForMode = (mode) =>
      mode === "effect" ? executedEffectHelpers : executedLiveHelpers;
    const visitRegisteredTestCallback = (node, mode) => {
      const executed = executedHelpersForMode(mode);
      (read(node, "arguments") ?? [])
        .flatMap(callbackFunctionNodesForArgument)
        .forEach((callback) => {
          executed.add(callback);
          visitExecutedBody(read(callback, "body"), executed);
        });
    };
    const registerTestCall = (node) => {
      const mode = registeredTestMode(node);
      if (mode === undefined) return false;
      registeredTestCalls.add(node);
      visitRegisteredTestCallback(node, mode);
      return true;
    };
    const registerSuiteCallbacks = (node) => {
      if (suiteCallMode(node) === undefined) return false;
      (read(node, "arguments") ?? [])
        .flatMap(callbackFunctionNodesForArgument)
        .forEach((callback) => visitTestRegistrations(read(callback, "body")));
      return true;
    };
    const registeredTestOrSuiteCall = (node) =>
      registerTestCall(node) || registerSuiteCallbacks(node);
    const suiteCallNameForIdentifier = (callee) =>
      ["describe", "suite"].find((name) => id(callee, name));
    const shadowedSuiteCallName = (node) => {
      const callee = read(node, "callee");
      const name = suiteCallNameForIdentifier(callee);
      if (name === undefined) return undefined;
      return isShadowedAtNode(callee, name) ? name : undefined;
    };
    const callbackFunctionNodesForArgument = (argument) => {
      if (isCallbackFunction(argument)) return [argument];
      return isType(argument, "Identifier")
        ? localFunctionValueNodes(resolvedBindingIdentifier(argument), argument)
        : [];
    };
    const shadowedSuiteCallbacks = (node) => {
      if (shadowedSuiteCallName(node) === undefined) return undefined;
      if (localFunctionsForCall(node).length === 0) return [];
      return (read(node, "arguments") ?? []).flatMap((argument) =>
        localCallExecutesArgument(node, argument) ? callbackFunctionNodesForArgument(argument) : [],
      );
    };
    const visitShadowedSuiteCallbacks = (node) => {
      const callbacks = shadowedSuiteCallbacks(node);
      if (callbacks === undefined) return undefined;
      callbacks.forEach((callback) => visitTestRegistrations(read(callback, "body")));
      return callbacks.length > 0 ? null : undefined;
    };
    const visitCallRegistration = (node) =>
      registeredTestOrSuiteCall(node) ? null : visitShadowedSuiteCallbacks(node);
    const visitRegistrationNode = (node) => {
      if (isFunctionNode(node)) return null;
      if (!isType(node, "CallExpression")) return undefined;
      return visitCallRegistration(node);
    };
    const visitTestRegistrations = (rootNode) => walkAst(rootNode, visitRegistrationNode);
    const isRegisteredTestCall = (call) => call !== undefined && registeredTestCalls.has(call);
    const callbackContainsNode = (callback, node) =>
      callback !== undefined && hasAncestor(node, (ancestor) => ancestor === callback);
    const registeredTestCallForNode = (node, mode) => {
      const call = enclosingCall(node, (candidate) => isTestCall(candidate, mode));
      if (!isRegisteredTestCall(call)) return undefined;
      const callback = (read(call, "arguments") ?? []).find(isCallbackFunction);
      return callbackContainsNode(callback, node) ? { call, callback } : undefined;
    };
    const functionBoundaryReached = (node, executed) => {
      if (executed.has(node)) return true;
      const helper = localFunctionForDefinition(node);
      return helper === undefined ? isTransparentFunction(node) : executed.has(helper);
    };
    const functionBoundariesBetween = (node, stop) => {
      const boundaries = [];
      for (let current = node; current; current = read(current, "parent")) {
        if (current === stop) break;
        if (isFunctionNode(current)) boundaries.push(current);
      }
      return boundaries;
    };
    const reachesTestThroughHelpers = (node, callback, executed) =>
      functionBoundariesBetween(node, callback).find(
        (boundary) => !functionBoundaryReached(boundary, executed),
      ) === undefined;
    const firstOpaqueFunctionBoundary = (node) => {
      for (let current = node; current; current = read(current, "parent")) {
        if (!isFunctionNode(current)) continue;
        if (!isTransparentFunction(current)) return current;
      }
      return undefined;
    };
    const reachesTestOutsideCallback = (node, executed) => {
      const boundary = firstOpaqueFunctionBoundary(node);
      const helper = localFunctionForDefinition(boundary);
      return executed.has(boundary) || (helper !== undefined && executed.has(helper));
    };
    const isEffectTest = (node) => {
      const test = registeredTestCallForNode(node, "effect");
      return test !== undefined
        ? reachesTestThroughHelpers(node, test.callback, executedEffectHelpers)
        : reachesTestOutsideCallback(node, executedEffectHelpers);
    };
    const isLiveTest = (node) => {
      const test = registeredTestCallForNode(node, "live");
      return test !== undefined
        ? reachesTestThroughHelpers(node, test.callback, executedLiveHelpers)
        : reachesTestOutsideCallback(node, executedLiveHelpers);
    };
    const testCallLabels = (call) => {
      const args = read(call, "arguments") ?? [];
      const callbackIndex = args.findIndex(isCallbackFunction);
      return callbackIndex < 0 ? [] : callbackLabels(args, callbackIndex);
    };
    const sameTestCallSite = (call, mode, labels) =>
      isType(call, "CallExpression") &&
      testCallMode(call) === mode &&
      JSON.stringify(testCallLabels(call)) === JSON.stringify(labels);
    const hasSameLabelSuiteSibling = (call, mode, labels) => {
      const container = read(read(call, "parent"), "parent");
      return (read(container, "body") ?? []).some((statement) => {
        const sibling = read(statement, "expression");
        return sibling !== call && sameTestCallSite(sibling, mode, labels);
      });
    };
    const includesSuiteOccurrence = (call, mode, labels) =>
      !mode.startsWith("suite:") || hasSameLabelSuiteSibling(call, mode, labels);
    const testCallSiblingIndex = (call, mode, labels) => {
      const container = read(read(call, "parent"), "parent");
      const siblings = read(container, "body") ?? [];
      const index = siblings.findIndex((statement) => read(statement, "expression") === call);
      if (index < 0) return -1;
      return siblings
        .slice(0, index)
        .filter((statement) => sameTestCallSite(read(statement, "expression"), mode, labels))
        .length;
    };
    const callbackIdentityForMode = (call, mode) => {
      if (mode === undefined) return undefined;
      const labels = testCallLabels(call);
      if (!includesSuiteOccurrence(call, mode, labels)) return undefined;
      return { mode, labels, sibling: testCallSiblingIndex(call, mode, labels) };
    };
    const callbackIdentityEntry = (node) => {
      if (!isType(node, "CallExpression")) return undefined;
      return callbackIdentityForMode(node, testCallMode(node));
    };
    const testCallbackSiteIdentity = (node) => {
      const calls = [];
      for (let current = node; current; current = read(current, "parent")) {
        const entry = callbackIdentityEntry(current);
        if (entry !== undefined) calls.push(entry);
      }
      return calls.reverse();
    };
    const reportPolicy = makePolicyReporter(context, "effect-live-test", testCallbackSiteIdentity, {
      isSuiteCall: (call) => suiteCallMode(call) !== undefined,
    });
    const isBaselineLiveTest = (node) =>
      process.env.TIARA_POLICY_BASELINE_MODE === "1" && isLiveTest(node);
    const isEnvironmentAliasReference = (node) => {
      if (!isType(node, "Identifier")) return false;
      const binding = resolvedBindingIdentifier(node);
      return (
        environmentImportBindings.has(binding) ||
        (processEnvironmentBindingNodes.has(binding) && isProcessEnvironmentBinding(node))
      );
    };
    const isImportedEnvironmentAccess = (node) => isEnvironmentAliasReference(node.object);
    const isImportedProcessAlias = (object) =>
      processAliases.has(read(object, "name")) &&
      !isShadowedAtNode(object, read(object, "name"), { ignoreProgram: true });
    const isProcessGlobal = (object) =>
      id(object, "process") && !isShadowedAtNode(object, "process");
    const isGlobalObjectProcess = (object) => isGlobalObjectMember(object, "process");
    const isDirectProcessEnvironmentObject = (object) =>
      anyOf([
        isImportedProcessAlias(object),
        isProcessGlobal(object),
        isGlobalObjectProcess(object),
      ]);
    const isProcessEnvironmentObject = (object, seen = new Set()) => {
      if (isDirectProcessEnvironmentObject(object)) return true;
      if (!isType(object, "Identifier")) return false;
      const binding = resolvedBindingIdentifier(object);
      if (binding === undefined || seen.has(binding)) return false;
      const initializer = stableConstInitializerForBinding(binding);
      return (
        initializer !== undefined &&
        isProcessEnvironmentObject(initializer, new Set(seen).add(binding))
      );
    };
    const isProcessEnvironmentAccess = (node) =>
      staticMemberName(node) === "env" && isProcessEnvironmentObject(read(node, "object"));
    const isEnvironmentAccess = (node) =>
      isImportedEnvironmentAccess(node) || isProcessEnvironmentAccess(node);
    const isEnvironmentPropertyKey = (node) =>
      allOf([
        isType(read(node, "parent"), "Property"),
        read(read(node, "parent"), "key") === node,
        isPropertyKeyNameOnly(read(node, "parent"), node),
        !read(read(node, "parent"), "computed"),
      ]);
    const isPropertyKeyNameOnly = (parent, node) =>
      read(parent, "value") !== node || !read(parent, "shorthand");
    const isEnvironmentIdentifier = (node) =>
      allOf([
        isEnvironmentAliasReference(node),
        !isBindingIdentifier(node),
        bindingWriteTargetForIdentifier(node) === undefined,
        !isNonReferenceName(node),
        !isEnvironmentPropertyKey(node),
        !isStaticMemberProperty(node, read(node, "parent")),
        !allOf([
          isType(read(node, "parent"), "MemberExpression"),
          read(read(node, "parent"), "object") === node,
        ]),
      ]);
    const isBaselineRuntimeCall = (node) => isBaselineLiveTest(node) && realCall(node);
    const isEffectRuntimeCall = (node) => isEffectTest(node) && realCall(node);
    const shouldReportRuntimeCall = (node) =>
      isBaselineRuntimeCall(node) || isEffectRuntimeCall(node);
    const isBaselineEnvironmentMember = (node) =>
      isBaselineLiveTest(node) && isEnvironmentAccess(node);
    const isEffectEnvironmentMember = (node) => isEnvironmentAccess(node) && isEffectTest(node);
    const shouldReportEnvironmentMember = (node) =>
      isBaselineEnvironmentMember(node) || isEffectEnvironmentMember(node);
    const isBaselineEnvironmentIdentifier = (node) =>
      isBaselineLiveTest(node) && isEnvironmentIdentifier(node);
    const isEffectEnvironmentIdentifier = (node) =>
      isEnvironmentIdentifier(node) && isEffectTest(node);
    const shouldReportEnvironmentIdentifier = (node) =>
      isBaselineEnvironmentIdentifier(node) || isEffectEnvironmentIdentifier(node);
    const sourceIsProcess = (node) =>
      anyOf([
        read(read(node, "source"), "value") === "node:process",
        read(read(node, "source"), "value") === "process",
      ]);
    const processObjectInBinding = (node) =>
      isProcessEnvironmentObject(node) || isGlobalObjectProcess(node);
    const environmentPropertyBinding = (property) =>
      isType(property, "Property") ? environmentBindingFromProperty(property) : [];
    const processEnvironmentPatternChildren = new Map([
      ["AssignmentPattern", (pattern) => [read(pattern, "left")]],
      ["RestElement", (pattern) => [read(pattern, "argument")]],
      [
        "ObjectPattern",
        (pattern) =>
          (read(pattern, "properties") ?? []).map(
            (property) => read(property, "value") ?? read(property, "argument"),
          ),
      ],
      ["ArrayPattern", (pattern) => read(pattern, "elements") ?? []],
    ]);
    const processEnvironmentChildrenFor = (pattern) => {
      const children = processEnvironmentPatternChildren.get(read(pattern, "type"));
      return children === undefined ? [] : children(pattern);
    };
    const processEnvironmentPatternBindings = (pattern) => {
      const bindings = [];
      const pending = [pattern];
      while (pending.length > 0) {
        const current = pending.pop();
        if (isType(current, "Identifier")) bindings.push(current);
        else pending.push(...processEnvironmentChildrenFor(current));
      }
      return bindings;
    };
    const environmentBindingFromProperty = (property) =>
      staticPropertyKeyName(property) === "env"
        ? processEnvironmentPatternBindings(read(property, "value"))
        : [];
    const staticPropertyKeyName = (property) => {
      const key = read(property, "key");
      if (read(property, "computed") === true) return staticStringForPolicy(key);
      if (isType(key, "Identifier")) return read(key, "name");
      return literal(key);
    };
    const registerProcessEnvironmentProperties = (pattern) =>
      (read(pattern, "properties") ?? []).forEach((property) => {
        environmentPropertyBinding(property).forEach(registerProcessEnvironmentBinding);
      });
    const registerProcessEnvironmentPattern = (pattern) =>
      processEnvironmentPatternBindings(pattern).forEach(registerProcessEnvironmentBinding);
    const isImportedProcessEnvironmentBinding = (value) => {
      if (!isType(value, "Identifier")) return false;
      const binding = resolvedBindingIdentifier(value);
      const specifier = read(binding, "parent");
      return allOf([
        isType(specifier, "ImportSpecifier"),
        read(read(specifier, "imported"), "name") === "env",
        sourceIsProcess(read(specifier, "parent")),
      ]);
    };
    const isProcessEnvironmentAlias = (value, seen = new Set()) => {
      if (isProcessEnvironmentAccess(value) || isImportedProcessEnvironmentBinding(value))
        return true;
      if (!isType(value, "Identifier")) return false;
      if (isProcessEnvironmentBinding(value)) return true;
      const binding = resolvedBindingIdentifier(value);
      if (binding === undefined || seen.has(binding)) return false;
      const initializer = stableConstInitializerForBinding(binding);
      return (
        initializer !== undefined &&
        isProcessEnvironmentAlias(initializer, new Set(seen).add(binding))
      );
    };
    const registerDestructuredProcessEnvironment = (node) => {
      const pattern = read(node, "id");
      const init = read(node, "init");
      if (isType(pattern, "Identifier") && isProcessEnvironmentAlias(init)) {
        registerProcessEnvironmentBinding(pattern);
        return;
      }
      if (!isType(pattern, "ObjectPattern")) return;
      if (processObjectInBinding(init)) {
        registerProcessEnvironmentProperties(pattern);
        return;
      }
      if (isProcessEnvironmentAlias(init)) registerProcessEnvironmentPattern(pattern);
    };
    const registerProcessEnvironmentBinding = (binding) => {
      if (binding === undefined) return;
      const name = read(binding, "name");
      const scope = nearestBindingScope(binding, name);
      if (scope === undefined) return;
      const bindings = processEnvironmentBindings.get(name) ?? new Map();
      bindings.set(scope, binding);
      processEnvironmentBindings.set(name, bindings);
      processEnvironmentBindingNodes.add(binding);
    };
    const processEnvironmentAliasValueForAssignment = (write, binding) => {
      if (!isType(write, "AssignmentExpression") || read(write, "operator") !== "=")
        return undefined;
      const left = read(write, "left");
      if (resolvedBindingIdentifier(left) !== binding) return undefined;
      const right = read(write, "right");
      if (isType(right, "Identifier") && resolvedBindingIdentifier(right) === binding)
        return undefined;
      if (isProcessEnvironmentAlias(right)) return true;
      return anyOf([
        isType(right, "ObjectExpression"),
        isType(right, "ArrayExpression"),
        isType(right, "ArrowFunctionExpression"),
        isType(right, "FunctionExpression"),
        isType(right, "ClassExpression"),
        isType(right, "NewExpression"),
        isType(right, "BooleanLiteral"),
        isType(right, "NullLiteral"),
        allOf([isType(right, "Literal"), literal(right) !== undefined]),
      ])
        ? false
        : undefined;
    };
    const processEnvironmentSameScopeWriteOrder = (write, reference, referenceScope) => {
      if (writeIsAfterReferenceInScope(write, reference, referenceScope) === true) return "after";
      const statement = bindingWriteStatementFor(write, referenceScope);
      if (isType(statement, "ExpressionStatement") && read(statement, "expression") === write)
        return "before";
      return sequenceOrderInNestedExpression(write, reference, referenceScope) === false
        ? "before"
        : "unknown";
    };
    const processEnvironmentProgramWriteOrder = (write, bindingScope) => {
      const statement = bindingWriteStatementFor(write, bindingScope);
      return isType(statement, "ExpressionStatement") && read(statement, "expression") === write
        ? "before"
        : "unknown";
    };
    const processEnvironmentWritesForBinding = (binding) =>
      writeExpressionsForBinding(binding)
        .slice()
        .sort((left, right) => {
          const leftStart = read(left, "start");
          const rightStart = read(right, "start");
          return typeof leftStart === "number" && typeof rightStart === "number"
            ? leftStart - rightStart
            : 0;
        });
    const stableLocalFunctionForBinding = (binding, reference, seen = new Set()) => {
      if (binding === undefined || seen.has(binding)) return undefined;
      const declaration = read(binding, "parent");
      if (isType(declaration, "FunctionDeclaration") && read(declaration, "id") === binding) {
        const scope = writeScanScopeForBinding(binding);
        const bindingWrites = writeExpressionsForBinding(binding);
        const bindingMayChangeBeforeReference = bindingWrites.some((write) =>
          localFunctionWriteCanAffectReference(write, reference, binding, scope),
        );
        if (bindingMayChangeBeforeReference) return undefined;
        return declaration;
      }
      const initializer = stableConstInitializerForBinding(binding);
      if (functionScopeTypes.has(read(initializer, "type"))) return initializer;
      return isType(initializer, "Identifier")
        ? stableLocalFunctionForBinding(
            resolvedBindingIdentifier(initializer),
            initializer,
            new Set(seen).add(binding),
          )
        : undefined;
    };
    const stableLocalFunctionForCall = (call) => {
      const callee = read(call, "callee");
      if (functionScopeTypes.has(read(callee, "type"))) return callee;
      return isType(callee, "Identifier")
        ? stableLocalFunctionForBinding(resolvedBindingIdentifier(callee), callee)
        : undefined;
    };
    const processEnvironmentDirectStatementIsUnconditional = (node, scope) => {
      const body = read(scope, "body");
      if (body === node) return true;
      if (!isType(body, "BlockStatement")) return false;
      const statement = bindingWriteStatementFor(node, scope);
      if (!isType(statement, "ExpressionStatement") || read(statement, "expression") !== node)
        return false;
      const statements = read(body, "body") ?? [];
      const index = statements.indexOf(statement);
      if (index < 0) return false;
      const statementsThatMaySkipLaterExecution = new Set([
        "BlockStatement",
        "BreakStatement",
        "ContinueStatement",
        "DoWhileStatement",
        "ForInStatement",
        "ForOfStatement",
        "ForStatement",
        "IfStatement",
        "ReturnStatement",
        "SwitchStatement",
        "ThrowStatement",
        "TryStatement",
        "WhileStatement",
      ]);
      return statements
        .slice(0, index)
        .every((previous) => !statementsThatMaySkipLaterExecution.has(read(previous, "type")));
    };
    const processEnvironmentCallPrecedesReference = (
      call,
      caller,
      binding,
      reference,
      bindingExecutionScope,
      referenceScope,
    ) => {
      if (!processEnvironmentDirectStatementIsUnconditional(call, caller)) return false;
      if (writeIsStaticallyUnreachable(call)) return false;
      if (caller !== referenceScope) return true;
      if (bindingExecutionScope === referenceScope)
        return nodeIsBetweenReferences(call, binding, reference, referenceScope);
      return (
        isType(bindingExecutionScope, "Program") &&
        writeIsAfterReferenceInScope(call, reference, referenceScope) === false
      );
    };
    const processEnvironmentLocalCallPathReachesWriter = (root, writer, callIsBefore) => {
      const pending = [root];
      const visited = new Set();
      while (pending.length > 0) {
        const caller = pending.pop();
        if (caller === writer) return true;
        if (caller === undefined || visited.has(caller)) continue;
        visited.add(caller);
        for (const call of reachableExecutionCalls(caller)) {
          if (!callIsBefore(call, caller)) continue;
          const callee = stableLocalFunctionForCall(call);
          if (callee !== undefined) pending.push(callee);
        }
      }
      return false;
    };
    const processEnvironmentHelperWriteIsBeforeReference = (
      write,
      binding,
      reference,
      referenceScope,
    ) => {
      if (processEnvironmentWritesForBinding(binding).length !== 1) return false;
      const bindingExecutionScope = functionOrProgramScopeFor(binding);
      const writer = nestedFunctionForWrite(write, bindingExecutionScope);
      if (writer === undefined || !processEnvironmentDirectStatementIsUnconditional(write, writer))
        return false;
      if (bindingExecutionScope !== referenceScope && !isType(bindingExecutionScope, "Program"))
        return false;
      return processEnvironmentLocalCallPathReachesWriter(referenceScope, writer, (call, caller) =>
        processEnvironmentCallPrecedesReference(
          call,
          caller,
          binding,
          reference,
          bindingExecutionScope,
          referenceScope,
        ),
      );
    };
    const processEnvironmentWriteOrderForReference = (
      write,
      binding,
      reference,
      bindingScope,
      referenceScope,
    ) => {
      const writeScope = functionOrProgramScopeFor(write);
      if (writeScope === referenceScope)
        return processEnvironmentSameScopeWriteOrder(write, reference, referenceScope);
      if (
        isType(bindingScope, "Program") &&
        isType(writeScope, "Program") &&
        referenceScope !== writeScope
      )
        return processEnvironmentProgramWriteOrder(write, bindingScope);
      if (processEnvironmentHelperWriteIsBeforeReference(write, binding, reference, referenceScope))
        return "before";
      return "cross-scope";
    };
    const processEnvironmentBindingIsCurrent = (binding, reference, bindingScope) => {
      const referenceScope = functionOrProgramScopeFor(reference);
      if (referenceScope === undefined) return true;
      let mayStillBeProcessEnvironment = true;
      for (const write of processEnvironmentWritesForBinding(binding)) {
        if (writeIsStaticallyUnreachable(write)) continue;
        const order = processEnvironmentWriteOrderForReference(
          write,
          binding,
          reference,
          bindingScope,
          referenceScope,
        );
        if (order === "after" || order === "cross-scope") continue;
        const assignedValue = processEnvironmentAliasValueForAssignment(write, binding);
        if (order === "before" && assignedValue !== undefined) {
          mayStillBeProcessEnvironment = assignedValue;
        } else if (assignedValue !== false) {
          mayStillBeProcessEnvironment = true;
        }
      }
      return mayStillBeProcessEnvironment;
    };
    const preindexProcessEnvironmentAliases = (program) => {
      const declarators = [];
      walkAst(program, (node) => {
        if (isType(node, "VariableDeclarator")) declarators.push(node);
      });
      for (let pass = 0; pass <= declarators.length; pass += 1) {
        const countBefore = processEnvironmentBindingNodes.size;
        declarators.forEach(registerDestructuredProcessEnvironment);
        if (processEnvironmentBindingNodes.size === countBefore) return;
      }
    };
    const registerItAlias = (node, specifier) => {
      if (
        allOf([
          isEffectVitestImport(node, specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "it",
        ])
      )
        vitestImports.set(read(read(specifier, "local"), "name"), "it");
      registerEffectVitestNamespace(node, specifier, vitestNamespaceImports);
      registerSuiteAlias(node, specifier);
    };
    const registerEnvironmentAlias = (node, specifier) => {
      if (
        allOf([
          sourceIsProcess(node),
          isType(specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "env",
        ])
      ) {
        const binding = resolvedBindingIdentifier(read(specifier, "local"));
        if (binding !== undefined) environmentImportBindings.add(binding);
      }
    };
    const registerProcessAlias = (node, specifier) => {
      if (sourceIsProcess(node) && isRuntimeNamespaceImport(specifier))
        processAliases.add(read(read(specifier, "local"), "name"));
    };
    const filesystemPromisesImportSource = (source, specifier) =>
      allOf([
        isType(specifier, "ImportSpecifier"),
        ["fs", "node:fs"].includes(source),
        read(read(specifier, "imported"), "name") === "promises",
      ])
        ? source + "/promises"
        : undefined;
    const registerFilesystemPromisesImport = (local, source, specifier) => {
      const promisesSource = filesystemPromisesImportSource(source, specifier);
      if (promisesSource === undefined) return false;
      namespaceImports.set(local, promisesSource);
      return true;
    };
    const isRuntimeNamespaceImport = (specifier) =>
      anyOf([
        isType(specifier, "ImportNamespaceSpecifier"),
        isType(specifier, "ImportDefaultSpecifier"),
        allOf([
          isType(specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "default",
        ]),
      ]);
    const registerSchedulerImport = (local, source, specifier) => {
      if (
        allOf([
          isType(specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "scheduler",
          ["node:timers/promises", "timers/promises"].includes(source),
        ])
      )
        schedulerImports.set(local, source);
    };
    const registerRuntimeImport = (node, specifier) => {
      const source = read(node, "source").value;
      const local = read(read(specifier, "local"), "name");
      if (registerFilesystemPromisesImport(local, source, specifier)) return;
      registerSchedulerImport(local, source, specifier);
      if (allOf([isRuntimeNamespaceImport(specifier), liveApis.has(source)]))
        namespaceImports.set(local, source);
      else
        imports.set(local, {
          source,
          imported: read(read(specifier, "imported"), "name") ?? "default",
        });
    };
    const registerLiveTestImports = (node) => {
      for (const specifier of node.specifiers) {
        registerItAlias(node, specifier);
        registerEnvironmentAlias(node, specifier);
        registerProcessAlias(node, specifier);
        registerRuntimeImport(node, specifier);
      }
    };
    return {
      Program() {
        forEachProgramImport(context.getSourceCode().ast, registerLiveTestImports);
        preindexProcessEnvironmentAliases(context.getSourceCode().ast);
        visitTestRegistrations(context.getSourceCode().ast);
      },
      CallExpression(node) {
        reportWhen(node, shouldReportRuntimeCall, (target) => reportPolicy(target, "live"));
      },
      MemberExpression(node) {
        reportWhen(node, shouldReportEnvironmentMember, (target) => reportPolicy(target, "live"));
      },
      Identifier(node) {
        reportWhen(node, shouldReportEnvironmentIdentifier, (target) =>
          reportPolicy(target, "live"),
        );
      },
    };
  },
};

const controlledTimeouts = {
  meta: {
    type: "problem",
    docs: { description: "avoid fixed wall-clock sleeps for deterministic Effect tests" },
    schema: [],
    messages: {
      timeout:
        "Use TestClock or synchronization helpers for deterministic timeout tests; wall-clock sleeps are for live or integration tests.",
    },
  },
  create(context) {
    if (!testFile(context)) return {};
    const reportPolicy = makePolicyReporter(context, "controlled-test-timeouts");
    const effectApi = createEffectApiResolver(context.getSourceCode().ast);
    const testAliases = new Set();
    const imports = new Map();
    const timerNamespaceImports = new Map();
    const durationNamespaces = new Set();
    const testClockNamespaces = new Set();
    const deferredNamespaces = new Set();
    const fiberNamespaces = new Set();
    const httpClientNamespaces = new Set();
    const vitestNamespaceImports = new Set();
    const previewAuthFactoryBindings = new Set();
    const effectSleepExecutionContexts = new Map();
    const nonFlatteningEffectCallbackMethods = new Set(["map", "promise", "sync", "tryPromise"]);
    const effectRunnerMethods = new Set([
      "runFork",
      "runPromise",
      "runPromiseExit",
      "runSync",
      "runSyncExit",
    ]);
    const durationUnitMillis = new Map([
      ["nano", 1e-6],
      ["nanos", 1e-6],
      ["nanosecond", 1e-6],
      ["nanoseconds", 1e-6],
      ["micro", 1e-3],
      ["micros", 1e-3],
      ["microsecond", 1e-3],
      ["microseconds", 1e-3],
      ["milli", 1],
      ["millis", 1],
      ["millisecond", 1],
      ["milliseconds", 1],
      ["second", 1000],
      ["seconds", 1000],
      ["minute", 60000],
      ["minutes", 60000],
      ["hour", 3600000],
      ["hours", 3600000],
      ["day", 86400000],
      ["days", 86400000],
    ]);
    const stringDurationMillis = (value) => {
      if (typeof value !== "string") return undefined;
      const match =
        /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(nanoseconds?|nanos?|microseconds?|micros?|milliseconds?|millis?|seconds?|minutes?|hours?|days?)\s*$/i.exec(
          value,
        );
      if (match === null) return undefined;
      return durationFromMatch(match);
    };
    const durationFromMatch = (match) => {
      const amount = Number(match[1]);
      const scale = durationUnitMillis.get(match[2].toLowerCase());
      if (amount <= 0 || scale === undefined) return undefined;
      return amount * scale;
    };
    const isImportedDurationNamespace = (namespace) =>
      durationNamespaces.has(read(namespace, "name")) &&
      !isShadowedAtNode(namespace, read(namespace, "name"), { ignoreProgram: true });
    const isEffectDurationMember = (namespace) =>
      allOf([
        isType(namespace, "MemberExpression"),
        staticMemberName(namespace) === "Duration",
        anyOf([
          effectApi.isEffectModuleNamespace(read(namespace, "object")),
          effectApi.isRootEffectObjectNamespace(read(namespace, "object")),
        ]),
      ]);
    const isDurationNamespace = (namespace, seen = new Set()) => {
      if (isImportedDurationNamespace(namespace) || isEffectDurationMember(namespace)) return true;
      if (!isType(namespace, "Identifier")) return false;
      const binding = resolvedBindingIdentifier(namespace);
      if (binding === undefined || seen.has(binding)) return false;
      const initializer = stableConstInitializerForBinding(binding);
      return (
        initializer !== undefined && isDurationNamespace(initializer, new Set(seen).add(binding))
      );
    };
    const isDurationUnit = (callee) =>
      durationUnitMillis.has(read(read(callee, "property"), "name"));
    const isDurationApiCall = (node, callee) =>
      allOf([
        isType(node, "CallExpression"),
        isType(callee, "MemberExpression"),
        isDurationNamespace(read(callee, "object")),
        isDurationUnit(callee),
      ]);
    const effectDurationTarget = (node) => {
      const callee = read(node, "callee");
      return isDurationApiCall(node, callee) ? callee : undefined;
    };
    const durationAmountMillis = (amount, unit) => {
      if (typeof amount !== "number") return undefined;
      if (amount <= 0) return undefined;
      const scale = durationUnitMillis.get(unit);
      if (scale === undefined) return undefined;
      return amount * scale;
    };
    const effectDurationMillis = (node) => {
      const target = effectDurationTarget(node);
      return target === undefined
        ? undefined
        : durationAmountMillis(
            staticNumberValue(read(node, "arguments")?.[0]),
            read(read(target, "property"), "name"),
          );
    };
    const durationValueForExpression = (node) => {
      const value = literal(node);
      if (typeof value === "number") return value > 0 ? value : undefined;
      return stringDurationMillis(value) ?? effectDurationMillis(node);
    };
    const staticDurationMillis = (node) => stableConstValueFor(node, durationValueForExpression);
    const isPositiveDuration = (node) => staticDurationMillis(node) !== undefined;
    const isEffectNamespace = (node) => effectApi.isEffectApiNamespace(node);
    const directEffectSleep = (callee) => effectApi.methodForCallee(callee) === "sleep";
    const effectSleep = (callee, seen = new Set()) => {
      if (directEffectSleep(callee)) return true;
      if (!isType(callee, "Identifier")) return false;
      const binding = resolvedBindingIdentifier(callee);
      if (binding === undefined || seen.has(binding)) return false;
      const initializer = stableConstInitializerForBinding(binding);
      return initializer !== undefined && effectSleep(initializer, new Set(seen).add(binding));
    };
    const isEffectGenCallback = (node) => {
      const call = read(node, "parent");
      return allOf([
        isCallbackFunction(node),
        isType(call, "CallExpression"),
        (read(call, "arguments") ?? []).includes(node),
        effectApi.methodForCall(call) === "gen",
      ]);
    };
    const outerTestEffectBody = (sleepNode, testCallback) => {
      let body;
      for (
        let current = sleepNode;
        current && current !== testCallback;
        current = read(current, "parent")
      )
        if (isEffectGenCallback(current)) body = read(current, "body");
      return body;
    };
    const declaratorContaining = (node) => {
      for (let current = node; current; current = read(current, "parent"))
        if (isType(current, "VariableDeclarator")) return current;
      return undefined;
    };
    const isAdapterDeclarator = (node) =>
      allOf([
        isType(node, "VariableDeclarator"),
        isType(read(node, "init"), "ObjectExpression"),
        isType(read(node, "id"), "Identifier"),
      ]);
    const adapterDeclaratorContaining = (node) => {
      for (let current = node; current; current = read(current, "parent"))
        if (isAdapterDeclarator(current)) return current;
      return undefined;
    };
    const identifierReferencesDeclarator = (node, declaration) => {
      const binding = read(declaration, "id");
      const name = read(binding, "name");
      if (!isType(node, "Identifier")) return false;
      if (read(node, "name") !== name || isBindingIdentifier(node)) return false;
      const nodeScope = nearestBindingScope(node, name);
      const bindingScope = nearestBindingScope(binding, name);
      return allOf([
        nodeScope !== undefined,
        nodeScope === bindingScope,
        bindingIdentifierInScope(nodeScope, name) === binding,
      ]);
    };
    const isCallArgumentTo = (parent, node) =>
      allOf([isType(parent, "CallExpression"), (read(parent, "arguments") ?? []).includes(node)]);
    const argumentCallForReference = (node) => {
      for (let current = node; current; current = read(current, "parent")) {
        const parent = read(current, "parent");
        if (isCallArgumentTo(parent, current)) return parent;
      }
      return undefined;
    };
    const callPassingDeclarator = (body, declaration) => {
      const reference = firstReachableExecutionNode(
        body,
        (node) =>
          identifierReferencesDeclarator(node, declaration) && argumentCallForReference(node),
      );
      return argumentCallForReference(reference);
    };
    const isForkChildStep = (step) =>
      member(step, "forkChild") && isEffectNamespace(read(step, "object"));
    const forkedProvisionCall = (provisionCall) =>
      enclosingCall(
        provisionCall,
        (call) =>
          member(read(call, "callee"), "pipe") &&
          (read(call, "arguments") ?? []).some(isForkChildStep),
      );
    const deferredNamespace = (node) => {
      const name = read(node, "name");
      if (!deferredNamespaces.has(name)) return false;
      return !isShadowedAtNode(node, name, { ignoreProgram: true });
    };
    const deferredMethodCall = (node, method) => {
      if (!isType(node, "CallExpression")) return false;
      const callee = read(node, "callee");
      if (!member(callee, method)) return false;
      return deferredNamespace(read(callee, "object"));
    };
    const isNestedBindingSearchBoundary = (node, scope) =>
      allOf([node !== scope, isBindingScope(node)]);
    const isRequestedBindingIdentifier = (node, name) =>
      allOf([isBindingIdentifierAt(node, read(node, "parent")), read(node, "name") === name]);
    const visitBindingSearchNode = (node, scope, name, result) => {
      if (isNestedBindingSearchBoundary(node, scope)) return null;
      if (!isRequestedBindingIdentifier(node, name)) return undefined;
      result.binding = node;
      return false;
    };
    const bindingIdentifierInScope = (scope, name) => {
      const result = {};
      walkAst(scope, (node) => visitBindingSearchNode(node, scope, name, result));
      return result.binding;
    };
    const deferredValueBinding = (call) => {
      const value = read(read(call, "arguments"), 0);
      if (!isType(value, "Identifier")) return undefined;
      const scope = nearestBindingScope(value, read(value, "name"));
      return scope && !isType(scope, "Program")
        ? bindingIdentifierInScope(scope, read(value, "name"))
        : undefined;
    };
    const sameDeferredValue = (first, second) => {
      const firstBinding = deferredValueBinding(first);
      const secondBinding = deferredValueBinding(second);
      return allOf([firstBinding !== undefined, firstBinding === secondBinding]);
    };
    const yieldedCall = (node) =>
      hasAncestor(
        node,
        (ancestor) => isType(ancestor, "YieldExpression") && read(ancestor, "delegate") === true,
      );
    const directStatementInBody = (node, body) => {
      for (let current = node; current && current !== body; current = read(current, "parent"))
        if (read(current, "parent") === body) return current;
      return undefined;
    };
    const bindingForIdentifier = (node) => {
      if (!isType(node, "Identifier")) return undefined;
      const scope = nearestBindingScope(node, read(node, "name"));
      return scope ? bindingIdentifierInScope(scope, read(node, "name")) : undefined;
    };
    const booleanAssignmentValue = (statement, declaration) => {
      const assignment = read(statement, "expression");
      if (
        !allOf([
          isType(assignment, "AssignmentExpression"),
          read(assignment, "operator") === "=",
          identifierReferencesDeclarator(read(assignment, "left"), declaration),
        ])
      )
        return undefined;
      return staticBooleanValue(read(assignment, "right"));
    };
    const lastBooleanAssignmentBefore = (statements, limit, declaration, initial) => {
      let value = initial;
      for (const statement of statements.slice(0, limit)) {
        const assigned = booleanAssignmentValue(statement, declaration);
        if (assigned !== undefined) value = assigned;
      }
      return value;
    };
    const assignedBooleanBeforeFork = (condition, testBody, forkCall) => {
      const declaration = declaratorContaining(bindingForIdentifier(condition));
      if (declaration === undefined) return undefined;
      const forkStatement = directStatementInBody(forkCall, testBody);
      const statements = read(testBody, "body") ?? [];
      const limit = statements.indexOf(forkStatement);
      if (limit < 0) return undefined;
      return lastBooleanAssignmentBefore(
        statements,
        limit,
        declaration,
        staticBooleanValue(read(declaration, "init")),
      );
    };
    const knownBooleanBeforeFork = (condition, testBody, forkCall) => {
      const initial = staticBooleanValue(condition);
      if (initial !== undefined) return initial;
      if (!isType(condition, "Identifier")) return undefined;
      return assignedBooleanBeforeFork(condition, testBody, forkCall);
    };
    const containsDeferredMake = (node) =>
      firstReachableExecutionNode(node, (current) => deferredMethodCall(current, "make")) !==
      undefined;
    const deferredAssignmentValue = (statement, declaration) => {
      const assignment = read(statement, "expression");
      if (
        !allOf([
          isType(assignment, "AssignmentExpression"),
          read(assignment, "operator") === "=",
          identifierReferencesDeclarator(read(assignment, "left"), declaration),
        ])
      )
        return undefined;
      return containsDeferredMake(read(assignment, "right"));
    };
    const lastDeferredAssignmentBefore = (statements, limit, declaration, initial) => {
      let initialized = initial;
      for (const statement of statements.slice(0, limit)) {
        const assigned = deferredAssignmentValue(statement, declaration);
        if (assigned !== undefined) initialized = assigned;
      }
      return initialized;
    };
    const deferredMakeBinding = (binding, testBody, forkCall) => {
      const declaration = declaratorContaining(binding);
      if (declaration === undefined) return false;
      const forkStatement = directStatementInBody(forkCall, testBody);
      const statements = read(testBody, "body") ?? [];
      const limit = statements.indexOf(forkStatement);
      if (limit < 0) return false;
      return lastDeferredAssignmentBefore(
        statements,
        limit,
        declaration,
        containsDeferredMake(read(declaration, "init")),
      );
    };
    const isDeferredTruthyGuard = (frame, signal, testBody, forkCall) => {
      const condition = read(frame.node, "test");
      if (!isType(condition, "Identifier")) return false;
      const binding = bindingForIdentifier(condition);
      return allOf([
        frame.kind === "if",
        frame.branch === "consequent",
        read(frame.node, "alternate") == null,
        binding === deferredValueBinding(signal),
        deferredMakeBinding(binding, testBody, forkCall),
      ]);
    };
    const ifBranchName = (parent, current) =>
      current === read(parent, "consequent") ? "consequent" : "alternate";
    const executionBranchFrame = (parent, current) => {
      if (
        allOf([
          isType(parent, "IfStatement"),
          anyOf([current === read(parent, "consequent"), current === read(parent, "alternate")]),
        ])
      )
        return {
          kind: "if",
          node: parent,
          branch: ifBranchName(parent, current),
        };
      if (
        allOf([
          isType(parent, "ConditionalExpression"),
          anyOf([current === read(parent, "consequent"), current === read(parent, "alternate")]),
        ])
      )
        return {
          kind: "conditional",
          node: parent,
          branch: ifBranchName(parent, current),
        };
      if (allOf([isType(parent, "LogicalExpression"), current === read(parent, "right")]))
        return { kind: "logical", node: parent, branch: read(parent, "operator") };
      return undefined;
    };
    const executionBranches = (node, rootNode) => {
      const branches = [];
      for (let current = node; current && current !== rootNode; current = read(current, "parent")) {
        const frame = executionBranchFrame(read(current, "parent"), current);
        if (frame !== undefined) branches.push(frame);
      }
      return branches;
    };
    const branchWillExecute = (frame, testBody, forkCall) => {
      if (frame.kind !== "if") return false;
      const selected = knownBooleanBeforeFork(read(frame.node, "test"), testBody, forkCall);
      return selected === (frame.branch === "consequent");
    };
    const executionBranchMatches = (frame, otherPath, first, signal, testBody, forkCall) => {
      const matching = otherPath.find((candidate) => candidate.node === frame.node);
      if (matching === undefined)
        return first === signal && isDeferredTruthyGuard(frame, signal, testBody, forkCall);
      return allOf([
        matching.branch === frame.branch,
        branchWillExecute(frame, testBody, forkCall),
      ]);
    };
    const containsExecutionBranch = (pathToCheck, path) =>
      pathToCheck.every((frame) => path.some((candidate) => candidate.node === frame.node));
    const sameExecutedPath = (first, second, rootNode, signal, testBody, forkCall) => {
      const firstPath = executionBranches(first, rootNode);
      const secondPath = executionBranches(second, rootNode);
      return allOf([
        firstPath.every((frame) =>
          executionBranchMatches(frame, secondPath, first, signal, testBody, forkCall),
        ),
        containsExecutionBranch(secondPath, firstPath),
      ]);
    };
    const isSharedStatementBlock = (block, other) =>
      isType(block, "BlockStatement") && hasAncestor(other, (ancestor) => ancestor === block);
    const nearestSharedBlock = (first, second, root) => {
      for (let current = first; current; current = read(current, "parent")) {
        if (isSharedStatementBlock(current, second)) return current;
        if (current === root) break;
      }
      return undefined;
    };
    const followsInBody = (first, second, body) => {
      const sharedBlock = nearestSharedBlock(first, second, body);
      const statements = read(sharedBlock, "body") ?? [];
      const firstStatement = directStatementInBody(first, sharedBlock);
      const secondStatement = directStatementInBody(second, sharedBlock);
      return allOf([
        sharedBlock !== undefined,
        firstStatement !== undefined,
        secondStatement !== undefined,
        statements.indexOf(secondStatement) > statements.indexOf(firstStatement),
      ]);
    };
    const deferredSignalBeforeSleep = (sleepBody, sleepNode, testBody, forkCall) =>
      firstReachableExecutionNode(
        sleepBody,
        (node) =>
          deferredMethodCall(node, "succeed") &&
          yieldedCall(node) &&
          followsInBody(node, sleepNode, sleepBody) &&
          sameExecutedPath(node, sleepNode, sleepBody, node, testBody, forkCall),
      );
    const adapterFactoryCall = (testBody, adapterDeclaration) =>
      callPassingDeclarator(testBody, adapterDeclaration);
    const isForkedProvisionForAuth = (node, authDeclaration) => {
      if (!isType(node, "CallExpression")) return false;
      const callee = read(node, "callee");
      if (!member(callee, "provision")) return false;
      if (!identifierReferencesDeclarator(read(callee, "object"), authDeclaration)) return false;
      return forkedProvisionCall(node) !== undefined;
    };
    const provisionCallForAuth = (testBody, factoryCall) => {
      const authDeclaration = declaratorContaining(factoryCall);
      return {
        authDeclaration,
        call: firstReachableExecutionNode(
          testBody,
          (node) =>
            isForkedProvisionForAuth(node, authDeclaration) &&
            isDirectYieldStatement(node, testBody),
        ),
      };
    };
    const matchingAwaitAfterFork = (testBody, signal, forkCall) =>
      firstReachableExecutionNode(testBody, (node) => {
        if (!deferredMethodCall(node, "await")) return false;
        return allOf([
          yieldedCall(node),
          isDirectYieldStatement(node, testBody),
          sameDeferredValue(signal, node),
          followsInBody(forkCall, node, testBody),
        ]);
      });
    const isYieldedClockAdjustment = (node, statement, testBody) =>
      yieldedCall(node) &&
      isDirectYieldStatement(node, testBody) &&
      adjustmentIsYieldRoot(node, statement);
    const adjustmentIsYieldRoot = (node, statement) => {
      const yielded = yieldedExpressionForStatement(node, statement);
      return isType(yielded, "YieldExpression") && read(yielded, "argument") === node;
    };
    const clockAdvanceInStatement = (statement, testBody) => {
      const adjustment = firstReachableExecutionNode(
        statement,
        (node) =>
          isControlledClockAdjust(node, testClockNamespaces) &&
          isYieldedClockAdjustment(node, statement, testBody),
      );
      return staticDurationMillis(read(adjustment, "arguments")?.[0]);
    };
    const sumClockAdvancesInStatements = (statements, testBody) =>
      statements.reduce(
        (total, statement) => total + (clockAdvanceInStatement(statement, testBody) ?? 0),
        0,
      );
    const clockAdvanceBetween = (testBody, start, end) => {
      const statements = read(testBody, "body") ?? [];
      const startIndex = statements.indexOf(directStatementInBody(start, testBody));
      const endIndex = statements.indexOf(directStatementInBody(end, testBody));
      if (startIndex < 0) return 0;
      if (endIndex <= startIndex) return 0;
      return sumClockAdvancesInStatements(statements.slice(startIndex + 1, endIndex), testBody);
    };
    const requiredClockAdvanceForSleep = (sleepNode, minimum) => {
      if (minimum > 0) return minimum;
      return staticDurationMillis(read(sleepNode, "arguments")?.[0]) ?? Infinity;
    };
    const meetsClockAdvanceRequirement = (available, required) =>
      Number.isFinite(required) && available >= required;
    const clockAdvanceCompletesSleep = (testBody, start, join, sleepNode, minimum = 0) => {
      const required = requiredClockAdvanceForSleep(sleepNode, minimum);
      if (!Number.isFinite(required)) return false;
      return meetsClockAdvanceRequirement(clockAdvanceBetween(testBody, start, join), required);
    };
    const isFiberJoin = (node) => {
      if (!isType(node, "CallExpression")) return false;
      const callee = read(node, "callee");
      const fiber = read(callee, "object");
      const name = read(fiber, "name");
      if (!member(callee, "join") || !fiberNamespaces.has(name)) return false;
      return !isShadowedAtNode(fiber, name, { ignoreProgram: true });
    };
    const fiberJoinAfterClock = (testBody, forkCall, adjustment) => {
      const fiberDeclaration = declaratorContaining(forkCall);
      return firstReachableExecutionNode(testBody, (node) => {
        if (!isFiberJoin(node)) return false;
        return allOf([
          yieldedCall(node),
          isDirectYieldStatement(node, testBody),
          identifierReferencesDeclarator(read(node, "arguments")?.[0], fiberDeclaration),
          followsInBody(adjustment, node, testBody),
        ]);
      });
    };
    const hasImmediateStart = (call) => {
      const options = read(call, "arguments")?.[0];
      const properties = read(options, "properties") ?? [];
      return properties.some((property) =>
        allOf([
          isType(property, "Property"),
          !read(property, "computed"),
          read(read(property, "key"), "name") === "startImmediately",
          staticBooleanValue(read(property, "value")) === true,
        ]),
      );
    };
    const isImmediateRaceFork = (node) => {
      const callee = read(node, "callee");
      const pipeCall = read(node, "parent");
      const raceCall = read(read(pipeCall, "callee"), "object");
      return allOf([
        isType(node, "CallExpression"),
        member(callee, "forkScoped"),
        isEffectNamespace(read(callee, "object")),
        hasImmediateStart(node),
        isType(pipeCall, "CallExpression"),
        member(read(pipeCall, "callee"), "pipe"),
        (read(pipeCall, "arguments") ?? []).includes(node),
        isType(raceCall, "CallExpression"),
        member(read(raceCall, "callee"), "raceFirst"),
        isEffectNamespace(read(read(raceCall, "callee"), "object")),
      ]);
    };
    const immediateRaceForkForSleep = (sleepNode) => {
      const declaration = declaratorContaining(sleepNode);
      const initializer = read(declaration, "init");
      const forkCall = firstReachableExecutionNode(initializer, isImmediateRaceFork);
      return forkCall !== undefined && yieldedCall(forkCall) ? forkCall : undefined;
    };
    const raceJoinAfterAdjustment = (testBody, forkCall, adjustment) =>
      adjustment === undefined ? undefined : fiberJoinAfterClock(testBody, forkCall, adjustment);
    const forkedRaceClockContext = (executionNode, testCallback) => {
      const testBody = outerTestEffectBody(executionNode, testCallback);
      const forkCall = immediateRaceForkForSleep(executionNode);
      if (!allOf([testBody !== undefined, forkCall !== undefined])) return undefined;
      const adjustment = firstReachableExecutionNode(testBody, (node) =>
        allOf([
          isControlledClockAdjust(node, testClockNamespaces),
          isDirectYieldStatement(node, testBody),
          followsInBody(forkCall, node, testBody),
        ]),
      );
      const joined = raceJoinAfterAdjustment(testBody, forkCall, adjustment);
      return joined === undefined ? undefined : { testBody, forkCall, joined };
    };
    const hasForkedControlledClockUse = (executionNode, sleepNode, testCallback) => {
      const context = forkedRaceClockContext(executionNode, testCallback);
      if (context === undefined) return false;
      return clockAdvanceCompletesSleep(
        context.testBody,
        context.forkCall,
        context.joined,
        sleepNode,
      );
    };
    const httpClientApiObject = (node) => {
      const namespace = read(node, "object");
      return anyOf([
        allOf([
          isType(node, "Identifier"),
          httpClientNamespaces.has(read(node, "name")),
          !isShadowedAtNode(node, read(node, "name"), { ignoreProgram: true }),
        ]),
        allOf([
          member(node, "HttpClient"),
          isType(namespace, "Identifier"),
          httpClientNamespaces.has(read(namespace, "name")),
          !isShadowedAtNode(namespace, read(namespace, "name"), { ignoreProgram: true }),
        ]),
      ]);
    };
    const isHttpClientMakeCall = (call, callback) =>
      allOf([
        isType(call, "CallExpression"),
        member(read(call, "callee"), "make"),
        httpClientApiObject(read(read(call, "callee"), "object")),
        (read(call, "arguments") ?? []).includes(callback),
      ]);
    const httpClientCallbackAt = (callback) => {
      const call = read(callback, "parent");
      if (!isHttpClientMakeCall(call, callback)) return undefined;
      return { callback, call };
    };
    const httpClientCallbackSearchStep = (current) => {
      if (!isCallbackFunction(current) || isEffectGenCallback(current)) return undefined;
      return { callback: httpClientCallbackAt(current) };
    };
    const httpClientCallbackForSleep = (sleepNode, testCallback) => {
      for (
        let current = sleepNode;
        current && current !== testCallback;
        current = read(current, "parent")
      ) {
        const step = httpClientCallbackSearchStep(current);
        if (step !== undefined) return step.callback;
      }
      return undefined;
    };
    const deferredSignalAndThenBeforeSleep = (callbackBody, sleepNode, testBody, forkCall) => {
      const signal = firstReachableExecutionNode(callbackBody, (node) =>
        deferredMethodCall(node, "succeed"),
      );
      const andThen = enclosingCall(
        sleepNode,
        (call) =>
          member(read(call, "callee"), "andThen") &&
          isEffectNamespace(read(read(call, "callee"), "object")),
      );
      const pipe = read(andThen, "parent");
      return allOf([
        signal !== undefined,
        andThen !== undefined,
        isType(pipe, "CallExpression"),
        member(read(pipe, "callee"), "pipe"),
        read(read(pipe, "callee"), "object") === signal,
        (read(pipe, "arguments") ?? []).includes(andThen),
        sameExecutedPath(signal, sleepNode, callbackBody, signal, testBody, forkCall),
      ])
        ? signal
        : undefined;
    };
    const deferredSignalBeforeHttpSleep = (callbackBody, sleepNode, testBody, forkCall) =>
      deferredSignalBeforeSleep(
        effectExecutionRoot(callbackBody, sleepNode, isEffectGenCallback),
        sleepNode,
        testBody,
        forkCall,
      ) ?? deferredSignalAndThenBeforeSleep(callbackBody, sleepNode, testBody, forkCall);
    const httpClientCallbackSignalForSleep = (sleepNode, testCallback, testBody, forkCall) => {
      const callbackContext = httpClientCallbackForSleep(sleepNode, testCallback);
      if (callbackContext === undefined) return undefined;
      const callbackBody = read(callbackContext.callback, "body");
      const signal = deferredSignalBeforeHttpSleep(callbackBody, sleepNode, testBody, forkCall);
      if (signal === undefined) return undefined;
      return { call: callbackContext.call, signal };
    };
    const declaratorForReference = (rootNode, declaration) =>
      declaratorContaining(
        firstReachableExecutionNode(rootNode, (node) =>
          identifierReferencesDeclarator(node, declaration),
        ),
      );
    const httpClientConsumerDeclarator = (testBody, makeCall) => {
      const clientDeclaration = declaratorContaining(makeCall);
      const consumer = declaratorForReference(testBody, clientDeclaration);
      return consumer !== clientDeclaration ? consumer : undefined;
    };
    const forkChildStepUsingDeclarator = (testBody, dependency) =>
      firstReachableExecutionNode(testBody, (node) => {
        if (!isForkChildStep(node) || !isDirectYieldStatement(node, testBody)) return false;
        const pipe = read(node, "parent");
        const fiberDeclaration = declaratorContaining(pipe);
        return (
          fiberDeclaration !== undefined &&
          declaratorForReference(read(fiberDeclaration, "init"), dependency) !== undefined
        );
      });
    const hasDeferredHttpClientClockJoin = (testBody, sleepNode, signal, forkStep) => {
      const fork = read(forkStep, "parent");
      const awaited = matchingAwaitAfterFork(testBody, signal, fork);
      if (awaited === undefined) return false;
      const joined = fiberJoinAfterClock(testBody, fork, awaited);
      return (
        joined !== undefined && clockAdvanceCompletesSleep(testBody, awaited, joined, sleepNode)
      );
    };
    const httpClientCallbackContextForSleep = (sleepNode, testCallback) => {
      const testBody = outerTestEffectBody(sleepNode, testCallback);
      if (testBody === undefined) return undefined;
      const callback = httpClientCallbackForSleep(sleepNode, testCallback);
      if (callback === undefined) return undefined;
      return { testBody, callback };
    };
    const httpClientForkContextForCallback = (testBody, callback) => {
      const consumer = httpClientConsumerDeclarator(testBody, callback.call);
      if (consumer === undefined) return undefined;
      const forkStep = forkChildStepUsingDeclarator(testBody, consumer);
      if (forkStep === undefined) return undefined;
      return { consumer, forkStep };
    };
    const hasHttpClientDeferredClockHandshake = (executionNode, sleepNode, testCallback) => {
      const callbackContext = httpClientCallbackContextForSleep(executionNode, testCallback);
      if (callbackContext === undefined) return false;
      const forkContext = httpClientForkContextForCallback(
        callbackContext.testBody,
        callbackContext.callback,
      );
      if (forkContext === undefined) return false;
      const callbackSignal = httpClientCallbackSignalForSleep(
        executionNode,
        testCallback,
        callbackContext.testBody,
        read(forkContext.forkStep, "parent"),
      );
      if (callbackSignal === undefined) return false;
      return hasDeferredHttpClientClockJoin(
        callbackContext.testBody,
        sleepNode,
        callbackSignal.signal,
        forkContext.forkStep,
      );
    };
    const hasDeferredClockHandshake = (rootNode, executionNode, testCallback, sleepNode) => {
      const sleepBody = effectExecutionRoot(rootNode, executionNode, isEffectGenCallback);
      const testBody = outerTestEffectBody(executionNode, testCallback);
      const adapterDeclaration = adapterDeclaratorContaining(executionNode);
      const factoryCall = adapterFactoryCall(testBody, adapterDeclaration);
      const { call: provisionCall } = provisionCallForAuth(testBody, factoryCall);
      const forkCall = forkedProvisionCall(provisionCall);
      const signal = deferredSignalBeforeSleep(sleepBody, executionNode, testBody, forkCall);
      const awaited = matchingAwaitAfterFork(testBody, signal, forkCall);
      const joined = fiberJoinAfterClock(testBody, forkCall, awaited);
      // preview-auth wraps provisionClient with its documented five-second adapter timeout.
      const previewAuthAdapter = isCanonicalPreviewAuthFactoryCall(factoryCall);
      const previewAuthTimeoutMillis = previewAuthAdapter ? 5000 : 0;
      return allOf([
        sleepBody !== undefined,
        testBody !== undefined,
        adapterDeclaration !== undefined,
        signal !== undefined,
        factoryCall !== undefined,
        provisionCall !== undefined,
        forkCall !== undefined,
        awaited !== undefined,
        joined !== undefined,
        clockAdvanceCompletesSleep(testBody, awaited, joined, sleepNode, previewAuthTimeoutMillis),
      ]);
    };
    const containingVariableDeclarator = (node, statement) => {
      for (const declaration of read(statement, "declarations") ?? [])
        if (hasAncestor(node, (ancestor) => ancestor === declaration)) return declaration;
      return undefined;
    };
    const yieldedVariableInitializer = (node, statement) =>
      read(containingVariableDeclarator(node, statement), "init");
    const yieldedExpressionForStatement = (node, statement) =>
      isType(statement, "VariableDeclaration")
        ? yieldedVariableInitializer(node, statement)
        : (read(statement, "expression") ?? read(statement, "argument"));
    const directYieldStatementTypes = new Set([
      "ExpressionStatement",
      "ReturnStatement",
      "VariableDeclaration",
    ]);
    const isDirectYieldStatement = (node, body) => {
      const statement = directStatementInBody(node, body);
      const expression = yieldedExpressionForStatement(node, statement);
      return allOf([
        directYieldStatementTypes.has(read(statement, "type")),
        isType(expression, "YieldExpression"),
        read(expression, "delegate") === true,
      ]);
    };
    const isNamedTestItAlias = (object) =>
      isType(object, "Identifier") &&
      testAliases.has(read(object, "name")) &&
      !isShadowedAtNode(object, read(object, "name"), { ignoreProgram: true });
    const isImportedTestNamespace = (namespace) =>
      isType(namespace, "Identifier") &&
      vitestNamespaceImports.has(read(namespace, "name")) &&
      !isShadowedAtNode(namespace, read(namespace, "name"), { ignoreProgram: true });
    const isNamespaceTestIt = (object) =>
      member(object, "it") && isImportedTestNamespace(read(object, "object"));
    const isTestItReference = (object) => isNamedTestItAlias(object) || isNamespaceTestIt(object);
    const isTestCall = (call, method) => testCallForMethod(call, method, isTestItReference);
    const registerEffectSpecifier = (statement, specifier) => {
      if (read(read(statement, "source"), "value") !== "effect") return;
      const local = read(read(specifier, "local"), "name");
      const imported = read(read(specifier, "imported"), "name");
      if (isType(specifier, "ImportNamespaceSpecifier")) {
        durationNamespaces.add(local);
      }
      if (allOf([isType(specifier, "ImportSpecifier"), imported === "Duration"]))
        durationNamespaces.add(local);
    };
    const registerDeferredSpecifier = (statement, specifier) => {
      if (
        allOf([
          read(read(statement, "source"), "value") === "effect",
          isType(specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "Deferred",
        ])
      )
        deferredNamespaces.add(read(read(specifier, "local"), "name"));
    };
    const registerFiberSpecifier = (statement, specifier) => {
      if (
        allOf([
          read(read(statement, "source"), "value") === "effect",
          isType(specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "Fiber",
        ])
      )
        fiberNamespaces.add(read(read(specifier, "local"), "name"));
    };
    const registerEffectImports = (node) =>
      read(node, "specifiers").forEach((specifier) => {
        registerEffectSpecifier(node, specifier);
        registerDeferredSpecifier(node, specifier);
        registerFiberSpecifier(node, specifier);
      });
    const registerClockSpecifier = (specifier) => {
      const isClockImport = anyOf([
        allOf([
          isType(specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "TestClock",
        ]),
        isType(specifier, "ImportNamespaceSpecifier"),
      ]);
      if (isClockImport) testClockNamespaces.add(read(read(specifier, "local"), "name"));
    };
    const registerClockImports = (node) => read(node, "specifiers").forEach(registerClockSpecifier);
    const registerTestAlias = (node, specifier) => {
      if (
        allOf([
          isEffectVitestImport(node, specifier, "ImportSpecifier"),
          read(read(specifier, "imported"), "name") === "it",
        ])
      )
        testAliases.add(read(read(specifier, "local"), "name"));
      registerEffectVitestNamespace(node, specifier, vitestNamespaceImports);
    };
    const timerImportKind = (node) => {
      const source = read(read(node, "source"), "value");
      if (["node:timers/promises", "timers/promises"].includes(source)) return "promise";
      if (["node:timers", "timers"].includes(source)) return "callback";
      return undefined;
    };
    const registerTimerAlias = (node, specifier) => {
      const kind = timerImportKind(node);
      if (kind === undefined) return;
      const local = read(read(specifier, "local"), "name");
      if (
        anyOf([
          isType(specifier, "ImportNamespaceSpecifier"),
          isType(specifier, "ImportDefaultSpecifier"),
        ])
      ) {
        timerNamespaceImports.set(local, kind);
        return;
      }
      if (
        isType(specifier, "ImportSpecifier") &&
        wallClockTimerNames.has(read(read(specifier, "imported"), "name"))
      )
        imports.set(local, kind);
    };
    const importedModulePath = (statement) =>
      path.posix
        .normalize(
          path.posix.join(path.posix.dirname(filename(context)), read(statement, "source").value),
        )
        .replace(/\.(?:[cm]?[jt]sx?)$/, "");
    const isCanonicalPreviewAuthImport = (statement, specifier) =>
      isType(specifier, "ImportSpecifier") &&
      read(read(specifier, "imported"), "name") === "makePreviewAuth" &&
      importedModulePath(statement) === "packages/developer-launcher/src/preview-auth";
    const registerPreviewAuthFactory = (statement, specifier) => {
      if (isCanonicalPreviewAuthImport(statement, specifier))
        previewAuthFactoryBindings.add(read(read(specifier, "local"), "name"));
    };
    const isCanonicalPreviewAuthFactoryCall = (call) => {
      const callee = read(call, "callee");
      const name = read(callee, "name");
      return allOf([
        isType(callee, "Identifier"),
        previewAuthFactoryBindings.has(name),
        !isShadowedAtNode(callee, name, { ignoreProgram: true }),
      ]);
    };
    const registerTestAndTimerImports = (node) =>
      read(node, "specifiers").forEach((specifier) => {
        registerTestAlias(node, specifier);
        registerTimerAlias(node, specifier);
        registerPreviewAuthFactory(node, specifier);
      });
    const registerTimeoutImport = (statement) => {
      const source = read(statement, "source").value;
      if (source === "effect") registerEffectImports(statement);
      if (["effect/testing", "effect/TestClock"].includes(source)) registerClockImports(statement);
      if (source === "effect/unstable/http")
        read(statement, "specifiers").forEach((specifier) => {
          if (isType(specifier, "ImportNamespaceSpecifier"))
            httpClientNamespaces.add(read(read(specifier, "local"), "name"));
          if (
            isType(specifier, "ImportSpecifier") &&
            read(read(specifier, "imported"), "name") === "HttpClient"
          )
            httpClientNamespaces.add(read(read(specifier, "local"), "name"));
        });
      registerTestAndTimerImports(statement);
    };
    const timeoutEffectCallbackPositions = effectCallbackPositions;
    const timeoutDataLastCallbackMethods = new Set(["map", "flatMap", "andThen", "tap"]);
    const timeoutEffectMethodForCall = effectApi.methodForCall;
    const isAppliedTimeoutDataLastCall = (call) => {
      const parent = read(call, "parent");
      return isType(parent, "CallExpression") && read(parent, "callee") === call;
    };
    const isTimeoutFunctionValue = (value) => {
      if (isCallbackFunction(value)) return true;
      if (!isType(value, "Identifier")) return false;
      return timeoutFunctionValueNodes(resolvedBindingIdentifier(value), value).length > 0;
    };
    const isAppliedTimeoutFunctionCallback = (call, args) =>
      (isAppliedTimeoutDataLastCall(call) || isEffectPipeStageCall(call)) &&
      isTimeoutFunctionValue(args[0]);
    const timeoutForEachCallbackPositionsForCall = (call, args) => {
      if (!isAppliedTimeoutDataLastCall(call)) return timeoutEffectCallbackPositions.get("forEach");
      return isTimeoutFunctionValue(args[0]) ? [0] : [];
    };
    const timeoutCurriedCallbackPositionsForCall = (call, method, args) => {
      if (!timeoutDataLastCallbackMethods.has(method)) return undefined;
      if (args.length !== 1) return undefined;
      return isAppliedTimeoutFunctionCallback(call, args) ? [0] : [];
    };
    const timeoutEffectCallbackPositionsForCall = (call) => {
      const method = timeoutEffectMethodForCall(call);
      const args = read(call, "arguments");
      if (method === "forEach") return timeoutForEachCallbackPositionsForCall(call, args);
      const curriedPositions = timeoutCurriedCallbackPositionsForCall(call, method, args);
      if (curriedPositions !== undefined) return curriedPositions;
      const positions = timeoutEffectCallbackPositions.get(method);
      return positions === undefined ? [] : positions;
    };
    const isTimeoutFunctionNode = (node) =>
      anyOf([
        isType(node, "ArrowFunctionExpression"),
        isType(node, "FunctionExpression"),
        isType(node, "FunctionDeclaration"),
      ]);
    const isPreviewAuthAdapterCallback = (node, testCallback) => {
      const declaration = adapterDeclaratorContaining(node);
      if (declaration === undefined) return false;
      const properties = read(read(declaration, "init"), "properties") ?? [];
      const provisionClient = properties.find(
        (property) =>
          isType(property, "Property") &&
          (read(property, "computed")
            ? literal(read(property, "key"))
            : read(read(property, "key"), "name")) === "provisionClient" &&
          read(property, "value") === node,
      );
      if (provisionClient === undefined) return false;
      const testBody = effectExecutionRoot(read(testCallback, "body"), node, isEffectGenCallback);
      return adapterFactoryCall(testBody, declaration) !== undefined;
    };
    const timeoutCallArguments = (call) => read(call, "arguments") ?? [];
    const timeoutCallArgumentIndex = (call, node) => timeoutCallArguments(call).indexOf(node);
    const isTimeoutEffectCallbackNode = (node) => {
      if (!isCallbackFunction(node)) return false;
      const call = read(node, "parent");
      if (!isType(call, "CallExpression")) return false;
      return timeoutEffectCallbackPositionsForCall(call).includes(
        timeoutCallArgumentIndex(call, node),
      );
    };
    const isExecutedTimeoutEffectCallback = (node, testCallback) =>
      isTimeoutEffectCallbackNode(node) ||
      httpClientCallbackAt(node) !== undefined ||
      isPreviewAuthAdapterCallback(node, testCallback);
    const timeoutVariableFunctionForBinding = (parent, binding) => {
      if (!isType(parent, "VariableDeclarator")) return undefined;
      if (read(parent, "id") !== binding) return undefined;
      const initializer = read(parent, "init");
      return isTimeoutFunctionNode(initializer) ? initializer : undefined;
    };
    const timeoutFunctionForBinding = (binding) => {
      const parent = read(binding, "parent");
      if (isType(parent, "FunctionDeclaration"))
        return read(parent, "id") === binding ? parent : undefined;
      return timeoutVariableFunctionForBinding(parent, binding);
    };
    const timeoutFunctionValueNodes = (binding, reference) =>
      possibleFunctionValuesForBinding(
        binding,
        timeoutFunctionForBinding,
        isTimeoutFunctionNode,
        new Set(),
        reference,
      );
    const executedEffectTestCallbacks = new Set();
    const timeoutFunctionNodesForArgument = (argument) => {
      if (isTimeoutFunctionNode(argument)) return [argument];
      if (!isType(argument, "Identifier")) return [];
      return timeoutFunctionValueNodes(resolvedBindingIdentifier(argument), argument);
    };
    const timeoutFunctionsForCall = (call) => {
      const callee = read(call, "callee");
      return isType(callee, "Identifier")
        ? timeoutFunctionValueNodes(resolvedBindingIdentifier(callee), callee)
        : [];
    };
    const timeoutFunctionForDefinition = (node) => {
      if (isType(node, "FunctionDeclaration")) return node;
      const parent = read(node, "parent");
      if (isType(parent, "VariableDeclarator") && read(parent, "init") === node) return node;
      return isType(parent, "AssignmentExpression") &&
        read(parent, "operator") === "=" &&
        read(parent, "right") === node &&
        isType(read(parent, "left"), "Identifier")
        ? node
        : undefined;
    };
    const timeoutFunctionBoundaryForNode = (node, testCallback) => {
      for (
        let current = node;
        current && current !== testCallback;
        current = read(current, "parent")
      )
        if (isTimeoutFunctionNode(current)) return timeoutFunctionForDefinition(current);
      return undefined;
    };
    const rememberEffectSleepExecution = (sleep, testCallback, executionNode) => {
      const contexts = effectSleepExecutionContexts.get(sleep) ?? [];
      const node = executionNode ?? sleep;
      if (
        !contexts.some(
          (context) => context.testCallback === testCallback && context.executionNode === node,
        )
      )
        contexts.push({ testCallback, executionNode: node });
      effectSleepExecutionContexts.set(sleep, contexts);
    };
    const isEffectSleepCall = (node) =>
      isType(node, "CallExpression") && effectSleep(read(node, "callee"));
    const argumentIndexContaining = (call, node) => {
      let current = node;
      while (current && read(current, "parent") !== call) current = read(current, "parent");
      return current === undefined ? -1 : timeoutCallArguments(call).indexOf(current);
    };
    const isNonFlatteningEffectValueArgument = (call, node) => {
      const method = timeoutEffectMethodForCall(call);
      const argumentIndex = argumentIndexContaining(call, node);
      if (method === "succeed") return argumentIndex === 0;
      if (method !== "as") return false;
      return argumentIndex === (timeoutCallArguments(call).length === 1 ? 0 : 1);
    };
    const isNonFlatteningEffectCallback = (node) => {
      if (!isTimeoutFunctionNode(node)) return false;
      const call = read(node, "parent");
      const method = timeoutEffectMethodForCall(call);
      return (
        nonFlatteningEffectCallbackMethods.has(method) &&
        timeoutEffectCallbackPositionsForCall(call).includes(timeoutCallArgumentIndex(call, node))
      );
    };
    const sleepExecutionBoundary = (node, testCallback) => {
      if (node === undefined) return undefined;
      for (
        let current = node;
        current && current !== testCallback;
        current = read(current, "parent")
      ) {
        if (isType(current, "CallExpression")) {
          const method = timeoutEffectMethodForCall(current);
          if (effectRunnerMethods.has(method)) return true;
          if (isNonFlatteningEffectValueArgument(current, node)) return false;
        }
        if (isNonFlatteningEffectCallback(current)) return false;
      }
      return undefined;
    };
    const sleepIsExecutedEffect = (node, testCallback, executionNode) => {
      const nodeBoundary = sleepExecutionBoundary(node, testCallback);
      if (nodeBoundary !== undefined) return nodeBoundary;
      return sleepExecutionBoundary(executionNode, testCallback) !== false;
    };
    const isInsideLiveTest = (node) => callbackAncestor(node, (call) => isTestCall(call, "live"));
    const isUnexecutedLocalSleepHelper = (node, testCallback) => {
      const helper = timeoutFunctionBoundaryForNode(node, testCallback);
      if (helper === undefined) return false;
      return !(effectSleepExecutionContexts.get(node) ?? []).some(
        (context) => context.testCallback === testCallback,
      );
    };
    const timeoutLocalFunctionsForCall = (call) =>
      isType(call, "CallExpression") ? timeoutFunctionsForCall(call) : [];
    const unvisitedTimeoutLocalFunctions = (helpers, ancestors) =>
      helpers.filter((helper) => !ancestors.has(helper));
    const timeoutExecutionNodeForCall = (executionNode, call) => executionNode ?? call;
    const visitExecutedLocalSleepHelper = (call, testCallback, executionNode, ancestors) => {
      const helpers = unvisitedTimeoutLocalFunctions(timeoutLocalFunctionsForCall(call), ancestors);
      for (const helper of helpers) {
        const nextAncestors = new Set(ancestors).add(helper);
        visitExecutedEffectBody(
          read(helper, "body"),
          testCallback,
          timeoutExecutionNodeForCall(executionNode, call),
          nextAncestors,
        );
      }
    };
    const shouldSkipUnexecutedTimeoutFunction = (node, testCallback) =>
      isTimeoutFunctionNode(node) && !isExecutedTimeoutEffectCallback(node, testCallback);
    const visitExecutedTimeoutNode = (node, testCallback, executionNode, ancestors) => {
      if (shouldSkipUnexecutedTimeoutFunction(node, testCallback)) return null;
      if (isEffectSleepCall(node) && sleepIsExecutedEffect(node, testCallback, executionNode))
        rememberEffectSleepExecution(node, testCallback, executionNode);
      visitExecutedLocalSleepHelper(node, testCallback, executionNode, ancestors);
      return undefined;
    };
    const visitExecutedEffectBody = (body, testCallback, executionNode, ancestors) =>
      walkAst(body, (node) =>
        visitExecutedTimeoutNode(node, testCallback, executionNode, ancestors),
      );
    const isEffectTimeoutTestCall = (node) =>
      isType(node, "CallExpression") && isTestCall(node, "effect");
    const timeoutTestCallbackForCall = (node) => {
      if (!isEffectTimeoutTestCall(node)) return undefined;
      if (isInsideLiveTest(node)) return undefined;
      return timeoutCallArguments(node).flatMap(timeoutFunctionNodesForArgument)[0];
    };
    const registerExecutedEffectSleepContext = (node) => {
      const testCallback = timeoutTestCallbackForCall(node);
      if (testCallback === undefined) return undefined;
      executedEffectTestCallbacks.add(testCallback);
      visitExecutedEffectBody(read(testCallback, "body"), testCallback, undefined, new Set());
      return null;
    };
    const registerExecutedEffectSleepContexts = (ast) =>
      walkAst(ast, registerExecutedEffectSleepContext);
    const lexicalEffectTestCallbackForSleep = (node) => {
      if (!isEffectSleepCall(node)) return undefined;
      if (isInsideLiveTest(node)) return undefined;
      return callbackFunction(node, (call) => isTestCall(call, "effect"));
    };
    const registerLexicalEffectSleepContext = (node) => {
      const testCallback = lexicalEffectTestCallbackForSleep(node);
      if (
        testCallback === undefined ||
        isUnexecutedLocalSleepHelper(node, testCallback) ||
        !sleepIsExecutedEffect(node, testCallback, node)
      )
        return undefined;
      rememberEffectSleepExecution(node, testCallback, node);
      return undefined;
    };
    const registerLexicalEffectSleepContexts = (ast) =>
      walkAst(ast, registerLexicalEffectSleepContext);
    const importedWallClockTimerKind = (callee) => {
      if (isType(callee, "Identifier")) {
        const kind = imports.get(read(callee, "name"));
        return kind !== undefined &&
          !isShadowedAtNode(callee, read(callee, "name"), { ignoreProgram: true })
          ? kind
          : undefined;
      }
      if (!isType(callee, "MemberExpression") || !isType(read(callee, "object"), "Identifier"))
        return undefined;
      const namespace = read(callee, "object");
      const name = read(namespace, "name");
      const kind = timerNamespaceImports.get(name);
      return kind !== undefined &&
        wallClockTimerNames.has(staticMemberName(callee)) &&
        !isShadowedAtNode(namespace, name, { ignoreProgram: true })
        ? kind
        : undefined;
    };
    const directWallClockTimerKind = (callee) => {
      const importedKind = importedWallClockTimerKind(callee);
      if (importedKind !== undefined) return importedKind;
      if (
        allOf([
          isType(callee, "Identifier"),
          wallClockTimerNames.has(read(callee, "name")),
          !isShadowedAtNode(callee, read(callee, "name")),
        ])
      )
        return "callback";
      return isGlobalObjectTimerCall(callee, wallClockTimerNames) ? "callback" : undefined;
    };
    const wallClockTimerKind = (callee, seen = new Set()) => {
      const directKind = directWallClockTimerKind(callee);
      if (directKind !== undefined) return directKind;
      if (!isType(callee, "Identifier")) return undefined;
      const binding = resolvedBindingIdentifier(callee);
      if (binding === undefined || seen.has(binding)) return undefined;
      const initializer = stableConstInitializerForBinding(binding);
      return initializer === undefined
        ? undefined
        : wallClockTimerKind(initializer, new Set(seen).add(binding));
    };
    const numericTimerValue = (node) => {
      const value = literal(node);
      if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
      if (typeof value !== "string" || value.trim().length === 0) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const staticNumberValue = (node) => stableConstValueFor(node, numericTimerValue);
    const isWallClockTimer = (node) => {
      if (!isType(node, "CallExpression")) return false;
      const kind = wallClockTimerKind(read(node, "callee"));
      if (kind === undefined) return false;
      const delayIndex = kind === "promise" ? 0 : 1;
      const delay = staticNumberValue((read(node, "arguments") ?? [])[delayIndex]);
      return delay !== undefined && delay > 0;
    };
    const isPositiveEffectSleepCandidate = (node) =>
      effectSleep(read(node, "callee")) && isPositiveDuration(read(node, "arguments")?.[0]);
    const shouldCheckSleepClock = (testCallback, inIntegrationTest) =>
      testCallback !== undefined && !inIntegrationTest;
    const hasControlledSleepClockPath = (sleepNode, testCallback, executionNode = sleepNode) =>
      hasDeferredClockHandshake(testCallback.body, executionNode, testCallback, sleepNode) ||
      hasForkedControlledClockUse(executionNode, sleepNode, testCallback) ||
      hasHttpClientDeferredClockHandshake(executionNode, sleepNode, testCallback);
    const shouldReportEffectSleep = (node) => {
      if (!isPositiveEffectSleepCandidate(node)) return false;
      const inIntegrationTest = /(?:integration|e2e)\.test\.[cm]?[jt]sx?$/.test(filename(context));
      const contexts = effectSleepExecutionContexts.get(node) ?? [];
      return contexts.some(
        ({ testCallback, executionNode }) =>
          shouldCheckSleepClock(testCallback, inIntegrationTest) &&
          !hasControlledSleepClockPath(node, testCallback, executionNode),
      );
    };
    const isAnalyzableEffectCall = (node) => {
      if (callbackAncestor(node, (call) => isTestCall(call, "live"))) return false;
      return (
        callbackAncestor(node, (call) => isTestCall(call, "effect")) ||
        hasAncestor(node, (ancestor) => executedEffectTestCallbacks.has(ancestor))
      );
    };
    return {
      Program() {
        forEachProgramImport(context.getSourceCode().ast, registerTimeoutImport);
        registerExecutedEffectSleepContexts(context.getSourceCode().ast);
        registerLexicalEffectSleepContexts(context.getSourceCode().ast);
      },
      CallExpression(node) {
        if (
          (isAnalyzableEffectCall(node) && isWallClockTimer(node)) ||
          shouldReportEffectSleep(node)
        )
          reportPolicy(node, "timeout");
      },
    };
  },
};

const exhaustiveDiagnosticTables = {
  meta: {
    type: "problem",
    docs: { description: "make designated diagnostic code tables exhaustive" },
    schema: [],
    messages: {
      exhaustive:
        "Diagnostic reason mappings must be exhaustive typed tables using satisfies Record<CanonicalReasonUnion, ...>.",
    },
  },
  create(context) {
    const reportPolicy = makePolicyReporter(context, "exhaustive-diagnostic-tables");
    const designatedFile = fileIs(context, "packages/developer-launcher/src/connected-preview.ts");
    const diagnosticTypeImports = new Map();
    const diagnosticNamespaceImports = new Map();
    const isDiagnosticTypeImportSpecifier = (specifier) =>
      allOf([
        isType(specifier, "ImportSpecifier"),
        read(read(specifier, "imported"), "name") === "Diagnostic",
      ]);
    const registerDiagnosticTypeSpecifier = (specifier) => {
      if (isType(specifier, "ImportNamespaceSpecifier")) {
        diagnosticNamespaceImports.set(read(read(specifier, "local"), "name"), "./types");
        return;
      }
      if (isDiagnosticTypeImportSpecifier(specifier))
        diagnosticTypeImports.set(read(read(specifier, "local"), "name"), "./types");
    };
    const registerDiagnosticTypeImports = (statement) => {
      if (read(statement, "source").value !== "./types") return;
      (read(statement, "specifiers") ?? []).forEach(registerDiagnosticTypeSpecifier);
    };
    forEachProgramImport(context.getSourceCode().ast, registerDiagnosticTypeImports);
    const sanitizerUnionImports = context.getSourceCode().ast.body.flatMap((statement) => {
      if (
        statement.type !== "ImportDeclaration" ||
        statement.source.value !== "sheet-workflow-contracts"
      )
        return [];
      return statement.specifiers
        .filter(
          (specifier) =>
            specifier.type === "ImportSpecifier" &&
            specifier.imported.name === "StagedSourceSnapshotValidationReason",
        )
        .map((specifier) => specifier.local);
    });
    const mappingKinds = new Map([
      ["doctorFailureCodes", "diagnostic"],
      ["safeStagedSourceSnapshotValidationReasons", "sanitizer"],
    ]);
    const mappingKind = (name) => mappingKinds.get(designatedFile ? name : undefined);
    const typeArguments = (node) =>
      read(read(node, "typeParameters"), "params") ??
      read(read(node, "typeArguments"), "params") ??
      [];
    const typeReferenceName = (node) => {
      const name = read(node, "typeName");
      if (isType(name, "Identifier")) return read(name, "name");
      return isType(name, "TSQualifiedName") ? read(read(name, "right"), "name") : undefined;
    };
    const isTypeReference = (node, name) =>
      isType(node, "TSTypeReference") && typeReferenceName(node) === name;
    const programBody = context.getSourceCode().ast.body;
    const canonicalPrerequisitesBindings = programBody.flatMap((statement) => {
      const declaration = isType(statement, "ExportNamedDeclaration")
        ? read(statement, "declaration")
        : statement;
      if (!isType(declaration, "VariableDeclaration")) return [];
      return declaration.declarations
        .map((item) => read(item, "id"))
        .filter((binding) => id(binding, "prerequisites"));
    });
    const canonicalPrerequisiteTypeBindings = programBody.flatMap((statement) =>
      isType(statement, "TSTypeAliasDeclaration") &&
      id(read(statement, "id"), "ConnectedPreviewPrerequisiteId")
        ? [read(statement, "id")]
        : [],
    );
    const canonicalPrerequisitesBinding =
      canonicalPrerequisitesBindings.length === 1 ? canonicalPrerequisitesBindings[0] : undefined;
    const canonicalPrerequisiteTypeBinding =
      canonicalPrerequisiteTypeBindings.length === 1
        ? canonicalPrerequisiteTypeBindings[0]
        : undefined;
    const isCanonicalPrerequisiteIdType = (node) =>
      allOf([
        isTypeReference(node, "ConnectedPreviewPrerequisiteId"),
        canonicalPrerequisiteTypeBinding !== undefined,
        resolvedTypeBindingIdentifier(read(node, "typeName")) === canonicalPrerequisiteTypeBinding,
      ]);
    const isCanonicalSanitizerUnionType = (node) =>
      allOf([
        isType(node, "TSTypeReference"),
        sanitizerUnionImports.length === 1,
        resolvedTypeBindingIdentifier(read(node, "typeName")) === sanitizerUnionImports[0],
      ]);
    const isCanonicalUtilityReference = (node, name) => {
      const typeName = read(node, "typeName");
      return allOf([
        isType(node, "TSTypeReference"),
        id(typeName, name),
        !isShadowedAtNode(typeName, name),
        !hasLocalTypeBinding(typeName, name),
      ]);
    };
    const literalTypeValue = (node) =>
      isType(node, "TSLiteralType") ? read(read(node, "literal"), "value") : undefined;
    const recordArguments = (type) => {
      let candidate = type;
      if (isCanonicalUtilityReference(candidate, "Readonly"))
        candidate = typeArguments(candidate)[0];
      return isCanonicalUtilityReference(candidate, "Record") ? typeArguments(candidate) : [];
    };
    const satisfiesRecordType = (node) => {
      let expression = read(node, "init");
      while (isType(expression, "TSAsExpression")) expression = read(expression, "expression");
      return isType(expression, "TSSatisfiesExpression") ? expression : undefined;
    };
    const isCanonicalDiagnosticImport = (name) => {
      const local = read(name, "name");
      return (
        diagnosticTypeImports.get(local) === "./types" &&
        !isShadowedAtNode(name, local, { ignoreProgram: true }) &&
        !hasLocalTypeBinding(name, local)
      );
    };
    const diagnosticNamespaceIdentifier = (name) => {
      const left = read(name, "left");
      const right = read(name, "right");
      if (!isType(left, "Identifier")) return undefined;
      if (read(right, "name") !== "Diagnostic") return undefined;
      return left;
    };
    const isCanonicalDiagnosticNamespace = (name) => {
      const left = diagnosticNamespaceIdentifier(name);
      if (left === undefined) return false;
      const local = read(left, "name");
      return canonicalDiagnosticNamespaceBinding(left, local);
    };
    const canonicalDiagnosticNamespaceBinding = (left, local) =>
      allOf([
        diagnosticNamespaceImports.get(local) === "./types",
        !isShadowedAtNode(left, local, { ignoreProgram: true }),
        !hasLocalTypeBinding(left, local),
      ]);
    const canonicalDiagnosticTypeReference = (node) => {
      const name = read(node, "typeName");
      return isType(name, "Identifier")
        ? isCanonicalDiagnosticImport(name)
        : isType(name, "TSQualifiedName") && isCanonicalDiagnosticNamespace(name);
    };
    const isDiagnosticCodeType = (type) => {
      const objectType = read(type, "objectType");
      return allOf([
        isType(type, "TSIndexedAccessType"),
        isType(objectType, "TSTypeReference"),
        canonicalDiagnosticTypeReference(objectType),
        literalTypeValue(read(type, "indexType")) === "code",
      ]);
    };
    const isCanonicalRecordType = (type, kind) => {
      const args = recordArguments(type);
      if (args.length !== 2) return false;
      if (kind === "sanitizer")
        return allOf([isCanonicalSanitizerUnionType(args[0]), literalTypeValue(args[1]) === true]);
      return allOf([isCanonicalPrerequisiteIdType(args[0]), isDiagnosticCodeType(args[1])]);
    };
    const isPrerequisiteIdIndex = (type) =>
      isType(type, "TSIndexedAccessType") && literalTypeValue(read(type, "indexType")) === "id";
    const isPrerequisiteArrayElement = (type) =>
      allOf([
        isType(type, "TSIndexedAccessType"),
        isType(read(type, "indexType"), "TSNumberKeyword"),
      ]);
    const namesPrerequisiteTable = (query) =>
      isType(query, "TSTypeQuery") && id(read(query, "exprName"), "prerequisites");
    const resolvesCanonicalPrerequisiteTable = (query) => {
      const name = read(query, "exprName");
      return (
        canonicalPrerequisitesBinding !== undefined &&
        resolvedBindingIdentifier(name) === canonicalPrerequisitesBinding
      );
    };
    const isCanonicalPrerequisiteTableQuery = (query) =>
      allOf([namesPrerequisiteTable(query), resolvesCanonicalPrerequisiteTable(query)]);
    const isDerivedPrerequisiteId = (type) => {
      if (!isPrerequisiteIdIndex(type)) return false;
      const indexedPrerequisites = read(type, "objectType");
      const query = read(indexedPrerequisites, "objectType");
      return (
        isPrerequisiteArrayElement(indexedPrerequisites) && isCanonicalPrerequisiteTableQuery(query)
      );
    };
    const isConstTypeAnnotation = (type) =>
      isType(type, "TSConstKeyword") ||
      allOf([isType(type, "TSTypeReference"), id(read(type, "typeName"), "const")]);
    const isConstAssertion = (expression) =>
      isType(expression, "TSAsExpression") &&
      isConstTypeAnnotation(read(expression, "typeAnnotation"));
    const mappingInitializer = (satisfies) => {
      const expression = read(satisfies, "expression");
      return isConstAssertion(expression) ? read(expression, "expression") : expression;
    };
    const isValidRecordMapping = (node, kind) => {
      const satisfies = satisfiesRecordType(node);
      return allOf([
        isType(mappingInitializer(satisfies), "ObjectExpression"),
        satisfies !== undefined,
        isCanonicalRecordType(read(satisfies, "typeAnnotation"), kind),
      ]);
    };
    const mappingIsInvalid = (node, kind) => !isValidRecordMapping(node, kind);
    const isDesignatedPrerequisiteIdAlias = (node) =>
      designatedFile && node.id.name === "ConnectedPreviewPrerequisiteId";
    const isCanonicalPrerequisiteIdAlias = (node) =>
      node.id === canonicalPrerequisiteTypeBinding &&
      isDerivedPrerequisiteId(read(node, "typeAnnotation"));
    return {
      VariableDeclarator(node) {
        const kind = mappingKind(read(read(node, "id"), "name"));
        if (kind && mappingIsInvalid(node, kind)) reportPolicy(node, "exhaustive");
      },
      TSTypeAliasDeclaration(node) {
        if (!isDesignatedPrerequisiteIdAlias(node)) return;
        if (!isCanonicalPrerequisiteIdAlias(node)) reportPolicy(node, "exhaustive");
      },
    };
  },
};

const preserveUnknownEvidence = {
  meta: {
    type: "problem",
    docs: { description: "preserve unknown ordinaryReassignmentBlocked evidence" },
    schema: [],
    messages: {
      unknown:
        "ordinaryReassignmentBlocked is nullable evidence: preserve unknown and do not coalesce it to false or coerce it to boolean.",
    },
  },
  create(context) {
    const reportPolicy = makePolicyReporter(context, "preserve-unknown-evidence");
    const designatedProducer = fileIs(
      context,
      "packages/developer-launcher/src/connected-preview.ts",
    );
    const canonicalContract = fileIs(
      context,
      "packages/sheet-workflow-contracts/src/stagedSource.ts",
    );
    const isRecoverySchemaDeclaration = (node) =>
      allOf([
        isType(node, "VariableDeclarator"),
        id(read(node, "id"), "WorkflowRecreationRecoverySchema"),
      ]);
    const isCanonicalRecoverySchemaProperty = (node) =>
      hasAncestor(node, isRecoverySchemaDeclaration);
    const isRecoveryDecoderArgument = (object) =>
      allOf([
        isType(object, "ObjectExpression"),
        isType(read(object, "parent"), "CallExpression"),
        (read(read(object, "parent"), "arguments") ?? []).includes(object),
        isType(read(read(object, "parent"), "callee"), "CallExpression"),
        member(read(read(read(object, "parent"), "callee"), "callee"), "decodeUnknownEffect"),
        id(
          (read(read(read(object, "parent"), "callee"), "arguments") ?? [])[0],
          "WorkflowRecreationRecoverySchema",
        ),
      ]);
    const isCanonicalRecoveryValue = (node) => {
      return hasAncestor(read(node, "parent"), isRecoveryDecoderArgument);
    };
    const recoveryProducerNames = new Set([
      "preserveFreshSessionRecovery",
      "quarantineOldGroupAfterActivationFailure",
    ]);
    const isRecoveryProducerDeclaration = (node) =>
      anyOf([
        allOf([
          isType(node, "FunctionDeclaration"),
          recoveryProducerNames.has(read(read(node, "id"), "name")),
        ]),
        allOf([
          isType(node, "VariableDeclarator"),
          recoveryProducerNames.has(read(read(node, "id"), "name")),
        ]),
      ]);
    const isRecoveryProducerField = (node) => hasAncestor(node, isRecoveryProducerDeclaration);
    const sameBoundIdentifier = (left, right) => {
      if (!allOf([isType(left, "Identifier"), isType(right, "Identifier")])) return false;
      return allOf([
        read(left, "name") === read(right, "name"),
        resolvedBindingIdentifier(left) === resolvedBindingIdentifier(right),
      ]);
    };
    const stableAliasOrigin = (node, seen = new Set()) => {
      if (!isType(node, "Identifier")) return undefined;
      const binding = resolvedBindingIdentifier(node);
      if (binding === undefined || seen.has(binding)) return undefined;
      const initializer = stableConstInitializerForBinding(binding);
      return isType(initializer, "Identifier")
        ? stableAliasOrigin(initializer, new Set(seen).add(binding))
        : { binding, snapshot: initializer === undefined ? node : undefined };
    };
    const aliasOriginsMatch = (left, right) => {
      const leftOrigin = stableAliasOrigin(left);
      const rightOrigin = stableAliasOrigin(right);
      return (
        leftOrigin !== undefined &&
        rightOrigin !== undefined &&
        leftOrigin.binding === rightOrigin.binding
      );
    };
    const aliasValuesMayDiffer = (left, right) => {
      const leftOrigin = stableAliasOrigin(left);
      const rightOrigin = stableAliasOrigin(right);
      if (
        leftOrigin === undefined ||
        rightOrigin === undefined ||
        leftOrigin.binding !== rightOrigin.binding ||
        leftOrigin.snapshot === undefined ||
        rightOrigin.snapshot === undefined ||
        leftOrigin.snapshot === rightOrigin.snapshot
      )
        return false;
      const binding = leftOrigin.binding;
      const writes = writeExpressionsForBinding(binding);
      if (writes.length === 0) return false;
      const scope = nearestBindingScope(binding, read(binding, "name"));
      if (scope === undefined) return true;
      return writes.some((write) =>
        writeCanSeparateAliasValues(write, leftOrigin.snapshot, rightOrigin.snapshot, scope),
      );
    };
    const sameBoundOrStableAlias = (left, right) =>
      sameBoundIdentifier(left, right) ||
      (aliasOriginsMatch(left, right) && !aliasValuesMayDiffer(left, right));
    const isNullLiteral = (node) =>
      isType(node, "NullLiteral") || allOf([isType(node, "Literal"), literal(node) === null]);
    const staticBooleanValueForEvidence = (node) => staticBooleanValueForStableConst(node);
    const nullComparedIdentifier = (test) => {
      if (!isType(test, "BinaryExpression")) return undefined;
      if (!["==", "===", "!=", "!=="].includes(read(test, "operator"))) return undefined;
      const left = read(test, "left");
      const right = read(test, "right");
      if (isNullLiteral(left) && isType(right, "Identifier")) return right;
      if (isNullLiteral(right) && isType(left, "Identifier")) return left;
      return undefined;
    };
    const booleanComparedIdentifier = (test) => {
      if (!isType(test, "BinaryExpression")) return undefined;
      if (!["==", "===", "!=", "!=="].includes(read(test, "operator"))) return undefined;
      const left = read(test, "left");
      const right = read(test, "right");
      if (isType(left, "Identifier") && typeof staticBooleanValueForEvidence(right) === "boolean")
        return left;
      if (isType(right, "Identifier") && typeof staticBooleanValueForEvidence(left) === "boolean")
        return right;
      return undefined;
    };
    const isGlobalBooleanCall = (value) => {
      if (!isType(value, "CallExpression")) return false;
      const callee = read(value, "callee");
      if (id(callee, "Boolean")) return !isShadowedAtNode(callee, "Boolean");
      const object = read(callee, "object");
      return (
        isType(callee, "MemberExpression") &&
        staticMemberName(callee) === "Boolean" &&
        id(object, "globalThis") &&
        !isShadowedAtNode(object, "globalThis")
      );
    };
    const invertNullableCondition = (condition) =>
      condition === undefined ? undefined : { ...condition, testIsTrue: !condition.testIsTrue };
    const nullableTruthinessCondition = (test, resolve) => {
      if (isType(test, "Identifier")) return { value: test, testIsTrue: false };
      if (!isType(test, "UnaryExpression") || read(test, "operator") !== "!") return undefined;
      return invertNullableCondition(resolve(read(test, "argument")));
    };
    const nullableBooleanCondition = (test, resolve) => {
      if (!isGlobalBooleanCall(test)) return undefined;
      const argumentsList = read(test, "arguments") ?? [];
      return argumentsList.length === 1 ? resolve(argumentsList[0]) : undefined;
    };
    const nullableNullishLogicalCondition = (left, right, condition) => {
      const leftIsNullableValue =
        isType(left, "Identifier") && sameBoundOrStableAlias(left, condition.value);
      if (leftIsNullableValue) return nullableLogicalRightCondition(right, condition);
      const leftIsBooleanValue =
        isGlobalBooleanCall(left) ||
        (isType(left, "UnaryExpression") && read(left, "operator") === "!") ||
        nullableComparisonCondition(left) !== undefined;
      return leftIsBooleanValue ? condition : undefined;
    };
    const nullableAndOrLogicalCondition = (operator, right, condition) => {
      if (operator === "&&" && !condition.testIsTrue) return { ...condition, testIsTrue: false };
      if (operator === "||" && condition.testIsTrue) return { ...condition, testIsTrue: true };
      return nullableLogicalRightCondition(right, condition);
    };
    const nullableLogicalCondition = (test) => {
      if (!isType(test, "LogicalExpression")) return undefined;
      const operator = read(test, "operator");
      if (!["&&", "||", "??"].includes(operator)) return undefined;
      const left = read(test, "left");
      const condition = nullableConditionForNull(left);
      if (condition === undefined) return undefined;
      if (operator === "??")
        return nullableNullishLogicalCondition(left, read(test, "right"), condition);
      return nullableAndOrLogicalCondition(operator, read(test, "right"), condition);
    };
    const nullableLogicalRightCondition = (right, condition) => {
      const value = staticBooleanValueForEvidence(right);
      if (typeof value === "boolean") return { ...condition, testIsTrue: value };
      if (isNullLiteral(right)) return { ...condition, testIsTrue: false };
      const rightCondition = nullableConditionForNull(right);
      return rightCondition !== undefined &&
        sameBoundOrStableAlias(rightCondition.value, condition.value)
        ? rightCondition
        : undefined;
    };
    const nullableComparisonCondition = (test) => {
      const nullCompared = nullComparedIdentifier(test);
      if (nullCompared !== undefined)
        return {
          value: nullCompared,
          testIsTrue: ["==", "==="].includes(read(test, "operator")),
        };
      const booleanCompared = booleanComparedIdentifier(test);
      if (booleanCompared !== undefined)
        return {
          value: booleanCompared,
          testIsTrue: ["!=", "!=="].includes(read(test, "operator")),
        };
      return undefined;
    };
    const nullableConditionForNull = (test) =>
      nullableTruthinessCondition(test, nullableConditionForNull) ??
      nullableBooleanCondition(test, nullableConditionForNull) ??
      nullableComparisonCondition(test) ??
      nullableLogicalCondition(test);
    const isUnknownBooleanConversion = (value) =>
      anyOf([
        allOf([
          isType(value, "LogicalExpression"),
          ["??", "||"].includes(read(value, "operator")),
          staticBooleanValueForEvidence(read(value, "right")) !== undefined,
        ]),
        isGlobalBooleanCall(value),
        allOf([isType(value, "UnaryExpression"), read(value, "operator") === "!"]),
        allOf([
          isType(value, "ConditionalExpression"),
          staticBooleanValueForEvidence(read(value, "consequent")) !== undefined,
          staticBooleanValueForEvidence(read(value, "alternate")) !== undefined,
        ]),
      ]);
    const nullBranchPreservesUnknown = (branch, conditionValue) =>
      sameBoundOrStableAlias(branch, conditionValue) || isNullLiteral(branch);
    const nullBranchBooleanizesUnknown = (branch, conditionValue) => {
      const result = resultExpressionAfterSequences(branch);
      const booleanComparison = booleanComparedIdentifier(result);
      return anyOf([
        allOf([
          isType(result, "Identifier"),
          aliasOriginsMatch(result, conditionValue),
          aliasValuesMayDiffer(result, conditionValue),
        ]),
        staticBooleanValueForEvidence(result) !== undefined,
        isUnknownBooleanConversion(result),
        allOf([
          booleanComparison !== undefined,
          aliasOriginsMatch(booleanComparison, conditionValue),
        ]),
      ]);
    };
    const resultExpressionAfterSequences = (value) => {
      if (!isType(value, "SequenceExpression")) return value;
      const expressions = read(value, "expressions") ?? [];
      return expressions.length === 0
        ? undefined
        : resultExpressionAfterSequences(expressions[expressions.length - 1]);
    };
    const isUnknownErasingConditional = (value) => {
      const result = resultExpressionAfterSequences(value);
      if (!isType(result, "ConditionalExpression")) return false;
      const test = read(result, "test");
      const condition = nullableConditionForNull(test);
      if (condition === undefined) return false;
      const nullBranch = resultExpressionAfterSequences(
        read(result, condition.testIsTrue ? "consequent" : "alternate"),
      );
      return (
        !nullBranchPreservesUnknown(nullBranch, condition.value) &&
        nullBranchBooleanizesUnknown(nullBranch, condition.value)
      );
    };
    const isUnknownCoercion = (value) => {
      const result = resultExpressionAfterSequences(value);
      return isUnknownBooleanConversion(result) || isUnknownErasingConditional(result);
    };
    const isDesignatedProducerEvidence = (node) =>
      designatedProducer && (isCanonicalRecoveryValue(node) || isRecoveryProducerField(node));
    const isOrdinaryReassignmentProperty = (node) =>
      (read(node, "computed") ? literal(read(node, "key")) : read(read(node, "key"), "name")) ===
      "ordinaryReassignmentBlocked";
    const isInvalidEvidenceProperty = (node) =>
      anyOf([
        allOf([
          canonicalContract,
          isCanonicalRecoverySchemaProperty(node),
          !/^Schema\.NullOr\(Schema\.Boolean\)$/.test(
            context.getSourceCode().getText(read(node, "value")),
          ),
        ]),
        allOf([
          !canonicalContract,
          isDesignatedProducerEvidence(node),
          isUnknownCoercion(read(node, "value")),
        ]),
      ]);
    return {
      Property(node) {
        if (isOrdinaryReassignmentProperty(node) && isInvalidEvidenceProperty(node))
          reportPolicy(node, "unknown");
      },
    };
  },
};

const canonicalLifecycleContracts = {
  meta: {
    type: "problem",
    docs: {
      description: "import designated lifecycle schemas and types from their canonical contract",
    },
    schema: [],
    messages: {
      contract:
        "Lifecycle schema/type must be imported from its canonical contract instead of being redeclared locally.",
    },
  },
  create(context) {
    const reportPolicy = makePolicyReporter(context, "canonical-lifecycle-contracts");
    const namespaceContracts = new Map();
    const canonicalContracts = new Map([
      [
        "LifecyclePhase",
        {
          module: "./owned-application-contract",
          definition: "packages/developer-launcher/src/owned-application-contract.ts",
        },
      ],
    ]);
    const canonicalNamedImportBindings = new Map();
    const isCanonicalDefinition = (name) =>
      filename(context) === canonicalContracts.get(name)?.definition;
    const canonicalContractName = (name) => canonicalContracts.has(name);
    const hasLocalLiteralSchema = (node) => {
      let found = false;
      walkAst(node, (current) => {
        if (
          anyOf([
            member(read(current, "callee"), "Literals"),
            member(read(current, "callee"), "Literal"),
          ])
        ) {
          found = true;
          return false;
        }
        return undefined;
      });
      return found;
    };
    const shouldReportLocalLifecycleSchema = (node) => {
      const name = read(read(node, "id"), "name");
      return allOf([
        isType(read(node, "id"), "Identifier"),
        canonicalContractName(name),
        !isCanonicalDefinition(name),
        read(node, "init") !== undefined,
        hasLocalLiteralSchema(read(node, "init")),
      ]);
    };
    const wrongCanonicalNamedImport = (source, specifier) => {
      const importedName = read(read(specifier, "imported"), "name");
      const localName = read(read(specifier, "local"), "name");
      const exportedContract = canonicalContracts.get(importedName);
      const locallyNamedContract = canonicalContracts.get(localName);
      if (exportedContract !== undefined) return source !== read(exportedContract, "module");
      if (locallyNamedContract === undefined) return false;
      return anyOf([importedName !== localName, source !== read(locallyNamedContract, "module")]);
    };
    const wrongCanonicalDefaultImport = (specifier) =>
      allOf([
        isType(specifier, "ImportDefaultSpecifier"),
        canonicalContracts.has(read(read(specifier, "local"), "name")),
      ]);
    const wrongCanonicalImport = (node, specifier) => {
      const source = read(node, "source").value;
      return isType(specifier, "ImportSpecifier")
        ? wrongCanonicalNamedImport(source, specifier)
        : wrongCanonicalDefaultImport(specifier);
    };
    const registerCanonicalNamedImport = (node, specifier) => {
      if (!isType(specifier, "ImportSpecifier")) return;
      const importedName = read(read(specifier, "imported"), "name");
      const contract = canonicalContracts.get(importedName);
      if (contract === undefined || read(node, "source").value !== read(contract, "module")) return;
      const local = read(specifier, "local");
      canonicalNamedImportBindings.set(read(local, "name"), local);
    };
    const isShadowedCanonicalNamedImportUse = (node) => {
      const local = canonicalNamedImportBindings.get(read(node, "name"));
      const parent = read(node, "parent");
      return (
        local !== undefined &&
        isType(parent, "TSTypeReference") &&
        read(parent, "typeName") === node &&
        resolvedTypeBindingIdentifier(node) !== local
      );
    };
    const isDefaultNamespaceImport = (specifier) =>
      isType(specifier, "ImportDefaultSpecifier") ||
      allOf([
        isType(specifier, "ImportSpecifier"),
        read(read(specifier, "imported"), "name") === "default",
      ]);
    const namespaceImportKind = (specifier) => {
      if (isDefaultNamespaceImport(specifier)) return "default";
      if (isType(specifier, "ImportNamespaceSpecifier")) return "namespace";
      return undefined;
    };
    const registerNamespaceContract = (node, specifier) => {
      const source = read(node, "source").value;
      const importKind = namespaceImportKind(specifier);
      if (importKind !== undefined)
        namespaceContracts.set(read(read(specifier, "local"), "name"), { source, importKind });
    };
    const canonicalNamespaceBindingName = (namespace) =>
      isType(namespace, "Identifier") ? read(namespace, "name") : undefined;
    const namespaceBindingIsUnshadowed = (namespace, name) =>
      !isShadowedAtNode(namespace, name, { ignoreProgram: true }) &&
      !hasLocalTypeBinding(namespace, name);
    const canonicalNamespaceSourceForBinding = (namespace) => {
      const name = canonicalNamespaceBindingName(namespace);
      if (name === undefined) return undefined;
      const importInfo = namespaceContracts.get(name);
      if (importInfo === undefined) return undefined;
      return namespaceBindingIsUnshadowed(namespace, name) ? importInfo : undefined;
    };
    const canonicalNamespaceSourceForMember = (node) =>
      canonicalNamespaceSourceForBinding(read(node, "object"));
    const wrongCanonicalNamespace = (importInfo, name) => {
      const contract = canonicalContracts.get(name);
      return (
        importInfo !== undefined &&
        contract !== undefined &&
        (read(importInfo, "importKind") === "default" ||
          read(importInfo, "source") !== read(contract, "module"))
      );
    };
    const wrongCanonicalNamespaceMember = (node) =>
      wrongCanonicalNamespace(canonicalNamespaceSourceForMember(node), staticMemberName(node));
    const qualifiedNamespaceRoot = (node) => {
      if (isType(node, "TSQualifiedName")) return qualifiedNamespaceRoot(read(node, "left"));
      if (isType(node, "Identifier")) return node;
      return undefined;
    };
    const qualifiedNameTail = (node) =>
      isType(node, "TSQualifiedName") ? read(read(node, "right"), "name") : read(node, "name");
    const canonicalNamespaceSourceForType = (node) => {
      const namespace = qualifiedNamespaceRoot(node);
      return canonicalNamespaceSourceForBinding(namespace);
    };
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          registerNamespaceContract(node, specifier);
          registerCanonicalNamedImport(node, specifier);
          if (wrongCanonicalImport(node, specifier)) reportPolicy(specifier, "contract");
        }
      },
      Identifier(node) {
        if (isShadowedCanonicalNamedImportUse(node)) reportPolicy(node, "contract");
      },
      MemberExpression(node) {
        if (wrongCanonicalNamespaceMember(node)) reportPolicy(node, "contract");
      },
      TSQualifiedName(node) {
        if (wrongCanonicalNamespace(canonicalNamespaceSourceForType(node), qualifiedNameTail(node)))
          reportPolicy(node, "contract");
      },
      VariableDeclarator(node) {
        if (shouldReportLocalLifecycleSchema(node)) reportPolicy(node, "contract");
      },
      TSTypeAliasDeclaration(node) {
        if (!isCanonicalDefinition(node.id.name) && canonicalContractName(node.id.name))
          reportPolicy(node, "contract");
      },
      TSEnumDeclaration(node) {
        if (!isCanonicalDefinition(node.id.name) && canonicalContractName(node.id.name))
          reportPolicy(node, "contract");
      },
    };
  },
};

const countBuiltinEntries = (entries) => {
  const remaining = new Map();
  for (const entry of entries) {
    const identity = entry.site === undefined ? ["source", entry.source] : ["site", entry.site];
    const key = JSON.stringify([entry.rule, ...identity]);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return remaining;
};
const supportedBuiltinRules =
  "typescript/(?:no-unsafe-type-assertion|restrict-template-expressions)";
const builtinDirectivePatterns = [
  {
    kind: "disable",
    pattern: new RegExp(`^oxlint-disable (${supportedBuiltinRules}) -- inherited master site$`),
  },
  {
    kind: "enable",
    pattern: new RegExp(`^oxlint-enable (${supportedBuiltinRules}) -- inherited master site$`),
  },
  {
    kind: "legacy",
    pattern: new RegExp(
      `^oxlint-disable-(?:line|next-line) (${supportedBuiltinRules}) -- inherited master site$`,
    ),
  },
  {
    kind: "malformed",
    pattern: new RegExp(
      `^oxlint-(?:disable|enable)(?:-(?:line|next-line))? (${supportedBuiltinRules})(?:\\s|$)`,
    ),
  },
];
const builtinDirectiveMatch = (value) =>
  builtinDirectivePatterns.find(({ pattern }) => pattern.test(value));
const builtinDirective = (comment) => {
  const value = (read(comment, "value") ?? "").trim();
  const match = builtinDirectiveMatch(value);
  if (match === undefined) return undefined;
  const [, rule] = value.match(match.pattern);
  return { kind: match.kind, rule };
};
const commentRange = (comment) => {
  const range = read(comment, "range");
  return Array.isArray(range) && range.length === 2 ? range : undefined;
};
const appendMalformed = (state, ...comments) => state.malformed.push(...comments);
const recordDisableDirective = (comment, rule, range, state) => {
  const opening = state.active.get(rule);
  if (opening === undefined) {
    state.active.set(rule, { comment, range });
    return;
  }
  appendMalformed(state, opening.comment, comment);
  state.active.delete(rule);
};
const recordEnableDirective = (comment, rule, range, state) => {
  const opening = state.active.get(rule);
  if (opening === undefined || range[0] <= opening.range[1]) {
    appendMalformed(state, comment);
    return;
  }
  state.active.delete(rule);
  state.pairs.push({ rule, open: opening, close: { comment, range } });
};
const recordRangedDirective = (comment, directive, state) => {
  const range = commentRange(comment);
  if (range === undefined) {
    appendMalformed(state, comment);
    return;
  }
  if (directive.kind === "disable") {
    recordDisableDirective(comment, directive.rule, range, state);
    return;
  }
  recordEnableDirective(comment, directive.rule, range, state);
};
const recordBuiltinDirective = (comment, state) => {
  const directive = builtinDirective(comment);
  if (directive === undefined) return;
  if (directive.kind === "legacy" || directive.kind === "malformed") {
    appendMalformed(state, comment);
    return;
  }
  recordRangedDirective(comment, directive, state);
};
const pairedBuiltinDirectives = (comments) => {
  const state = { active: new Map(), pairs: [], malformed: [] };
  comments.forEach((comment) => recordBuiltinDirective(comment, state));
  state.active.forEach(({ comment }) => appendMalformed(state, comment));
  return { pairs: state.pairs, malformed: state.malformed };
};
const rangeIsWhitespace = (text, start, end) =>
  start <= end && text.slice(start, end).trim() === "";
const hasRange = (range) => Array.isArray(range);
const assertionBoundary = (node) => {
  const expressionRange = read(read(node, "expression"), "range");
  const typeRange = read(read(node, "typeAnnotation"), "range");
  const nodeRange = read(node, "range");
  if (![expressionRange, typeRange, nodeRange].every(hasRange)) return undefined;
  return {
    expressionEnd: expressionRange[1],
    typeStart: typeRange[0],
    nodeEnd: nodeRange[1],
  };
};
const assertionOpeningFits = (boundary, pair) =>
  pair.open.range[0] >= boundary.expressionEnd && pair.open.range[1] <= boundary.typeStart;
const assertionOpeningTextFits = (boundary, pair, text) =>
  /^[\s)]*$/.test(text.slice(boundary.expressionEnd, pair.open.range[0])) &&
  text.slice(pair.open.range[1], boundary.typeStart).trim() === "as";
const assertionClosingFits = (boundary, pair, text) =>
  pair.close.range[0] >= boundary.nodeEnd &&
  /^[\s()]*$/.test(text.slice(boundary.nodeEnd, pair.close.range[0]));
const assertionCandidateBoundedByPair = (boundary, pair, text) =>
  [
    assertionOpeningFits(boundary, pair),
    assertionOpeningTextFits(boundary, pair, text),
    assertionClosingFits(boundary, pair, text),
  ].every(Boolean);
const pairContainsCandidateRange = (range, pair) =>
  pair.open.range[1] <= range[0] && range[1] <= pair.close.range[0];
const pairSeparatesRangeWithWhitespace = (range, pair, text) =>
  rangeIsWhitespace(text, pair.open.range[1], range[0]) &&
  rangeIsWhitespace(text, range[1], pair.close.range[0]);
const rangedCandidateBoundedByPair = (range, pair, text) =>
  hasRange(range) &&
  range.length === 2 &&
  pairContainsCandidateRange(range, pair) &&
  pairSeparatesRangeWithWhitespace(range, pair, text);
const candidateIsBoundedByPair = (candidate, pair, text) =>
  candidate.assertionBoundary !== undefined
    ? assertionCandidateBoundedByPair(candidate.assertionBoundary, pair, text)
    : rangedCandidateBoundedByPair(candidate.pairRange, pair, text);
const isPairedDirective = (comment) => {
  const kind = builtinDirective(comment)?.kind;
  return kind === "disable" || kind === "enable";
};
const isDirectiveOnLine = (lineNumber) => (comment) =>
  comment.loc.start.line === lineNumber &&
  comment.loc.end.line === lineNumber &&
  commentRange(comment) !== undefined &&
  isPairedDirective(comment);
const sourceLineWithoutBuiltinDirectives = (source, lineNumber, comments) => {
  const directives = comments.filter(isDirectiveOnLine(lineNumber));
  let line = source.getLines()[lineNumber - 1] ?? "";
  for (const comment of directives.slice().sort((left, right) => right.range[0] - left.range[0])) {
    const { start, end } = comment.loc;
    line = line.slice(0, start.column) + line.slice(end.column);
  }
  return line.trimEnd();
};
const isNestedTypeAssertion = (node) =>
  allOf([
    isType(read(node, "parent"), "TSAsExpression"),
    read(read(node, "parent"), "expression") === node,
  ]);
const builtinSiteAdoption = {
  meta: {
    type: "problem",
    docs: { description: "reject changed or new sites covered by built-in rule baseline comments" },
    schema: [],
    messages: {
      baseline:
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
      orphan: "An inherited built-in baseline entry no longer has its original source site.",
    },
  },
  create(context) {
    const source = context.getSourceCode();
    const file = filename(context);
    const suiteAliases = new Set();
    const suiteNamespaces = new Set();
    const suiteImportSources = new Set(["@effect/vitest", "vitest"]);
    const registerSuiteIdentitySpecifier = (specifier) => {
      if (isType(specifier, "ImportNamespaceSpecifier"))
        suiteNamespaces.add(read(read(specifier, "local"), "name"));
      if (isSuiteIdentityNamedSpecifier(specifier))
        suiteAliases.add(read(read(specifier, "local"), "name"));
    };
    const isSuiteIdentityNamedSpecifier = (specifier) =>
      isType(specifier, "ImportSpecifier") &&
      ["describe", "suite"].includes(read(read(specifier, "imported"), "name"));
    const registerSuiteIdentityImport = (statement) => {
      if (!suiteImportSources.has(read(statement, "source").value)) return;
      for (const specifier of read(statement, "specifiers") ?? [])
        registerSuiteIdentitySpecifier(specifier);
    };
    forEachProgramImport(source.ast, registerSuiteIdentityImport);
    const isUnboundGlobalSuiteCall = (callee, name) =>
      (name === "describe" || name === "suite") && !isShadowedAtNode(callee, name);
    const directSuiteIdentityCall = (callee) => {
      if (!isType(callee, "Identifier")) return false;
      const name = read(callee, "name");
      if (isShadowedAtNode(callee, name, { ignoreProgram: true })) return false;
      return suiteAliases.has(name) || isUnboundGlobalSuiteCall(callee, name);
    };
    const namespaceSuiteIdentityCall = (callee) => {
      const namespace = read(callee, "object");
      const memberName = staticMemberName(callee);
      if (!isType(namespace, "Identifier") || !["describe", "suite"].includes(memberName))
        return false;
      const name = read(namespace, "name");
      return (
        suiteNamespaces.has(name) && !isShadowedAtNode(namespace, name, { ignoreProgram: true })
      );
    };
    const isSuiteIdentityCall = (call) => {
      const callee = read(call, "callee");
      return directSuiteIdentityCall(callee) || namespaceSuiteIdentityCall(callee);
    };
    const identityOptions = { isSuiteCall: isSuiteIdentityCall };
    const entries = baseline.$builtins?.[file] ?? [];
    const remaining = countBuiltinEntries(entries);
    const candidateSites = [];
    const consume = (key) => {
      const count = remaining.get(key) ?? 0;
      if (count <= 0) return false;
      if (count === 1) remaining.delete(key);
      else remaining.set(key, count - 1);
      return true;
    };
    const candidateIdentityNode = (candidate) => candidate.identityNode ?? candidate.node;
    const siteKeyForCandidate = (rule, candidate) =>
      JSON.stringify([
        rule,
        "site",
        builtinSiteIdentity(candidateIdentityNode(candidate), rule, source, identityOptions),
      ]);
    const reportGenerationSite = (node, rule, line, identityNode = node, occurrenceRange) => {
      const site = builtinSiteIdentity(identityNode, rule, source, identityOptions);
      const detail = JSON.stringify({
        file,
        rule,
        site,
        legacySite: builtinSiteIdentityLegacy(identityNode, rule, source),
        line,
        source: sourceLineWithoutBuiltinDirectives(source, line, source.getAllComments()),
        expression: source.getText(identityNode),
        ...(identityNode === node
          ? {}
          : { previousTemplateSite: builtinSiteIdentity(node, rule, source, identityOptions) }),
        ...(occurrenceRange === undefined ? {} : { occurrenceRange }),
      });
      context.report({ node, message: "builtinbaseline:" + detail });
    };
    const reportMarker = (comment) => context.report({ loc: comment.loc, messageId: "baseline" });
    const reportGenerationForPair = (candidate, pair) => {
      if (process.env.TIARA_BUILTIN_BASELINE_MODE !== "1") return false;
      reportGenerationSite(
        candidate.node,
        pair.rule,
        candidate.line,
        candidateIdentityNode(candidate),
        candidate.pairRange,
      );
      return true;
    };
    const isGenerationMode = () => process.env.TIARA_BUILTIN_BASELINE_MODE === "1";
    const shouldReportMalformedMarker = (comment) =>
      !isGenerationMode() || builtinDirective(comment)?.kind !== "legacy";
    const reportMalformedMarkers = (comments) =>
      comments.filter(shouldReportMalformedMarker).forEach(reportMarker);
    const candidatesForPair = (pair, text) =>
      candidateSites.filter(
        (candidate) =>
          candidate.rule === pair.rule && candidateIsBoundedByPair(candidate, pair, text),
      );
    const reportPairMarkers = (pair) => {
      reportMarker(pair.open.comment);
      reportMarker(pair.close.comment);
    };
    const validatePair = (pair, text) => {
      const candidates = candidatesForPair(pair, text);
      if (candidates.length !== 1) return reportPairMarkers(pair);
      const [candidate] = candidates;
      if (reportGenerationForPair(candidate, pair)) return;
      if (!consume(siteKeyForCandidate(pair.rule, candidate))) reportPairMarkers(pair);
    };
    const reportOrphanEntries = (program) => {
      const unused = [...remaining.values()].reduce((total, count) => total + count, 0);
      if (unused > 0) context.report({ node: program, messageId: "orphan" });
    };
    const validatePairs = (pairs, malformed, program) => {
      const text = source.getText();
      reportMalformedMarkers(malformed);
      pairs.forEach((pair) => validatePair(pair, text));
      if (!isGenerationMode()) reportOrphanEntries(program);
    };
    const legacyMarkerTargetLine = (comment) =>
      comment.loc.start.line + (comment.value.includes("oxlint-disable-next-line") ? 1 : 0);
    const candidateForLegacyMarker = (comment, directive) => {
      const targetLine = legacyMarkerTargetLine(comment);
      const candidate = candidateSites.find(
        (site) => site.rule === directive.rule && site.line === targetLine,
      );
      return { candidate, targetLine };
    };
    const validateLegacyGenerationMarker = (comment) => {
      const directive = builtinDirective(comment);
      if (directive?.kind !== "legacy") return;
      const { candidate, targetLine } = candidateForLegacyMarker(comment, directive);
      if (candidate) reportGenerationSite(candidate.node, directive.rule, targetLine);
    };
    const validateLegacyGenerationMarkers = (comments) => {
      if (!isGenerationMode()) return;
      comments.forEach(validateLegacyGenerationMarker);
    };
    return {
      TSAsExpression(node) {
        if (isNestedTypeAssertion(node)) return;
        candidateSites.push({
          rule: "typescript/no-unsafe-type-assertion",
          node: builtinLineSiteNode(node),
          assertionBoundary: assertionBoundary(node),
          line: node.loc.start.line,
        });
      },
      TemplateLiteral(node) {
        for (const expression of node.expressions) {
          candidateSites.push({
            rule: "typescript/restrict-template-expressions",
            node: builtinLineSiteNode(node),
            identityNode: builtinLineSiteNode(expression),
            pairRange: read(expression, "range"),
            line: read(read(expression, "loc"), "start")?.line,
          });
        }
      },
      "Program:exit"(program) {
        const comments = source.getAllComments();
        const { pairs, malformed } = pairedBuiltinDirectives(comments);
        validatePairs(pairs, malformed, program);
        validateLegacyGenerationMarkers(comments);
      },
    };
  },
};

const rules = {
  "no-nested-ternary-adoption": noNestedTernaryAdoption,
  "effect-predicate": requirePredicateCombinators,
  "effect-match": preferMatchForTaggedDispatch,
  "effect-live-test": requireLiveInEffectTests,
  "controlled-test-timeouts": controlledTimeouts,
  "exhaustive-diagnostic-tables": exhaustiveDiagnosticTables,
  "preserve-unknown-evidence": preserveUnknownEvidence,
  "canonical-lifecycle-contracts": canonicalLifecycleContracts,
  "builtin-site-adoption": builtinSiteAdoption,
};

export default { meta: { name: "tiara-effect-policy" }, rules };
