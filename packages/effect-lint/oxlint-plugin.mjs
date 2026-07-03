const createRule = (message, create) => ({
  meta: {
    type: "suggestion",
    docs: { description: message },
    messages: { default: message },
    schema: [],
  },
  create,
});

const propertyName = (node) => {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal") return String(node.value);
  return undefined;
};

const calleePropertyName = (node) =>
  node?.type === "MemberExpression" ? propertyName(node.property) : undefined;

const calleeObjectName = (node) =>
  node?.type === "MemberExpression" && node.object.type === "Identifier"
    ? node.object.name
    : undefined;

const isIdentifier = (node, name) => node?.type === "Identifier" && node.name === name;

const isEffectMemberCall = (node, method) =>
  node?.type === "CallExpression" &&
  calleePropertyName(node.callee) === method &&
  calleeObjectName(node.callee) === "Effect";

const isSchemaMemberCall = (node, method) =>
  node?.type === "CallExpression" &&
  calleePropertyName(node.callee) === method &&
  calleeObjectName(node.callee) === "Schema";

const isUndefinedExpression = (node) =>
  isIdentifier(node, "undefined") || (node?.type === "UnaryExpression" && node.operator === "void");

const blockHasNoReturn = (node) =>
  node.type === "BlockStatement" &&
  node.body.every((statement) => statement.type !== "ReturnStatement");

const isVoidReturningArrow = (node) =>
  node?.type === "ArrowFunctionExpression" &&
  (isUndefinedExpression(node.body) || blockHasNoReturn(node.body));

const shouldVisit = ([key, value]) =>
  key !== "parent" && !key.startsWith("_") && value && typeof value === "object";

const childNodes = (node) =>
  Object.entries(node)
    .filter(shouldVisit)
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));

const visitYieldCandidate = (current, visited, stack) => {
  if (!current || visited.has(current)) return false;
  if (current.type === "YieldExpression") return true;
  visited.add(current);
  stack.push(...childNodes(current));
  return false;
};

const containsYield = (node) => {
  const stack = [node];
  const visited = new Set();

  for (const current of stack) {
    if (visitYieldCandidate(current, visited, stack)) return true;
  }

  return false;
};

const hasLiteralTagProperty = (shape) =>
  shape.properties.some(
    (property) =>
      property.type === "Property" &&
      propertyName(property.key) === "_tag" &&
      isSchemaMemberCall(property.value, "Literal"),
  );

const isObjectExpression = (node) => node?.type === "ObjectExpression";

const isSchemaStructWithLiteralTag = (node) => {
  const [shape] = node.arguments;
  return (
    isSchemaMemberCall(node, "Struct") && isObjectExpression(shape) && hasLiteralTagProperty(shape)
  );
};

const isSingleReturnArrow = (node) =>
  node.body.type === "BlockStatement" &&
  node.body.body.length === 1 &&
  node.body.body[0]?.type === "ReturnStatement";

const isSchemaUnionOfLiterals = (node) =>
  isSchemaMemberCall(node, "Union") &&
  node.arguments.length > 1 &&
  node.arguments.every((argument) => isSchemaMemberCall(argument, "Literal"));

const report = (context, node) => {
  context.report({ node, messageId: "default" });
};

const rules = {
  unnecessaryPipe: createRule("Remove pipe() when no transformation is applied.", (context) => ({
    CallExpression(node) {
      if (isIdentifier(node.callee, "pipe") && node.arguments.length <= 1) {
        report(context, node);
      }
    },
  })),

  unnecessaryPipeChain: createRule(
    "Remove .pipe() when no transformation is applied.",
    (context) => ({
      CallExpression(node) {
        if (calleePropertyName(node.callee) === "pipe" && node.arguments.length === 0) {
          report(context, node);
        }
      },
    }),
  ),

  unnecessaryEffectGen: createRule(
    "Effect.gen without yield can usually be simplified.",
    (context) => ({
      CallExpression(node) {
        const callback = node.arguments[0];
        if (isEffectMemberCall(node, "gen") && callback && !containsYield(callback.body)) {
          report(context, node);
        }
      },
    }),
  ),

  effectMapVoid: createRule(
    "Use Effect.asVoid instead of mapping an Effect to void.",
    (context) => ({
      CallExpression(node) {
        if (isEffectMemberCall(node, "map") && isVoidReturningArrow(node.arguments.at(-1))) {
          report(context, node);
        }
      },
    }),
  ),

  effectSucceedWithVoid: createRule(
    "Use Effect.void instead of Effect.succeed(undefined).",
    (context) => ({
      CallExpression(node) {
        if (isEffectMemberCall(node, "succeed") && isUndefinedExpression(node.arguments[0])) {
          report(context, node);
        }
      },
    }),
  ),

  schemaStructWithTag: createRule(
    "Use Schema.TaggedStruct for structs with a literal _tag field.",
    (context) => ({
      CallExpression(node) {
        if (isSchemaStructWithLiteralTag(node)) {
          report(context, node);
        }
      },
    }),
  ),

  schemaUnionOfLiterals: createRule(
    "Use Schema.Literal with multiple values instead of a union of literals.",
    (context) => ({
      CallExpression(node) {
        if (isSchemaUnionOfLiterals(node)) {
          report(context, node);
        }
      },
    }),
  ),

  unnecessaryArrowBlock: createRule(
    "Use an expression body for single-return arrow functions.",
    (context) => ({
      ArrowFunctionExpression(node) {
        if (isSingleReturnArrow(node)) {
          report(context, node);
        }
      },
    }),
  ),

  globalFetch: createRule("Use Effect HTTP APIs instead of global fetch.", (context) => ({
    CallExpression(node) {
      if (isIdentifier(node.callee, "fetch")) {
        report(context, node);
      }
    },
  })),

  processEnv: createRule("Use Effect Config instead of direct process.env access.", (context) => ({
    MemberExpression(node) {
      if (propertyName(node.property) === "env" && isIdentifier(node.object, "process")) {
        report(context, node);
      }
    },
  })),

  globalDate: createRule("Use Effect Clock instead of global Date access.", (context) => ({
    CallExpression(node) {
      if (isIdentifier(node.callee, "Date")) {
        report(context, node);
      }
    },
    NewExpression(node) {
      if (isIdentifier(node.callee, "Date")) {
        report(context, node);
      }
    },
  })),

  globalConsole: createRule("Use Effect logging instead of global console access.", (context) => ({
    MemberExpression(node) {
      if (isIdentifier(node.object, "console")) {
        report(context, node);
      }
    },
  })),

  globalRandom: createRule("Use Effect Random instead of Math.random.", (context) => ({
    CallExpression(node) {
      if (
        calleePropertyName(node.callee) === "random" &&
        calleeObjectName(node.callee) === "Math"
      ) {
        report(context, node);
      }
    },
  })),
};

export default {
  meta: {
    name: "effect",
    version: "0.0.0",
  },
  rules,
};
