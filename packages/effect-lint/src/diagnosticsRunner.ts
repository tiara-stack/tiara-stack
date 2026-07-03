import { spawn } from "child_process";
import languageServicePackage from "@effect/language-service/package.json" with { type: "json" };
import { glob } from "glob";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { env, execPath } from "process";

export type OutputFormat = "json" | "pretty" | "text" | "github-actions";
export type SeverityLevel = "error" | "warning" | "message";

export interface EffectDiagnosticsOptions {
  projects: ReadonlyArray<string>;
  format: OutputFormat;
  strict: boolean;
  progress: boolean;
  severity?: SeverityLevel;
  lspconfig?: string;
  cwd?: string;
}

export interface EffectDiagnosticsResult {
  projects: ReadonlyArray<string>;
  exitCode: number;
}

const require = createRequire(import.meta.url);
const languageServiceBin = require.resolve(`${languageServicePackage.name}/cli.js`);

const expandProjects = async (
  patterns: ReadonlyArray<string>,
  cwd: string,
): Promise<ReadonlyArray<string>> => {
  const projects = new Set<string>();

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      absolute: true,
      cwd,
      nodir: true,
      windowsPathsNoEscape: true,
    });

    if (matches.length === 0) {
      projects.add(resolve(cwd, pattern));
    } else {
      for (const match of matches) {
        projects.add(resolve(match));
      }
    }
  }

  return [...projects].sort();
};

const projectHasSourceFiles = async (project: string) => {
  const [sourceFile] = await glob("**/*.{ts,tsx}", {
    absolute: true,
    cwd: dirname(project),
    ignore: ["dist/**", ".output/**", "node_modules/**"],
    nodir: true,
  });

  return sourceFile !== undefined;
};

const runNativeDiagnostics = (
  args: ReadonlyArray<string>,
  cwd: string | undefined,
): Promise<number> =>
  new Promise((resolveExitCode, reject) => {
    const child = spawn(execPath, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...env,
        NODE_OPTIONS: [env.NODE_OPTIONS, "--max-old-space-size=4096"].filter(Boolean).join(" "),
      },
    });

    child.on("error", reject);
    child.on("exit", (code) => resolveExitCode(code ?? 1));
  });

const booleanFlag = (enabled: boolean, flag: string) => (enabled ? [flag] : []);

const valueFlag = (flag: string, value: string | undefined) => (value ? [flag, value] : []);

const diagnosticsArgs = (project: string, options: EffectDiagnosticsOptions) => [
  languageServiceBin,
  "diagnostics",
  "--project",
  project,
  "--format",
  options.format,
  "--lspconfig",
  options.lspconfig ?? "{}",
  ...booleanFlag(options.strict, "--strict"),
  ...booleanFlag(options.progress, "--progress"),
  ...valueFlag("--severity", options.severity),
];

const runProject = (project: string, options: EffectDiagnosticsOptions): Promise<number> =>
  runNativeDiagnostics(diagnosticsArgs(project, options), options.cwd);

const shouldSkipProject = async (project: string) => {
  const hasSourceFiles = await projectHasSourceFiles(project);
  if (!hasSourceFiles) {
    process.stderr.write(`Skipping ${project}: no TypeScript source files found.\n`);
  }
  return !hasSourceFiles;
};

const runProjects = async (projects: ReadonlyArray<string>, options: EffectDiagnosticsOptions) => {
  const exitCodes = new Array<number>();

  for (const project of projects) {
    if (await shouldSkipProject(project)) continue;
    exitCodes.push(await runProject(project, options));
  }

  return exitCodes.find((code) => code !== 0) ?? 0;
};

export const runEffectDiagnostics = async (
  options: EffectDiagnosticsOptions,
): Promise<EffectDiagnosticsResult> => {
  const cwd = options.cwd ?? process.cwd();
  const projects = await expandProjects(options.projects, cwd);

  if (projects.length === 0) {
    throw new Error("No tsconfig projects matched.");
  }

  const exitCode = await runProjects(projects, { ...options, cwd });

  return { projects, exitCode };
};
