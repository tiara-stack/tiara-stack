type OAuth2TokenApiResult = {
  readonly response?: unknown;
  readonly headers?: HeadersInit | undefined;
  readonly status?: number | undefined;
};

type OAuth2TokenContext = {
  readonly body: Record<string, string>;
  readonly headers: Headers;
  readonly request: Request;
  readonly asResponse: false;
  readonly returnHeaders: true;
  readonly returnStatus: true;
};

type OAuth2TokenAuth = {
  readonly api: {
    readonly oauth2Token: unknown;
  };
};

const tokenPath = "/oauth2/token";

export const isOAuth2TokenRequest = (request: Request) =>
  request.method === "POST" && new URL(request.url).pathname === tokenPath;

const formBody = async (request: Request) => {
  const formData = await request.clone().formData();
  const body: Record<string, string> = {};

  for (const [key, value] of formData) {
    if (typeof value === "string") {
      body[key] = value;
    }
  }

  return body;
};

const asResult = (value: unknown): OAuth2TokenApiResult =>
  value && typeof value === "object" && "response" in value
    ? (value as OAuth2TokenApiResult)
    : { response: value };

const jsonResponse = (result: OAuth2TokenApiResult) => {
  const headers = new Headers(result.headers);
  headers.set("Content-Type", "application/json");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  if (!headers.has("Pragma")) headers.set("Pragma", "no-cache");

  return new Response(JSON.stringify(result.response ?? null), {
    status: result.status ?? 200,
    headers,
  });
};

const errorResponse = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as {
    readonly body?: unknown;
    readonly headers?: HeadersInit | undefined;
    readonly statusCode?: unknown;
  };

  if (typeof candidate.statusCode !== "number") {
    return undefined;
  }

  return jsonResponse({
    response: candidate.body ?? { message: "OAuth token request failed" },
    headers: candidate.headers,
    status: candidate.statusCode,
  });
};

export const handleOAuth2TokenRequest = async (auth: unknown, request: Request) => {
  const oauth2Token = (auth as OAuth2TokenAuth).api.oauth2Token as (
    context: OAuth2TokenContext,
  ) => Promise<unknown>;

  try {
    return jsonResponse(
      asResult(
        await oauth2Token({
          body: await formBody(request),
          headers: request.headers,
          request,
          asResponse: false,
          returnHeaders: true,
          returnStatus: true,
        }),
      ),
    );
  } catch (error) {
    const response = errorResponse(error);
    if (response) return response;
    throw error;
  }
};
