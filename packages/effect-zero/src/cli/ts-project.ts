import type { Project, SourceFile } from "ts-morph";

const permissionErrorCodes = new Set(["EACCES", "EPERM"]);

const isFsPermissionError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error &&
  "code" in error &&
  typeof (error as NodeJS.ErrnoException).code === "string" &&
  permissionErrorCodes.has((error as NodeJS.ErrnoException).code ?? "");

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
        `effect-zero: Skipping ${tsConfigPath} due to a permission error${pathInfo} (${error.code}).`,
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
