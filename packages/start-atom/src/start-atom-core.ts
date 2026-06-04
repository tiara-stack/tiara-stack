import { Hydration, type AtomRegistry } from "effect/unstable/reactivity";
import { isServer } from "@tanstack/router-core/isServer";
import type { AnyRouter } from "@tanstack/react-router";

export type StartAtomOptions<TRouter extends AnyRouter> = {
  router: TRouter;
  registry: AtomRegistry.AtomRegistry;
};

type DehydratedAtomState = {
  atomStream: ReadableStream<Array<Hydration.DehydratedAtom>>;
};

type PushableStream<T> = {
  stream: ReadableStream<T>;
  enqueue: (chunk: T) => void;
  close: () => void;
};

function createPushableStream<T>(): PushableStream<T> {
  let controllerRef: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(controller) {
      controllerRef = controller;
    },
  });

  return {
    stream,
    enqueue: (chunk) => controllerRef.enqueue(chunk),
    close: () => controllerRef.close(),
  };
}

export function setupStartAtomCoreIntegration<TRouter extends AnyRouter>({
  router,
  registry,
}: StartAtomOptions<TRouter>) {
  const ogHydrate = router.options.hydrate;
  const ogDehydrate = router.options.dehydrate;

  if (isServer) {
    router.options.dehydrate = async (): Promise<DehydratedAtomState> => {
      const ogDehydrated = (await ogDehydrate?.()) ?? {};
      const atomStream = createPushableStream<Array<Hydration.DehydratedAtom>>();

      router.serverSsr!.onRenderFinished(() => {
        const dehydratedAtoms = Hydration.dehydrate(registry);
        if (dehydratedAtoms.length > 0) {
          atomStream.enqueue(dehydratedAtoms);
        }
        atomStream.close();
      });

      return {
        ...ogDehydrated,
        atomStream: atomStream.stream,
      };
    };
  } else {
    router.options.hydrate = async (dehydrated: DehydratedAtomState) => {
      await ogHydrate?.(dehydrated);

      const reader = dehydrated.atomStream.getReader();
      reader
        .read()
        .then(({ value }) => {
          if (value) {
            console.log("hydrating");
            Hydration.hydrate(registry, value);
          }
          reader.releaseLock();
        })
        .catch((err) => {
          console.error("Error reading atom stream:", err);
        });
    };
  }
}
