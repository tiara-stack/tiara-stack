export const getBearerToken = (authorization: string | null | undefined) => {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return undefined;
  }

  const token = match[1].trim();
  return token.length === 0 ? undefined : token;
};
