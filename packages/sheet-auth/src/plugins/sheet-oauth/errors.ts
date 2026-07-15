import { APIError } from "better-auth";

export const oauthError = (
  status: "BAD_REQUEST" | "UNAUTHORIZED" | "INTERNAL_SERVER_ERROR",
  error: string,
  description: string,
) =>
  new APIError(status, {
    error,
    error_description: description,
    message: description,
  });
