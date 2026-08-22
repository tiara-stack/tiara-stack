import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { EffectivePrincipal } from "sheet-auth/identity";
import { RolloutGateAllPrincipalsKey, RolloutGateChangeRequest } from "sheet-workflow-contracts";
import { evaluationControlKeys, scopeKey } from "./rolloutGate";
import { selectRolloutGateDecision } from "./rolloutGateDecision";

describe("selectRolloutGateDecision", () => {
  it("selects legacy when no control matches", () => {
    expect(
      selectRolloutGateDecision({
        gateKey: "status-gate",
        fallbackReason: "unconfigured",
      }),
    ).toEqual({
      gateKey: "status-gate",
      revision: 0,
      matched: false,
      executionPath: "legacy",
      reason: "unconfigured",
    });
  });

  it("selects the stored replacement path for a matching control", () => {
    expect(
      selectRolloutGateDecision({
        gateKey: "status-gate",
        row: {
          revision: 3,
          executionPath: "replacement",
          reason: "three-hour-clean-observation",
        },
      }),
    ).toEqual({
      gateKey: "status-gate",
      revision: 3,
      matched: true,
      executionPath: "replacement",
      reason: "three-hour-clean-observation",
    });
  });

  it("selects legacy when the control explicitly rolls back", () => {
    expect(
      selectRolloutGateDecision({
        gateKey: "status-gate",
        row: {
          revision: 4,
          executionPath: "legacy",
          reason: "declared-failure",
        },
      }).executionPath,
    ).toBe("legacy");
  });

  it("uses a distinct reason for a whitespace-only stored reason", () => {
    expect(
      selectRolloutGateDecision({
        gateKey: "status-gate",
        row: {
          revision: 5,
          executionPath: "replacement",
          reason: "   ",
        },
        fallbackReason: "control-unavailable",
      }).reason,
    ).toBe("reason-missing");
  });
});

describe("RolloutGateChangeRequest", () => {
  it("decodes valid effective principal keys and rejects invalid keys", () => {
    const evidenceUrl = "https://linear.app/tiara-stack/issue/TIA-130";
    const change = Schema.decodeUnknownSync(RolloutGateChangeRequest)({
      contractIdentity: "services.deliverStatus",
      contractWireVersion: "1",
      client: { platform: "discord", clientId: "discord-main" },
      workspaceId: "workspace-1",
      executionPath: "replacement",
      reason: "approved",
      evidenceUrl,
      expectedRevision: 0,
    });

    expect(change.effectivePrincipalKey).toBeUndefined();
    expect(change.evidenceUrl).toBe(evidenceUrl);
    for (const effectivePrincipalKey of ["user:user-1", RolloutGateAllPrincipalsKey]) {
      expect(
        Schema.decodeUnknownSync(RolloutGateChangeRequest)({
          ...change,
          effectivePrincipalKey,
        }).effectivePrincipalKey,
      ).toBe(effectivePrincipalKey);
    }
    expect(() =>
      Schema.decodeUnknownSync(RolloutGateChangeRequest)({
        ...change,
        effectivePrincipalKey: "operator",
      }),
    ).toThrow();
  });

  it("accepts only HTTP and HTTPS evidence URLs", () => {
    const change = {
      contractIdentity: "services.deliverStatus",
      contractWireVersion: "1",
      client: { platform: "discord", clientId: "discord-main" },
      executionPath: "replacement",
      reason: "approved",
      expectedRevision: 0,
    };

    expect(() =>
      Schema.decodeUnknownSync(RolloutGateChangeRequest)({
        ...change,
        evidenceUrl: "file:///tmp/rollout-gate-evidence",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RolloutGateChangeRequest)({
        ...change,
        evidenceUrl: "not-a-url",
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(RolloutGateChangeRequest)({
        ...change,
        evidenceUrl: "https://linear.app/tiara-stack/issue/TIA-130",
      }).evidenceUrl,
    ).toBe("https://linear.app/tiara-stack/issue/TIA-130");
    expect(
      Schema.decodeUnknownSync(RolloutGateChangeRequest)({
        ...change,
        evidenceUrl: "http://internal.example/evidence",
      }).evidenceUrl,
    ).toBe("http://internal.example/evidence");
  });
});

describe("scopeKey", () => {
  it("serializes a workspace-wide control scope", () => {
    const change = Schema.decodeUnknownSync(RolloutGateChangeRequest)({
      contractIdentity: "services.deliverStatus",
      contractWireVersion: "1",
      client: { platform: "discord", clientId: "discord-main" },
      workspaceId: "workspace-1",
      executionPath: "replacement",
      reason: "approved",
      evidenceUrl: "https://linear.app/tiara-stack/issue/TIA-130",
      expectedRevision: 0,
    });

    expect(RolloutGateAllPrincipalsKey).toBe("*");
    expect(scopeKey(change, RolloutGateAllPrincipalsKey)).toBe(
      '["services.deliverStatus","1","discord","discord-main","workspace-1","*"]',
    );
  });
});

describe("evaluationControlKeys", () => {
  it("emits workspace and global keys in precedence order", () => {
    const effectivePrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
      kind: "user",
      userId: "user-1",
    });
    const baseScope = {
      contractIdentity: "services.deliverStatus",
      contractWireVersion: "1",
      client: { platform: "discord", clientId: "discord-main" },
    } as const;
    const workspaceScope = { ...baseScope, workspaceId: "workspace-1" } as const;
    const invocationId = Schema.decodeUnknownSync(InvocationId)(
      "00000000-0000-4000-8000-000000000000",
    );

    expect(evaluationControlKeys({ ...workspaceScope, invocationId, effectivePrincipal })).toEqual([
      scopeKey(workspaceScope, "user:user-1"),
      scopeKey(workspaceScope, RolloutGateAllPrincipalsKey),
      scopeKey(baseScope, "user:user-1"),
      scopeKey(baseScope, RolloutGateAllPrincipalsKey),
    ]);
    expect(evaluationControlKeys({ ...baseScope, invocationId, effectivePrincipal })).toEqual([
      scopeKey(baseScope, "user:user-1"),
      scopeKey(baseScope, RolloutGateAllPrincipalsKey),
    ]);
  });
});
