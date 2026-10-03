import { describe, expect, it } from "@effect/vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import {
  PreviewRelayRegistry,
  PreviewRelayError,
  type PreviewRelayIdentity,
} from "./preview-relays";

const identity = (sessionId: string, processId: string, port: number): PreviewRelayIdentity => ({
  sessionId,
  role: "sheet-auth",
  processId,
  serviceName: `relay-${sessionId}-sheet-auth`,
  serviceFqdn: `relay-${sessionId}-sheet-auth.preview-relays.svc.cluster.local`,
  attachmentId: `attachment-${sessionId}-sheet-auth`,
  host: "127.0.0.1",
  port,
});

const startHostRuntime = async (sessionId: string, processId: string) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ sessionId, processId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
};

const forwardHttp = async (target: { readonly host: string; readonly port: number }) => {
  const response = await fetch(`http://${target.host}:${target.port}`);
  return { status: response.status, body: await response.json() };
};

describe("preview session relays", () => {
  it.live("routes two sessions to their own process and keeps shared control unchanged", () =>
    Effect.promise(async () => {
      const registry = new PreviewRelayRegistry();
      const firstHost = await startHostRuntime("session-a", "process-a");
      const secondHost = await startHostRuntime("session-b", "process-b");
      const first = identity("session-a", "process-a", firstHost.port);
      const second = identity("session-b", "process-b", secondHost.port);
      const shared = { processId: "shared-process", requests: 0 };
      registry.allocate(first);
      registry.allocate(second);
      registry.attach(first, {
        sessionId: first.sessionId,
        role: first.role,
        processId: first.processId,
        port: firstHost.port,
      });
      registry.attach(second, {
        sessionId: second.sessionId,
        role: second.role,
        processId: second.processId,
        port: secondHost.port,
      });
      registry.approveDevelopmentDependency(first.sessionId, "pg.dev.tiara-stack.example");
      registry.approveDevelopmentDependency(second.sessionId, "redis.dev.tiara-stack.example");

      const send = (target: PreviewRelayIdentity) =>
        registry.request({
          serviceFqdn: target.serviceFqdn,
          expectedSessionId: target.sessionId,
          expectedRole: target.role,
          expectedProcessId: target.processId,
          forward: forwardHttp,
        });
      try {
        expect(await send(first)).toEqual({
          status: 200,
          body: { sessionId: "session-a", processId: "process-a" },
        });
        expect(await send(second)).toEqual({
          status: 200,
          body: { sessionId: "session-b", processId: "process-b" },
        });
        await expect(
          registry.request({
            serviceFqdn: first.serviceFqdn,
            expectedSessionId: "session-b",
            expectedRole: first.role,
            expectedProcessId: first.processId,
            forward: forwardHttp,
          }),
        ).rejects.toMatchObject({ reason: "unavailable" });
        await expect(
          registry.request({
            serviceFqdn: first.serviceFqdn,
            expectedSessionId: first.sessionId,
            expectedRole: "sheet-web",
            expectedProcessId: first.processId,
            forward: forwardHttp,
          }),
        ).rejects.toMatchObject({ reason: "unavailable" });
        await expect(
          registry.request({
            serviceFqdn: first.serviceFqdn,
            expectedSessionId: first.sessionId,
            expectedRole: first.role,
            expectedProcessId: "stale-process",
            forward: forwardHttp,
          }),
        ).rejects.toMatchObject({ reason: "unavailable" });
        expect(
          registry.checkDevelopmentDependency(first.sessionId, "pg.dev.tiara-stack.example"),
        ).toBe("pg.dev.tiara-stack.example");
        registry.approveDevelopmentDependency(first.sessionId, "PG.DEV.TIARA-STACK.EXAMPLE.");
        expect(
          registry.checkDevelopmentDependency(first.sessionId, "PG.DEV.TIARA-STACK.EXAMPLE."),
        ).toBe("PG.DEV.TIARA-STACK.EXAMPLE.");
        expect(
          registry.checkDevelopmentDependency(second.sessionId, "redis.dev.tiara-stack.example"),
        ).toBe("redis.dev.tiara-stack.example");
        expect(() =>
          registry.checkDevelopmentDependency(first.sessionId, "redis.dev.tiara-stack.example"),
        ).toThrow(PreviewRelayError);
        expect(shared).toEqual({ processId: "shared-process", requests: 0 });

        registry.cleanup(first.sessionId);
        await expect(send(first)).rejects.toMatchObject({ reason: "unavailable" });
        expect(await send(second)).toEqual({
          status: 200,
          body: { sessionId: "session-b", processId: "process-b" },
        });
        expect(shared).toEqual({ processId: "shared-process", requests: 0 });
      } finally {
        await Promise.all([firstHost.close(), secondHost.close()]);
      }
    }),
  );

  it.live("returns unavailable before attachment and after detachment without fallback", () =>
    Effect.promise(async () => {
      const registry = new PreviewRelayRegistry();
      const stoppedHost = await startHostRuntime("session-a", "process-a");
      await stoppedHost.close();
      const relay = identity("session-a", "process-a", stoppedHost.port);
      registry.allocate(relay);
      const request = registry.request({
        serviceFqdn: relay.serviceFqdn,
        expectedSessionId: relay.sessionId,
        expectedRole: relay.role,
        expectedProcessId: relay.processId,
        forward: async () => ({ status: 200 }),
      });
      await expect(request).rejects.toMatchObject({ reason: "unavailable" });
      registry.attach(relay, {
        sessionId: relay.sessionId,
        role: relay.role,
        processId: relay.processId,
        port: stoppedHost.port,
      });
      await expect(
        registry.request({
          serviceFqdn: relay.serviceFqdn,
          expectedSessionId: relay.sessionId,
          expectedRole: relay.role,
          expectedProcessId: relay.processId,
          forward: forwardHttp,
        }),
      ).rejects.toMatchObject({ reason: "unavailable" });
      registry.detach(relay.attachmentId);
      await expect(
        registry.request({
          serviceFqdn: relay.serviceFqdn,
          expectedSessionId: relay.sessionId,
          expectedRole: relay.role,
          expectedProcessId: relay.processId,
          forward: async () => ({ status: 200 }),
        }),
      ).rejects.toMatchObject({ reason: "unavailable" });
    }),
  );

  it("rejects collisions, wrong targets and non-development destinations", () => {
    const registry = new PreviewRelayRegistry();
    const first = identity("session-a", "process-a", 4101);
    registry.allocate(first);
    expect(() => registry.allocate(identity("session-b", "process-b", 4101))).toThrow(
      PreviewRelayError,
    );
    expect(() =>
      registry.attach(first, {
        sessionId: "session-b",
        role: first.role,
        processId: first.processId,
        port: 4101,
      }),
    ).toThrow(PreviewRelayError);
    expect(() => registry.validateDevelopmentDependency("db.production.example.com")).toThrow(
      PreviewRelayError,
    );
    expect(() => registry.validateDevelopmentDependency("db.live.example.com")).toThrow(
      PreviewRelayError,
    );
    expect(() => registry.validateDevelopmentDependency("127.0.0.1")).toThrow(PreviewRelayError);
    expect(registry.validateDevelopmentDependency("pg.dev.tiara-stack.example")).toBe(
      "pg.dev.tiara-stack.example",
    );
    registry.approveDevelopmentDependency("session-a", "pg.dev.tiara-stack.example");
    expect(() =>
      registry.checkDevelopmentDependency("session-b", "pg.dev.tiara-stack.example"),
    ).toThrow(PreviewRelayError);
  });
});
