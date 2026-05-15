import { createHash } from "node:crypto";

const signaturePrefix = "// @generated effect-zero signature:sha256:";

export const computeHash = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export const signContent = (content: string): string =>
  `${signaturePrefix}${computeHash(content)}\n${content}`;

export const checkSignature = (fileContent: string): "valid" | "modified" | "no-signature" => {
  const newlineIndex = fileContent.indexOf("\n");
  if (newlineIndex === -1) {
    return "no-signature";
  }

  const firstLine = fileContent.slice(0, newlineIndex);
  if (!firstLine.startsWith(signaturePrefix)) {
    return "no-signature";
  }

  const storedHash = firstLine.slice(signaturePrefix.length);
  const rest = fileContent.slice(newlineIndex + 1);
  return storedHash === computeHash(rest) ? "valid" : "modified";
};
