import { Predicate } from "effect";
import type { Project, SourceFile } from "ts-morph";

const permissionErrorCodes = new Set(["EACCES", "EPERM"]);

const isFsPermissionError = (error: unknown): error is NodeJS.ErrnoException =>
  Predicate.isError(error) &&
  Predicate.hasProperty(error, "code") &&
  Predicate.isString(error.code) &&
  permissionErrorCodes.has(error.code);

export const addSourceFilesFromTsConfigSafe = ({
  tsProject,
  tsConfigPath,
  debug = false,
}: {
  readonly tsProject: Pick<Project, "addSourceFilesFromTsConfig">;
  readonly tsConfigPath: string;
  readonly debug?: boolean;
}): boolean => {
  try {
    tsProject.addSourceFilesFromTsConfig(tsConfigPath);
    return true;
  } catch (error) {
    if (isFsPermissionError(error)) {
      const pathInfo = error.path ? ` while reading ${error.path}` : "";
      console.warn(
        `effect-zero: Skipping ${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ tsConfigPath /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */} due to a permission error${pathInfo} (${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ error.code /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}).`,
      );
      if (debug) {
        console.warn(error);
      }
      return false;
    }
    throw error;
  }
};

export const ensureSourceFileInProject = ({
  tsProject,
  filePath,
  debug = false,
}: {
  readonly tsProject: Project;
  readonly filePath: string;
  readonly debug?: boolean;
}): SourceFile | undefined => {
  const existing =
    tsProject.getSourceFile(filePath) ?? tsProject.addSourceFileAtPathIfExists(filePath);
  if (existing) {
    return existing;
  }

  try {
    return tsProject.addSourceFileAtPath(filePath);
  } catch (error) {
    if (debug) {
      console.warn(`effect-zero: Could not load ${filePath} into the TypeScript project.`, error);
    }
    return;
  }
};
