import { Effect, Schema } from "effect";
import {
  PreviewWorkflowApiHostError,
  type PreviewWorkflowApiApplicationRouteApi,
} from "./preview-workflow-api-host";
import { relayNameFor } from "./preview-relay-provider";
import {
  PreviewGatewayApplicationTargetSchema,
  PreviewGatewayError,
  type PreviewGatewayApi,
} from "./preview-gateway";

const routeUnavailable = (phase: string) =>
  new PreviewWorkflowApiHostError({ reason: "workflow-source-unavailable", phase });

const hasWorkflowApiPublicationIdentity = (
  input: Parameters<PreviewWorkflowApiApplicationRouteApi["publish"]>[0],
) =>
  input.listener.role === "sheet-workflows-api" &&
  input.session.id === input.group.sessionId &&
  input.session.generation === input.group.generation &&
  input.group.groupId === "workflow-execution";

const workflowApiRouteResources = (
  session: Parameters<PreviewWorkflowApiApplicationRouteApi["publish"]>[0]["session"],
) => {
  const serviceResourceId = session.resources["preview-relay-service-sheet-workflows-api"];
  const attachmentResourceId = session.resources["preview-relay-attachment-sheet-workflows-api"];
  if (
    serviceResourceId === undefined ||
    attachmentResourceId === undefined ||
    serviceResourceId.trim().length === 0 ||
    attachmentResourceId.trim().length === 0
  )
    return undefined;
  return { serviceResourceId, attachmentResourceId };
};

/**
 * Adapts the producer host route contract to the common durable session gateway.
 * The gateway owns readiness, identity mediation, generation fences, request admission,
 * channel cleanup and route tombstoning; this adapter only supplies the exact host target.
 */
export const makePreviewWorkflowApiApplicationRoute = (
  gateway: PreviewGatewayApi,
): PreviewWorkflowApiApplicationRouteApi => {
  const applicationOrigin: PreviewWorkflowApiApplicationRouteApi["applicationOrigin"] = ({
    sessionId,
    role,
  }) => {
    const origin = gateway.applicationOrigin(sessionId, role);
    return origin === undefined
      ? Effect.fail(routeUnavailable("workflow-api-application-origin-unavailable"))
      : Effect.succeed(origin);
  };

  const publish: PreviewWorkflowApiApplicationRouteApi["publish"] = (input) =>
    Effect.gen(function* () {
      const registerAdmission = gateway.registerWorkflowApiRequestAdmission;
      if (
        registerAdmission === undefined ||
        gateway.removeApplicationRoute === undefined ||
        !hasWorkflowApiPublicationIdentity(input)
      )
        return yield* Effect.fail(routeUnavailable("workflow-api-route-identity-mismatch"));
      const origin = gateway.applicationOrigin(input.session.id, "sheet-workflows-api");
      const resources = workflowApiRouteResources(input.session);
      if (origin === undefined || resources === undefined)
        return yield* Effect.fail(routeUnavailable("workflow-api-route-resources-unavailable"));

      const target = yield* Schema.decodeUnknownEffect(PreviewGatewayApplicationTargetSchema)({
        sessionId: input.session.id,
        generation: input.session.generation,
        role: "sheet-workflows-api",
        processId: input.listener.processId,
        revision: input.revision,
        artifactDigest: input.group.apiArtifactDigest,
        catalogDigest: input.group.workflowContractCatalogDigest,
        stateGroup: "workflow-execution",
        serviceFqdn: `${relayNameFor(input.session.id, "sheet-workflows-api")}.preview-relays.svc.cluster.local`,
        serviceResourceId: resources.serviceResourceId,
        attachmentResourceId: resources.attachmentResourceId,
        port: input.listener.port,
        kind: "application",
      }).pipe(Effect.mapError(() => routeUnavailable("workflow-api-route-target-invalid")));
      const assertAuthorityCurrent = input.assertAuthorityCurrent;
      const assertCurrent =
        assertAuthorityCurrent === undefined
          ? undefined
          : () =>
              assertAuthorityCurrent().pipe(
                Effect.mapError(() => new PreviewGatewayError({ reason: "unavailable" })),
              );
      if (assertCurrent !== undefined)
        yield* assertCurrent().pipe(
          Effect.mapError(() =>
            routeUnavailable("workflow-api-authority-expired-before-publication"),
          ),
        );
      yield* gateway
        .register(target, input.ownerIdentity, assertCurrent)
        .pipe(Effect.mapError(() => routeUnavailable("workflow-api-route-publication-failed")));
      if (assertCurrent !== undefined)
        yield* assertCurrent().pipe(
          Effect.mapError(() =>
            routeUnavailable("workflow-api-authority-expired-after-publication"),
          ),
        );
      yield* registerAdmission(
        target,
        input.ownerIdentity,
        input.admitWorkflowRequest,
        assertCurrent,
      ).pipe(
        Effect.mapError(() => routeUnavailable("workflow-api-route-admission-registration-failed")),
      );
      return origin;
    });

  const remove: PreviewWorkflowApiApplicationRouteApi["remove"] = (input) =>
    gateway.removeApplicationRoute === undefined
      ? Effect.fail(routeUnavailable("workflow-api-route-removal-unavailable"))
      : gateway
          .removeApplicationRoute({ ...input, role: "sheet-workflows-api" })
          .pipe(Effect.mapError(() => routeUnavailable("workflow-api-route-removal-unconfirmed")));

  return { applicationOrigin, publish, remove };
};
