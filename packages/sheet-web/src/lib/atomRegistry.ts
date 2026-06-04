import { scheduleTask } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { createIsomorphicFn } from "@tanstack/react-start";
import { Effect, Exit, Predicate } from "effect";

const atomRegistryScheduleTask = createIsomorphicFn()
  .server((callback: () => void) => {
    const timeout = setTimeout(callback, 0);
    return () => clearTimeout(timeout);
  })
  .client(scheduleTask);

export const makeAtomRegistry = () =>
  AtomRegistry.make({
    scheduleTask: atomRegistryScheduleTask,
    defaultIdleTTL: 400,
  });

const NodeFlags = {
  alive: 1, // 1 << 0
  initialized: 2, // 1 << 1
  waitingForValue: 4, // 1 << 2
} as const;
type NodeFlags = (typeof NodeFlags)[keyof typeof NodeFlags];

const NodeState = {
  uninitialized: NodeFlags.alive | NodeFlags.waitingForValue,
  stale: NodeFlags.alive | NodeFlags.initialized | NodeFlags.waitingForValue,
  valid: NodeFlags.alive | NodeFlags.initialized,
  removed: 0,
} as const;
type NodeState = number;

interface Node<A> {
  readonly state: NodeState;
  readonly canBeRemoved: boolean;
  readonly _value: A;
  readonly value: () => A;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * ⚠️ INTERNAL API DEPENDENCY ⚠️
 * This interface mirrors internal implementation details of `@effect-atom/atom-react`.
 * The casting `registry as unknown as Registry` accesses undocumented internals:
 * - `getNodes()` - returns internal node map
 * - `ensureNode()` - creates/retrieves node for atom
 * - `scheduleNodeRemoval()` - marks node for cleanup
 * - `NodeFlags`/`NodeState` bit layout
 *
 * Last verified against: @effect-atom/atom-react@^0.5.0
 * Breaking changes in library internals will cause runtime failures.
 *
 * TODO: Replace with public API when available:
 * @see https://github.com/effect-atom/atom-react/issues (check for expose API requests)
 */
interface Registry {
  readonly getNodes: () => ReadonlyMap<Atom.Atom<any> | string, Node<any>>;
  readonly ensureNode: <A>(atom: Atom.Atom<A>) => Node<A>;
  readonly scheduleNodeRemoval: (node: Node<any>) => void;
}

const isInitialAsyncResult = Predicate.isTagged("Initial");

const ensureAtomDataNode = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  options?: { revalidateIfStale?: boolean },
) => {
  const { revalidateIfStale = false } = options ?? {};
  const registryImpl = registry as unknown as Registry;

  // Runtime safety check: fail fast if internal API changes
  if (
    typeof registryImpl.getNodes !== "function" ||
    typeof registryImpl.ensureNode !== "function" ||
    typeof registryImpl.scheduleNodeRemoval !== "function"
  ) {
    throw new Error(
      "[@effect-atom/atom-react internal API mismatch] " +
        "One or more of getNodes/ensureNode/scheduleNodeRemoval is not a function. " +
        "The library internals may have changed. " +
        "Please verify compatibility with @effect-atom/atom-react version.",
    );
  }

  const node = registryImpl.getNodes().get(atom) as Node<A> | undefined;

  const isCached =
    node !== undefined &&
    (node.state & NodeFlags.alive) !== 0 &&
    (node.state & NodeFlags.initialized) !== 0 &&
    (!revalidateIfStale || (node.state & NodeFlags.waitingForValue) === 0);

  if (isCached) {
    return node;
  }

  const newNode = registryImpl.ensureNode(atom);
  newNode.value(); // trigger initial value
  return newNode;
};

export const ensureResultAtomData = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: { revalidateIfStale?: boolean },
): Effect.Effect<A, E> =>
  Effect.callback((resume) => {
    const resumeExit = (exit: Exit.Exit<A, unknown>) =>
      resume(
        Exit.match(exit, {
          onSuccess: Effect.succeed,
          onFailure: Effect.failCause,
        }) as Effect.Effect<A, E>,
      );
    const registryImpl = registry as unknown as Registry;
    const node = ensureAtomDataNode(registry, atom, options);
    const currentValue = node._value;
    if (!isInitialAsyncResult(currentValue)) {
      return resumeExit(AsyncResult.toExit(currentValue));
    }
    const unsubscribe = node.subscribe(() => {
      const nextValue = node._value;
      if (isInitialAsyncResult(nextValue)) {
        return;
      }
      resumeExit(AsyncResult.toExit(nextValue));
      cancel();
    });
    const cancel = () => {
      unsubscribe();
      if (node.canBeRemoved) {
        registryImpl.scheduleNodeRemoval(node);
      }
    };
    return Effect.sync(cancel);
  });
