import { readFile } from "node:fs/promises";
import { NodeHttpClient } from "@effect/platform-node";
import { APIError } from "better-auth";
import { Effect, Layer, Predicate, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { oauthError } from "../errors";
import type { SheetOAuthKubernetesSubjectTokenMintingOptions } from "../types";

const TokenReviewRequest = Schema.Struct({
  apiVersion: Schema.Literal("authentication.k8s.io/v1"),
  kind: Schema.Literal("TokenReview"),
  spec: Schema.Struct({
    token: Schema.String,
    audiences: Schema.Array(Schema.String),
  }),
});

const TokenReviewResponse = Schema.Struct({
  status: Schema.optional(
    Schema.Struct({
      authenticated: Schema.optional(Schema.Boolean),
      audiences: Schema.optional(Schema.Array(Schema.String)),
      user: Schema.optional(
        Schema.Struct({
          username: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

const TokenReviewRetrySchedule = Schedule.both(
  Schedule.exponential("50 millis").pipe(Schedule.jittered),
  Schedule.recurs(2),
);

const serviceAccountUsername = (serviceAccount: string) => {
  const parts = serviceAccount.split("/");
  if (parts.length !== 2) {
    return serviceAccount;
  }

  const [namespace, name] = parts;
  return namespace && name ? `system:serviceaccount:${namespace}:${name}` : serviceAccount;
};

const readRequiredTokenFile = async (path: string) => (await readFile(path, "utf8")).trim();

const readOptionalCaFile = async (path: string) =>
  await readFile(path, "utf8").catch((error: unknown) => {
    if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });

const tokenReviewRequest = async ({
  url,
  reviewerToken,
  ca,
  token,
  audience,
}: {
  readonly url: string;
  readonly reviewerToken: string;
  readonly ca: string | undefined;
  readonly token: string;
  readonly audience: string;
}) => {
  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.bearerToken(Redacted.make(reviewerToken)),
    HttpClientRequest.schemaBodyJson(TokenReviewRequest)({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: {
        token,
        audiences: [audience],
      },
    }),
  );
  const clientLayer = NodeHttpClient.layerNodeHttpNoAgent.pipe(
    Layer.provide(NodeHttpClient.layerAgentOptions(ca ? { ca } : undefined)),
  );

  return await Effect.runPromise(
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* request.pipe(
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.timeout("1 second"),
        Effect.retry(TokenReviewRetrySchedule),
      );
      return yield* HttpClientResponse.schemaBodyJson(TokenReviewResponse)(response);
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.withSpan("sheetOAuth.kubernetesTokenReview", {
        attributes: {
          "server.address": new URL(url).hostname,
          "sheet.oauth.token_review.audience": audience,
        },
      }),
      Effect.provide(clientLayer),
    ),
  );
};

export const verifyKubernetesServiceAccountToken = async (
  token: string,
  options: SheetOAuthKubernetesSubjectTokenMintingOptions,
) => {
  let response: Schema.Schema.Type<typeof TokenReviewResponse>;
  try {
    const reviewerToken = await readRequiredTokenFile(
      options.reviewerTokenPath ?? "/var/run/secrets/tokens/kubernetes-jwks-token",
    );
    const ca = await readOptionalCaFile(
      options.caPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    );
    response = await tokenReviewRequest({
      url:
        options.tokenReviewUrl ??
        "https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews",
      reviewerToken,
      ca,
      token,
      audience: options.audience,
    });
  } catch (error) {
    const errorMessage = Predicate.isError(error) ? error.message : String(error);
    Effect.runSync(Effect.logError("Kubernetes token review failed", errorMessage));
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Kubernetes token review unavailable",
    });
  }

  const username = response.status?.user?.username ?? "";
  const audiences = response.status?.audiences ?? [];
  const authenticated = response.status?.authenticated === true;
  const allowedUsernames = new Set(options.allowedServiceAccounts.map(serviceAccountUsername));

  if (
    !authenticated ||
    !audiences.includes(options.audience) ||
    !username ||
    !allowedUsernames.has(username)
  ) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Invalid Kubernetes service account token");
  }

  return {
    username,
    audiences,
  };
};
