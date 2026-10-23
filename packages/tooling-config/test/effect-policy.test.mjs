import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";
import plugin, { consumeBaselineSite } from "../src/oxlint-plugins/effect-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const previewAuthTestFile = path.join(
  repositoryRoot,
  "packages/developer-launcher/src/preview-auth.test.ts",
);
const nestedPreviewAuthConsumerFile = path.join(
  repositoryRoot,
  "packages/tooling-config/test/fixtures/consumer.test.ts",
);
const resolvedFixtureFilename = (filename) =>
  path.isAbsolute(filename) ? filename : path.resolve(repositoryRoot, filename);

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const run = (name, valid, invalid) =>
  tester.run(name, plugin.rules[name], {
    valid: valid.map((example) =>
      typeof example === "string"
        ? { code: example, filename: resolvedFixtureFilename("fixture.ts") }
        : {
            ...example,
            filename: resolvedFixtureFilename(example.filename ?? "fixture.ts"),
          },
    ),
    invalid: invalid.map(({ code, message, filename }) => ({
      code,
      filename: resolvedFixtureFilename(filename ?? "fixture.ts"),
      errors: (Array.isArray(message) ? message : [message]).map((expectedMessage) => ({
        message: expectedMessage,
      })),
    })),
  });

run(
  "no-nested-ternary-adoption",
  ["const value = flag ? yes : no;"],
  [{ code: "const value = flag ? (next ? yes : no) : other;", message: "nested" }],
);
run(
  "effect-predicate",
  [
    "function isFileError(error: unknown) { return error instanceof FileError; }",
    "function isSingleUseFileError(error: unknown) { return error instanceof FileError; } const consumePredicate = (isSingleUseFileError: (error: unknown) => boolean) => isSingleUseFileError; consumePredicate(isSingleUseFileError);",
    "function isSingleUseWithLocalBinding(error: unknown) { return error instanceof FileError; } const useLocalBinding = () => { const isSingleUseWithLocalBinding = () => false; return isSingleUseWithLocalBinding(); }; useLocalBinding(isSingleUseWithLocalBinding);",
    "function isSingleUseWithLocalFunction(error: unknown) { return error instanceof FileError; } const useLocalFunction = () => { function isSingleUseWithLocalFunction() { return false; } return isSingleUseWithLocalFunction(); }; useLocalFunction(isSingleUseWithLocalFunction);",
    "function isSingleUseWithPropertyKey(error: unknown) { return error instanceof FileError; } const predicateNames = { isSingleUseWithPropertyKey: true }; use(isSingleUseWithPropertyKey, predicateNames);",
    "function isSingleUseCaptured(error: unknown) { return error instanceof FileError; } const capturePredicate = () => isSingleUseCaptured(error); use(capturePredicate, isSingleUseCaptured);",
    "const isReady = (value: unknown) => Predicate.isTagged('Ready')(value);",
    "function isLocalThing(value: unknown) { return value instanceof FileError; }",
    "function isOneOffFailure(value: unknown) { return value instanceof Failure; } use(isOneOffFailure);",
    "export function adaptRuntimeFailure(value: unknown) { return value instanceof Error; }",
    "export function isRuntimeAdapter(value: unknown) { return value instanceof Error; }",
    "export function isOpaqueError(value: { message: string }) { return value.message.includes('instanceof Error'); }",
    "export const isArrowReady = (value: unknown): value is Ready => Predicate.isTagged('Ready')(value);",
    "const isFileError = (error: unknown) => Predicate.isTagged('FileError')(error); export { isFileError }; function inspectOneOff(value: unknown) { const isFileError = (nested: unknown) => nested instanceof FileError; return isFileError(value); } use(inspectOneOff);",
    "export function isFileError(error: unknown) { const diagnosticOnly = () => error instanceof FileError; return Predicate.isTagged('FileError')(error); }",
    "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; return Predicate.isTagged('FileError')(error); }",
    "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; if (false) checkAlias(error); return Predicate.isTagged('FileError')(error); }",
    "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; const disabled = false; if (disabled) checkAlias(error); return Predicate.isTagged('FileError')(error); }",
    "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; false && checkAlias(error); return Predicate.isTagged('FileError')(error); }",
    "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; const ignored = false ? checkAlias(error) : undefined; return Predicate.isTagged('FileError')(error); }",
    "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; let checkAlias = check; checkAlias = () => false; return checkAlias(error); }",
  ],
  [
    {
      code: "export function isFileError(error: unknown) { return error instanceof FileError; }",
      message: "predicate",
    },
    {
      code: "export function isFailure(error: any) { return error._tag === 'Failure'; }",
      message: "predicate",
    },
    {
      code: "export function isNotFailure(error: any) { return error._tag !== 'Failure'; }",
      message: "predicate",
    },
    {
      code: "export function isNode(value: unknown): value is Node { return value instanceof Node; }",
      message: "predicate",
    },
    {
      code: "export const isArrowNode = (value: unknown): value is Node => value instanceof Node;",
      message: "predicate",
    },
    {
      code: "function isExportedFailure(value: unknown) { return value._tag === 'Failure'; } export { isExportedFailure };",
      message: "predicate",
    },
    {
      code: "export default function isDefaultFailure(value: unknown) { return value._tag === 'Failure'; }",
      message: "predicate",
    },
    {
      code: "function isLocalFailure(value: unknown) { return value instanceof Failure; } use(isLocalFailure); use(isLocalFailure);",
      message: "predicate",
    },
    {
      code: "function isCapturedFailure(value: unknown) { return value instanceof Failure; } const first = () => isCapturedFailure(value); const second = () => isCapturedFailure(value);",
      message: "predicate",
    },
    {
      code: "function isPropertyKeyFailure(value: unknown) { return value instanceof Failure; } const check = ({ isPropertyKeyFailure: alias }: { isPropertyKeyFailure: unknown }) => isPropertyKeyFailure(alias); check; use(isPropertyKeyFailure);",
      message: "predicate",
    },
    {
      code: "export function isFileError(error: unknown) { const check = () => error instanceof FileError; return check(); }",
      message: "predicate",
    },
    {
      code: "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; return checkAlias(error); }",
      message: "predicate",
    },
    {
      code: "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; if (enabled) checkAlias(error); return Predicate.isTagged('FileError')(error); }",
      message: "predicate",
    },
    {
      code: "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; const enabled = true; if (enabled) checkAlias(error); return Predicate.isTagged('FileError')(error); }",
      message: "predicate",
    },
    {
      code: "export function isFileError(error: unknown) { const check = (value: unknown) => value instanceof FileError; const checkAlias = check; const checkAliasAgain = checkAlias; return checkAliasAgain(error); }",
      message: "predicate",
    },
    {
      code: "export function matchesFailure(value: unknown): value is Failure { return value instanceof Failure; }",
      message: "predicate",
    },
  ],
);
run(
  "effect-match",
  [
    "switch (error._tag) { case 'A': return a; case 'B': doThing(); break; case 'C': return c; }",
    "switch (error._tag) { case 'A': case 'B': return b; default: return undefined; }",
    "switch (error._tag) { case 'A': return a; case 'B': return b; default: case 'C': return c; }",
    "if (error._tag === 'A') return a; if (error._tag === 'B') return b;",
    "if (error._tag === 'A') return a;",
    "if (error._tag === 'A') return a; else if (error._tag === 'B') return b;",
  ],
  [
    {
      code: "switch (error._tag) { case 'A': return a; case 'B': throw b; }",
      message: "match",
    },
    {
      code: "switch (error._tag) { case 'A': return a; case 'B': return b; case 'C': throw c; }",
      message: "match",
    },
    {
      code: "switch (error['_tag']) { case 'A': return a; case 'B': return b; case 'C': throw c; }",
      message: "match",
    },
    {
      code: "if (error._tag === 'A') return a; else if (error._tag === 'B') return b; else if (error._tag === 'C') throw c;",
      message: "match",
    },
    {
      code: "function choose(error: Failure) { if (error._tag === 'A') return a; if (error._tag === 'B') return b; if (error._tag === 'C') return c; }",
      message: "match",
    },
    {
      code: "function choose(error: Failure) { if (error._tag === 'A') return a; else { if (error._tag === 'B') return b; if (error._tag === 'C') return c; } }",
      message: "match",
    },
    {
      code: "const ReadyTag = 'Ready'; const FailedTag = 'Failed'; const ClosedTag = 'Closed'; function choose(error: Failure) { if (error._tag === ReadyTag) return ready; if (error._tag === FailedTag) return failed; if (error._tag === ClosedTag) return closed; }",
      message: "match",
    },
  ],
);
run(
  "effect-live-test",
  [
    {
      code: "import { it } from '@effect/vitest'; it.effect('case', () => Effect.sync(() => readFileSync('x')));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { sync as effectSync } from 'other-effect'; import { readFileSync } from 'node:fs'; it.effect('wrong module direct sync stays opaque', () => effectSync(() => readFileSync('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { sync as effectSync } from 'effect/Effect'; import { readFileSync } from 'node:fs'; function run(effectSync) { return it.effect('shadowed direct sync stays opaque', () => effectSync(() => readFileSync('fixture', 'utf8'))); }",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; export const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; it.effect('exported Effect.try options do not receive stable initializer callback credit', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; export { options as sharedOptions }; it.effect('export-list Effect.try options do not receive stable initializer callback credit', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.live('case', () => it.effect('case', () => load('x')));",
      filename: "case.test.ts",
    },
    {
      code: "import { it as effectIt } from '@effect/vitest'; effectIt.live('case', () => effectIt.effect('case', () => load('x')));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'node:fs/promises'; it.effect('object-name-alone', () => fs.constants);",
      filename: "case.test.ts",
    },
    {
      code: "import * as effectVitest from '@effect/vitest'; const fs = { readFile: () => 'fixture' }; effectVitest.it.live('namespace vitest', () => fs.readFile());",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('local object', () => { const process = { env: { HOME: 'tmp' } }; return process.env.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('computed local process env', () => { const process = { env: { HOME: 'fixture' } }; return process['env'].HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('destructured local process env', () => { const process = { env: { HOME: 'fixture' } }; const { env } = process; return env.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFile as load } from 'node:fs/promises'; it.effect('shadowed import', () => { const load = () => 'fixture'; return load(); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.live('default fs import', () => load('fixture')); import fs from 'node:fs'; const load = fs.readFile;",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; it.effect('shadowed env', () => { const runtimeEnv = { HOME: 'fixture' }; return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; it.effect('unrelated member property matching environment alias', () => client.runtimeEnv);",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('shadowed computed Effect method stays opaque', () => { const Fx = { sync: (callback) => callback() }; return Fx['sync'](() => readFileSync('fixture', 'utf8')); });",
      filename: "case.test.ts",
    },
    {
      code: "import * as OtherEffect from 'other-effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('wrong-module computed Effect method stays opaque', () => OtherEffect['sync'](() => readFileSync('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const method = getEffectMethod(); it.effect('unknown computed Effect method stays opaque', () => Fx[method](() => readFileSync('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; it.effect('env property key', () => ({ runtimeEnv: 'fixture' }));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as runtime from 'node:process'; it.effect('namespace environment', () => runtime.argv);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import fs from 'node:fs'; it.effect('shadowed fs promises', () => { const fs = { promises: { readFile: () => undefined } }; return fs.promises.readFile('x'); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import fs from 'fs'; it.effect('shadowed bare fs promises', () => { const fs = { promises: { readFile: () => undefined } }; return fs.promises.readFile('x'); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { promises as fsPromises } from 'node:fs'; it.effect('shadowed named promises namespace', () => { const fsPromises = { readFile: () => undefined }; return fsPromises.readFile('x'); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as timers from 'node:timers/promises'; it.effect('shadowed scheduler namespace', () => { const timers = { scheduler: { wait: () => undefined } }; return timers.scheduler.wait(10); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { scheduler as timerScheduler } from 'node:timers/promises'; it.live('live scheduler wait', () => timerScheduler.wait(10));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { scheduler } from 'node:timers/promises'; it.effect('shadowed scheduler import', () => { const scheduler = { wait: () => undefined }; return scheduler.wait(10); });",
      filename: "case.test.ts",
    },
    {
      code: "const it = { effect: (_name, run) => run() }; it.effect('unrelated object', () => readFile('fixture'));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; function unusedTempDirectory() { return makeTempDirectory('/tmp/test-'); } it.effect('declared but uncalled file helper', () => Effect.void);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('nested uncalled helper', () => { function unusedTempDirectory() { return makeTempDirectory('/tmp/test-'); } return Effect.void; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('uncalled arrow helper', () => { const unusedTempDirectory = () => makeTempDirectory('/tmp/test-'); return Effect.void; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('uncalled callback property', () => { const callbacks = { run: () => makeTempDirectory('/tmp/test-') }; return Effect.void; });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const callbacks = []; it.effect('callback.push stores without invocation', () => { callbacks.push(() => makeTempDirectory('/tmp/test-')); return Effect.void; });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; function createTempDirectory() { return makeTempDirectory('/tmp/test-'); } it.effect('shadowed Effect.promise does not invoke file helper', () => { const Effect = { promise: (callback) => callback() }; return Effect.promise(createTempDirectory); });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const callbacks = []; const storeCallback = (callback) => callbacks.push(callback); it.effect('file helper stores callback without invocation', () => storeCallback(() => makeTempDirectory('/tmp/test-')) || Effect.void);",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const describe = (_label, _callback) => undefined; describe('ignored suite callback', () => { it.effect('is not registered', () => Effect.promise(() => makeTempDirectory('/tmp/test-'))); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const describe = { only: (_label, callback) => callback() }; describe.only('shadowed suite', () => { it.effect('is not a canonical suite', () => readFileSync('fixture', 'utf8')); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; function createTempDirectory() { return makeTempDirectory('/tmp/test-'); } it.live('executed file helper is allowed in live mode', () => createTempDirectory());",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; function createTempDirectory() { return makeTempDirectory('/tmp/test-'); } it.effect('a shadowed helper call does not execute the file helper', () => { const createTempDirectory = () => 'fixture'; return createTempDirectory(); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; function readFixture() { return readFileSync('fixture', 'utf8'); } readFixture = () => 'fixture'; it.effect('reassigned helper no longer executes its stale filesystem read', () => readFixture());",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.try keeps the helper captured before a later nested-block reassignment', () => { function readFixture() { return 'fixture'; } const effect = Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }); { readFixture = () => readFileSync('fixture', 'utf8'); } return effect; });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as CanonicalEffect } from 'effect'; import * as OtherEffect from 'other-effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('unrelated module forEach mapper stays opaque', () => OtherEffect.forEach(['/tmp/test-'], (prefix) => CanonicalEffect.promise(() => makeTempDirectory(prefix))));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as CanonicalEffect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('shadowed forEach is not a canonical Effect callback', () => { const Effect = { forEach: (_items, _mapper) => CanonicalEffect.void }; return Effect.forEach(['/tmp/test-'], (prefix) => CanonicalEffect.promise(() => makeTempDirectory(prefix))); });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const createTempDirectory = (prefix) => Effect.promise(() => makeTempDirectory(prefix)); it.effect('forEach does not invoke function values in the iterable', () => Effect.forEach([createTempDirectory], () => Effect.void));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const captureOptions = (options) => options; it.effect('opaque try-like object passed to local capture stays unexecuted', () => { captureOptions({ try: () => readFileSync('fixture', 'utf8'), catch: () => readFileSync('fixture', 'utf8') }); return Effect.void; });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.try does not execute a whole-argument callback', () => Fx.try(() => readFileSync('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const readFixture = () => readFileSync('fixture', 'utf8'); it.effect('Effect.try does not execute a whole-argument callback identifier', () => Fx.try(readFixture));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFile } from 'node:fs/promises'; it.live('Effect.tryPromise keeps its direct callback overload', () => Fx.tryPromise(() => readFile('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const key = getOptionKey(); const options = { try: () => readFileSync('fixture', 'utf8'), [key]: () => Effect.void, catch: (cause) => new Error(String(cause)) }; it.effect('unknown computed option key keeps the whole object opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), ...getOptions(), catch: (cause) => new Error(String(cause)) }; it.effect('later opaque spread may replace the try callback', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; const options = { ...getOptions(), try: () => 'safe', catch: (cause) => new Error(String(cause)) }; it.effect('explicit safe try callback after opaque spread wins', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; options.try = () => 'fixture'; it.effect('overwritten bound try callback stays opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; options['try'] = () => 'fixture'; it.effect('statically computed bound try write stays opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; ({ try: options.try } = { try: () => 'fixture' }); it.effect('direct destructuring makes the const-bound options opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; ({ ['try']: options['try'] } = { try: () => 'fixture' }); it.effect('static-computed destructuring makes the const-bound options opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const alias = options; alias.try = () => 'fixture'; it.effect('aliased bound options stay opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const update = (candidate) => { candidate.try = () => 'fixture'; }; update(options); it.effect('escaped bound options stay opaque', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; it.effect('a later write can affect a deferred Effect.try', () => { const effect = Fx.try(options); options.try = () => 'fixture'; return effect; });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), ['try']: () => 'fixture', catch: (cause) => new Error(String(cause)) }; it.effect('last duplicate try property replaces the stale initializer callback', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const createTempDirectoryEffect = (prefix: string) => Fx.promise(() => makeTempDirectory(prefix)); const unknownOptions = () => Fx.promise(() => makeTempDirectory('/tmp/not-a-mapper-')); it.effect('unknown curried forEach argument is not assumed to be options', () => Fx.forEach(createTempDirectoryEffect, unknownOptions)(['/tmp/test-']));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const forEachOptions = { concurrency: 2 }; const createTempDirectoryEffect = (prefix: string) => Fx.promise(() => makeTempDirectory(prefix)); it.effect('unapplied forEach optional-options partial stays unexecuted', () => Fx.forEach(createTempDirectoryEffect, forEachOptions));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import * as OtherEffect from 'other-effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('unrelated module try options remain opaque', () => OtherEffect.try({ try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('shadowed Effect namespace try options remain opaque', () => { const Fx = { try: (options) => options }; return Fx.try({ try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }); });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: () => readFileSync('fixture', 'utf8') }; it.effect('unapplied try-like object stays unexecuted', () => Effect.void);",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('unapplied data-last forEach mapper stays unexecuted', () => Fx.forEach(() => readFileSync('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('unapplied Effect map callback stays deferred', () => Fx.map(() => readFileSync('fixture', 'utf8')));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import * as OtherEffect from 'other-effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('wrong module curried map stays opaque', () => OtherEffect.map(() => readFileSync('fixture', 'utf8'))(Fx.void));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import * as OtherEffect from 'other-effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('wrong module pipe callback stays opaque', () => Fx.succeed(1).pipe(OtherEffect.map(() => readFileSync('fixture', 'utf8'))));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('shadowed Effect curried map stays opaque', () => { const Fx = { map: (callback) => (effect) => effect }; return Fx.map(() => readFileSync('fixture', 'utf8'))(undefined); });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('shadowed Effect pipe stage stays opaque', () => { const Fx = { map: (callback) => callback }; return ({ pipe: (stage) => stage }).pipe(Fx.map(() => readFileSync('fixture', 'utf8'))); });",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; declare const unknownMapper: unknown; it.effect('unknown curried map argument is not treated as a callback', () => Fx.map(unknownMapper)(Fx.void));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; let readFixture = () => readFileSync('fixture', 'utf8'); readFixture = () => 'safe'; it.effect('a safe reassignment replaces the stale callback initializer', () => Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; function readFixture() { return readFileSync('fixture', 'utf8'); } it.live.only('focused live callback identifier remains allowed', readFixture);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const loadFile = readFileSync; it.effect('shadowed filesystem alias is local', () => { const loadFile = () => 'fixture'; return loadFile(); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const runtimeEnv = process.env; it.effect('shadowed environment alias is local', () => { const runtimeEnv = { HOME: 'fixture' }; return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { argv } from 'node:process'; it.effect('argv is not the process environment object', () => argv.env);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const env = 'argv'; const { [env]: processArgs } = process; it.effect('computed argv destructuring does not read process env', () => processArgs.HOME);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; let envKey = 'env'; envKey = 'argv'; const { [envKey]: processArgs } = process; it.effect('mutated computed key does not acquire process env provenance', () => processArgs.HOME);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const envKey = 'env'; it.effect('shadowed process object with computed env-shaped key is fixture data', () => { const process = { argv: { HOME: 'fixture' } }; const { [envKey]: runtimeEnv } = process; return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('executed helper replaces the environment alias with a fixture', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; const applyFixture = installFixture; applyFixture(); return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('directly called helper replaces the environment alias with a fixture', () => { let { env: runtimeEnv } = process; function installFixture() { runtimeEnv = { HOME: 'fixture' }; } installFixture(); return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('environment replacement stays known when the helper is reassigned afterward', () => { let { env: runtimeEnv } = process; function installFixture() { runtimeEnv = { HOME: 'fixture' }; } installFixture(); installFixture = () => undefined; return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('captured helper keeps its function value after the declaration is reassigned', () => { let { env: runtimeEnv } = process; function installFixture() { runtimeEnv = { HOME: 'fixture' }; } const capturedInstaller = installFixture; installFixture = () => undefined; capturedInstaller(); return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('transitively called helpers replace the environment alias before the read', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; const applyFixture = () => installFixture(); const runFixture = () => applyFixture(); runFixture(); return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; it.effect('executed module helper replaces the environment alias before the read', () => { installFixture(); return runtimeEnv.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; let { env: runtimeEnv } = process; runtimeEnv = { HOME: 'fixture' }; it.effect('reassigned destructured environment alias is local data', () => runtimeEnv.HOME);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const runtimeEnv = { HOME: 'fixture' }; const { HOME: home } = runtimeEnv; it.effect('destructuring a local environment-shaped object is safe', () => home);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function unusedProcessEnvironmentAlias() { const runtimeEnv = process.env; } const runtimeEnv = { HOME: 'fixture' }; it.effect('top-level fixture binding stays local when a helper shadows its name', () => runtimeEnv.HOME);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'node:fs'; const key = getNamespaceName(); const namespace = fs[key]; it.effect('unknown computed runtime namespace alias stays opaque', () => namespace.readFile('fixture', 'utf8'));",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const defaults = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const options = { ...defaults, try: () => 'safe' }; it.effect('later literal option overrides a spread callback', () => Fx.try(options));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.live('Node global timer alias is allowed in a live test', () => new Promise((resolve) => global.setTimeout(resolve, 10)));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; it.live('stable global-object timer alias is allowed in a live test', () => nodeGlobal.setTimeout(() => {}, 10));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function run(global) { return it.effect('shadowed Node global alias stays local', () => global.setTimeout(() => {}, 10)); }",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function run(globalThis) { const nodeGlobal = globalThis; return it.effect('shadowed globalThis alias stays local', () => nodeGlobal.setTimeout(() => {}, 10)); }",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('shadowed global object process data stays local', () => { const global = { process: { env: { HOME: 'fixture' } } }; return global.process.env.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('local global-shaped alias remains local data', () => { const nodeGlobal = { setTimeout: (callback) => callback(), process: { env: { HOME: 'fixture' } } }; nodeGlobal.setTimeout(() => {}, 10); return nodeGlobal.process.env.HOME; });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const processKey = getProcessProperty(); it.effect('dynamic global process property remains opaque', () => globalThis[processKey].env.HOME);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; const processKey = getProcessProperty(); it.effect('dynamic property through a global alias remains opaque', () => nodeGlobal[processKey].env.HOME);",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function run(Promise) { return it.effect('shadowed Promise constructor is not assumed to invoke its executor', () => new Promise((resolve) => globalThis.setTimeout(resolve, 10))); }",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function run(Promise) { const NativePromise = Promise; return it.effect('alias of a shadowed Promise stays unknown', () => new NativePromise((resolve) => global.setTimeout(resolve, 10))); }",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const PromiseConstructor = getPromiseConstructor(); it.effect('unknown Promise constructor does not establish executor reachability', () => new PromiseConstructor((resolve) => globalThis.setTimeout(resolve, 10)));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const PromiseConstructor = getPromiseConstructor(); const PromiseAlias = PromiseConstructor; it.effect('stable alias of an unknown Promise constructor stays unknown', () => new PromiseAlias((resolve) => globalThis.setTimeout(resolve, 10)));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; let PromiseAlias = Promise; PromiseAlias = getPromiseConstructor(); it.effect('mutated Promise constructor alias stays unknown', () => new PromiseAlias((resolve) => globalThis.setTimeout(resolve, 10)));",
      filename: "case.test.ts",
    },
  ],
  [
    {
      code: "import { it } from '@effect/vitest'; it.effect('reassigned helper declaration leaves the environment alias live', () => { let { env: runtimeEnv } = process; function installFixture() { runtimeEnv = { HOME: 'fixture' }; } installFixture = () => undefined; installFixture(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; function readFixture() { return 'fixture'; } readFixture = () => readFileSync('fixture', 'utf8'); it.effect('reassigned helper executes its filesystem read', () => readFixture());",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.try selects the helper assigned by a pre-call nested block', () => { function readFixture() { return 'fixture'; } { readFixture = () => readFileSync('fixture', 'utf8'); } return Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('captured helper after declaration reassignment leaves the environment alias live', () => { let { env: runtimeEnv } = process; function installFixture() { runtimeEnv = { HOME: 'fixture' }; } installFixture = () => undefined; const capturedInstaller = installFixture; capturedInstaller(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('conditional helper reassignment may leave the environment alias live', () => { let { env: runtimeEnv } = process; function installFixture() { runtimeEnv = { HOME: 'fixture' }; } if (shouldReplace) installFixture = () => undefined; installFixture(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { writeFile } from 'node:fs/promises'; function writeSharedFile() { return writeFile('fixture', 'value'); } it.effect('shared helper on Effect test path', () => writeSharedFile()); it.live('same helper on live path', () => writeSharedFile());",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('applied curried Effect map callback executes', () => Fx.map(() => readFileSync('fixture', 'utf8'))(Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.pipe executes a data-last map callback', () => Fx.succeed(1).pipe(Fx.map(() => readFileSync('fixture', 'utf8'))));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.pipe executes a data-last flatMap callback', () => Fx.succeed(1).pipe(Fx.flatMap(() => Fx.promise(() => readFileSync('fixture', 'utf8')))));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.pipe executes a data-last andThen callback', () => Fx.succeed(1).pipe(Fx.andThen(() => readFileSync('fixture', 'utf8'))));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.pipe executes a data-last tap callback', () => Fx.succeed(1).pipe(Fx.tap(() => Fx.promise(() => readFileSync('fixture', 'utf8')))));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('applied curried Effect flatMap callback executes', () => Fx.flatMap(() => readFileSync('fixture', 'utf8'))(Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('applied curried Effect andThen callback executes', () => Fx.andThen(() => readFileSync('fixture', 'utf8'))(Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('applied curried Effect tap callback executes', () => Fx.tap(() => readFileSync('fixture', 'utf8'))(Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('data-first Effect map callback remains recognized', () => Fx.map(Fx.void, () => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const mapEffect = () => readFileSync('fixture', 'utf8'); it.effect('applied curried Effect callback identifier executes', () => Fx.flatMap(mapEffect)(Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { writeFile } from 'node:fs/promises'; const describe = (_label, callback) => callback(); describe('shadowed suite', () => { it.effect('registered Effect test', () => Effect.promise(() => writeFile('fixture', 'value'))); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const runCallback = (callback) => callback(); const createTempDirectory = () => makeTempDirectory('/tmp/test-'); it.effect('identifier callback executes through local wrapper', () => runCallback(createTempDirectory));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('defaulted destructured process environment is live', () => { const { env = {} } = process; return env.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('nested destructured process environment is live', () => { const { env: { HOME } } = process; return HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp } from 'fs/promises'; it.effect('bare promises mkdtemp', () => mkdtemp('/tmp/test-'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { open } from 'node:fs/promises'; it.effect('node promises open', () => open('/tmp/file'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it as effectIt } from '@effect/vitest'; import { readFile as load } from 'node:fs/promises'; effectIt.effect('case', () => load('x'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFile } from 'node:fs'; it.effect('callback fs', () => readFile('x', () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('default fs import', () => fs.readFile('x', () => {})); import fs from 'node:fs';",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import childProcess from 'node:child_process'; it.effect('default child process', () => childProcess.spawn('node', []));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('global interval', () => globalThis.setInterval(() => {}, 10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('global immediate', () => setImmediate(() => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; function withTempCwd() { return makeTempDirectory('/tmp/test-'); } it.effect('invoked file-local filesystem helper', () => withTempCwd());",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const createTempDirectory = () => makeTempDirectory('/tmp/test-'); function withTempCwd() { return createTempDirectory(); } it.effect('invoked helper chain executes filesystem operation', () => withTempCwd());",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const runCallback = (callback) => callback(); it.effect('executed local callback wrapper runs filesystem API', () => runCallback(() => makeTempDirectory('/tmp/test-')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const describe = (_label, callback) => callback(); describe('executed shadow suite', () => { it.effect('registered Effect test', () => Effect.promise(() => makeTempDirectory('/tmp/test-'))); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; function firstHelper() { return secondHelper(); } function secondHelper() { if (shouldReenter) firstHelper(); return makeTempDirectory('/tmp/test-'); } it.effect('recursive helper graph terminates and finds executed API', () => firstHelper());",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it as effectIt } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const writeTempProject = async () => makeTempDirectory('/tmp/test-'); const withTempProject = (use) => Fx.acquireUseRelease(Fx.promise(writeTempProject), use, () => Fx.void); effectIt.effect('identifier thunk executes through local wrapper', () => withTempProject(() => Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it as effectIt } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; effectIt.effect('env', () => runtimeEnv.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; it.effect('computed member reads environment alias', () => client[runtimeEnv]);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('static computed Effect.sync executes its filesystem callback', () => Fx['sync'](() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const EffectAlias = Fx; it.effect('stable Effect alias static computed method executes its callback', () => EffectAlias['sync'](() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('static computed Effect namespace member executes its callback', () => E['Effect'].sync(() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('static computed Effect method executes its callback', () => E.Effect['sync'](() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('global env', () => process.env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('computed global env', () => process['env'].HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; it.effect('env shorthand value', () => ({ runtimeEnv }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('destructured process env', () => { const { env } = process; return env.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('block shadow does not hide global', () => { { const process = {}; } return process.env.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('global timer', () => setTimeout(() => {}, 10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('globalThis timer', () => globalThis.setTimeout(() => {}, 10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('globalThis env', () => globalThis.process.env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as runtime from 'node:process'; it.effect('namespace environment', () => runtime.env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as effectVitest from '@effect/vitest'; import { readFile } from 'node:fs/promises'; effectVitest.it.effect('namespace vitest runtime', () => readFile('fixture'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import fs from 'node:fs'; it.effect('fs promises default', () => fs.promises.readFile('x'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'node:fs'; it.effect('fs promises namespace', () => fs.promises.writeFile('x', 'y'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import fsModule from 'node:fs'; it.effect('static fs promises members', () => fsModule['promises']['writeFile']('x', 'y'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import fs from 'fs'; it.effect('bare default fs promises', () => fs.promises.readFile('x'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'fs'; it.effect('bare namespace fs promises', () => fs.promises.writeFile('x', 'y'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { promises as fsPromises } from 'node:fs'; it.effect('named promises read', () => fsPromises.readFile('x'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { promises as fsPromises } from 'fs'; it.effect('named promises write', () => fsPromises.writeFile('x', 'y'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { scheduler as timerScheduler } from 'node:timers/promises'; it.effect('scheduler wait alias', () => timerScheduler.wait(10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as timers from 'node:timers/promises'; it.effect('scheduler wait namespace', () => timers.scheduler.wait(10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('data-first forEach mapper executes', () => Fx.forEach(['/tmp/test-'], (prefix) => Fx.promise(() => makeTempDirectory(prefix))));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; it.effect('data-last forEach mapper executes', () => Fx.forEach((prefix: string) => Fx.promise(() => makeTempDirectory(prefix)))(['/tmp/test-']));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const forEachOptions = { concurrency: 2 }; const createTempDirectoryEffect = (prefix: string) => Fx.promise(() => makeTempDirectory(prefix)); it.effect('data-last forEach mapper executes with bound options', () => Fx.forEach(createTempDirectoryEffect, forEachOptions)(['/tmp/test-']));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { mkdtemp as makeTempDirectory } from 'node:fs/promises'; const runForEach = (mapper) => Fx.forEach(['/tmp/test-'], mapper); const createTempDirectoryEffect = (prefix) => Fx.promise(() => makeTempDirectory(prefix)); it.effect('local wrapper forwards an executed forEach mapper', () => runForEach(createTempDirectoryEffect));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.try executes its try property', () => Fx.try({ try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { sync as effectSync } from 'effect/Effect'; import { readFileSync } from 'node:fs'; it.effect('named effect/Effect sync executes its callback', () => effectSync(() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as Fx from 'effect/Effect'; import { readFileSync } from 'node:fs'; it.effect('effect/Effect namespace sync executes its callback', () => Fx.sync(() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as EffectApi } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const Fx = EffectApi; it.effect('stable Effect namespace alias executes its callback', () => Fx.sync(() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const Fx = E.Effect; it.effect('stable namespace member alias executes its callback', () => Fx.sync(() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('root namespace Effect member executes its callback', () => E.Effect.sync(() => readFileSync('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { map as effectMap } from 'effect/Effect'; import { readFileSync } from 'node:fs'; it.effect('named effect/Effect map executes its callback', () => effectMap(() => readFileSync('fixture', 'utf8'))(Fx.succeed(1)));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; it.effect('Effect.try executes statically bound option callbacks', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const mutateShadow = () => { const options = {}; options.try = () => 'fixture'; }; it.effect('shadowed option writes do not taint the stable binding', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => 'fixture', ['try']: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; it.effect('last duplicate try property is the effective callback', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const readFixture = () => readFileSync('fixture', 'utf8'); const options = { try: readFixture, catch: (cause) => new Error(String(cause)) }; it.effect('Effect.try executes statically bound callback identifiers', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { ['try']: () => readFileSync('fixture', 'utf8'), ['catch']: (cause) => new Error(String(cause)) }; it.effect('Effect.try executes statically computed option callbacks', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFile } from 'node:fs/promises'; const options = { try: () => readFile('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; it.effect('Effect.tryPromise executes statically bound option callbacks', () => Fx.tryPromise(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.try executes its catch property after failure', () => Fx.try({ try: () => { throw new Error('fixture'); }, catch: () => readFileSync('fixture', 'utf8') }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFile } from 'node:fs/promises'; it.effect('Effect.tryPromise executes its try property', () => Fx.tryPromise({ try: () => readFile('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('Effect.tryPromise executes its catch property after rejection', () => Fx.tryPromise({ try: async () => { throw new Error('fixture'); }, catch: () => readFileSync('fixture', 'utf8') }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const withTryCallback = (callback) => Fx.try({ try: callback, catch: (cause) => new Error(String(cause)) }); const readFixture = () => readFileSync('fixture', 'utf8'); it.effect('local wrapper forwards a try callback property', () => withTryCallback(readFixture));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFile } from 'node:fs/promises'; it.effect('Effect.tryPromise direct callback executes', () => Fx.tryPromise(() => readFile('fixture', 'utf8')));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; let readFixture = () => 'safe'; readFixture = () => readFileSync('fixture', 'utf8'); it.effect('reassigned Effect.try callback identifier executes', () => Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; let readFixture = () => 'safe'; it.effect('later reassignment can affect a deferred callback identifier', () => Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) })); readFixture = () => readFileSync('fixture', 'utf8');",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('captures the unsafe callback before a later local reassignment', () => { let readFixture = () => readFileSync('fixture', 'utf8'); const effect = Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }); readFixture = () => 'safe'; return effect; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('conditional safe reassignment keeps the possible unsafe initializer', () => { let readFixture = () => readFileSync('fixture', 'utf8'); if (useSafeReader) readFixture = () => 'safe'; return Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('conditional reassignment keeps a possible unsafe callback value', () => { let readFixture = () => 'safe'; if (useFileReader) readFixture = () => readFileSync('fixture', 'utf8'); return Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('conditional expression retains each possible callback', () => { let readFixture = () => 'safe'; readFixture = useFileReader ? () => readFileSync('fixture', 'utf8') : () => 'safe'; return Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; let mapEffect = () => Fx.void; mapEffect = () => readFileSync('fixture', 'utf8'); it.effect('reassigned applied Effect callback identifier executes', () => Fx.flatMap(mapEffect)(Fx.void));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const readFixture = () => readFileSync('fixture', 'utf8'); const mutateShadow = () => { let readFixture = () => 'safe'; readFixture = () => readFileSync('other', 'utf8'); }; it.effect('same-named reassignment does not taint outer callback binding', () => Fx.try({ try: readFixture, catch: (cause) => new Error(String(cause)) }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; function readFixture() { return readFileSync('fixture', 'utf8'); } it.effect('named Effect callback executes', readFixture);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect.only('focused Effect callback executes', () => readFileSync('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect.each(['fixture'])('table-driven Effect callback executes', (fixture) => readFileSync(fixture, 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; function registerTests() { it.effect('named suite callback registers an Effect test', () => readFileSync('fixture', 'utf8')); } describe('named suite callback', registerTests);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const runtimeEnv = process.env; it.effect('process environment alias requires live', () => runtimeEnv.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { env as runtimeEnv } from 'node:process'; const firstAlias = runtimeEnv; const secondAlias = firstAlias; it.effect('named process env alias chain requires live', () => secondAlias.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import process from 'node:process'; const firstRuntime = process; const runtime = firstRuntime; it.effect('process object alias chain reaches env', () => runtime.env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const readFixture = readFileSync; it.effect('imported filesystem function alias requires live', () => readFixture('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import fs from 'node:fs'; const loadFile = fs.readFile; it.effect('filesystem namespace member alias requires live', () => loadFile('fixture', () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { statfsSync } from 'node:fs'; it.effect('statfsSync requires live', () => statfsSync('/tmp'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { ftruncateSync } from 'node:fs'; it.effect('ftruncateSync requires live', () => ftruncateSync(3, 0));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'fs'; it.effect('bare fs namespace fsyncSync requires live', () => fs.fsyncSync(3));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { statfs } from 'node:fs/promises'; it.effect('promise statfs requires live', () => statfs('/tmp'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { glob } from 'node:fs'; it.effect('node fs glob requires live', () => glob('*.ts', () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { lchown } from 'fs'; it.effect('bare fs lchown requires live', () => lchown('fixture', 0, 0, () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { lchmod } from 'node:fs'; it.effect('node fs lchmod requires live', () => lchmod('fixture', 0o600, () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { lchmodSync } from 'fs'; it.effect('bare fs lchmodSync requires live', () => lchmodSync('fixture', 0o600));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { lutimes } from 'node:fs'; it.effect('node fs lutimes requires live', () => lutimes('fixture', 0, 0, () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readv } from 'node:fs'; it.effect('node fs readv requires live', () => readv(3, [Buffer.alloc(1)], () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { writev } from 'fs'; it.effect('bare fs writev requires live', () => writev(3, [Buffer.alloc(1)], () => {}));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { openAsBlob } from 'node:fs'; it.effect('node fs openAsBlob requires live', () => openAsBlob('fixture'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { mkdtempDisposable } from 'node:fs/promises'; it.effect('promise mkdtempDisposable requires live', () => mkdtempDisposable('/tmp/test-'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { globSync } from 'node:fs'; it.effect('globSync requires live', () => globSync('*.ts'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect.prop('property test callback executes', { sample: 1 }, () => readFileSync('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect.runIf(true)('conditional test callback executes', () => readFileSync('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect.skipIf(false)('conditional skip test callback executes', () => readFileSync('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { describe } from 'vitest'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; describe('Vitest suite', () => { it.effect('nested Effect callback executes', () => readFileSync('fixture', 'utf8')); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as Vitest from 'vitest'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; Vitest.describe('Vitest namespace suite', () => { it.effect('nested Effect callback executes', () => readFileSync('fixture', 'utf8')); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { describe } from 'vitest'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; describe.only('focused suite', () => { it.effect('nested Effect callback executes', () => readFileSync('fixture', 'utf8')); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import * as Vitest from 'vitest'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; Vitest.describe.each(['case'])('table suite %s', () => { it.effect('nested Effect callback executes', () => readFileSync('fixture', 'utf8')); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { describe } from 'vitest'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; describe.skip('skipped suite still receives policy checks', () => { it.effect('nested Effect callback executes', () => readFileSync('fixture', 'utf8')); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect.runIf(true).each([1])('conditional table-driven callback executes', (value) => readFileSync(String(value), 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function readHome() { return runtimeEnv.HOME; } const runtimeEnv = process.env; it.effect('later local process environment alias is used through an earlier helper', () => readHome());",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const runtimeEnv = process.env; const { HOME: home } = runtimeEnv; it.effect('destructuring a stable process environment alias requires live', () => home);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('process environment read before reassigning its destructured alias is live', () => { let { env: runtimeEnv } = process; const home = runtimeEnv.HOME; runtimeEnv = { HOME: 'fixture' }; return home; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('captured environment alias write through a helper remains live', () => { let { env: runtimeEnv } = process; runtimeEnv = { HOME: 'fixture' }; function restoreEnvironment() { runtimeEnv = process.env; } restoreEnvironment(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const defaults = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const options = { ...defaults }; it.effect('stable spread Effect.try options execute their filesystem callback', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const options = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const alias = options; it.effect('stable Effect.try option aliases execute their filesystem callback', () => Fx.try(alias));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; const defaults = { try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }; const options = { try: () => 'safe', ...defaults }; it.effect('later spread callback overrides an earlier safe option', () => Fx.try(options));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'node:fs'; const fsPromises = fs.promises; it.effect('nested filesystem namespace alias keeps its source identity', () => fsPromises.readFile('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as fs from 'node:fs'; const fsPromises = fs['promises']; it.effect('statically computed nested filesystem namespace alias keeps its source identity', () => fsPromises['readFile']('fixture', 'utf8'));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as timers from 'node:timers/promises'; const scheduler = timers.scheduler; it.effect('nested scheduler namespace alias remains a real timer API', () => scheduler.wait(10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const rawEnvKey = 'env'; const envKey = rawEnvKey; const { [envKey]: runtimeEnv } = process; it.effect('statically aliased computed process env destructuring requires live', () => runtimeEnv.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('uncalled fixture writer does not replace the process environment alias', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('unreachable fixture writer does not replace the process environment alias', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; if (false) installFixture(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('conditional fixture writer may leave the environment alias unchanged', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; if (shouldInstall) installFixture(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('fixture writer after the environment read does not erase its provenance', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; const home = runtimeEnv.HOME; installFixture(); return home; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('shadowed helper alias does not execute the environment writer', () => { let { env: runtimeEnv } = process; const installFixture = () => { runtimeEnv = { HOME: 'fixture' }; }; const applyFixture = installFixture; const unrelated = () => { const applyFixture = () => undefined; applyFixture(); }; unrelated(); return runtimeEnv.HOME; });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { Effect as Fx } from 'effect'; import { it } from '@effect/vitest'; import { readFileSync } from 'node:fs'; it.effect('explicit try callback after opaque spread remains effective', () => Fx.try({ ...getOptions(), try: () => readFileSync('fixture', 'utf8'), catch: (cause) => new Error(String(cause)) }));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('Node global callback timer requires a live test', () => new Promise((resolve) => global.setTimeout(resolve, 10)));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('direct Node global timer requires a live test', () => global.setTimeout(() => {}, 10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('globalThis timer in a Promise executor requires a live test', () => new Promise((resolve) => globalThis.setTimeout(resolve, 10)));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('stable local Promise executor alias reaches a Node global timer', () => { const executor = (resolve) => global.setTimeout(resolve, 10); const executorAlias = executor; return new Promise(executorAlias); });",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('computed Node global callback timer requires a live test', () => global['setTimeout'](() => {}, 10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; const runtimeGlobal = nodeGlobal; it.effect('stable global-object alias chain requires a live test', () => runtimeGlobal['setTimeout'](() => {}, 10));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = global; const runtimeGlobal = nodeGlobal; it.effect('stable global process alias requires a live test', () => runtimeGlobal['process'].env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const NativePromise = Promise; const PromiseAlias = NativePromise; it.effect('stable native Promise alias executes its timer callback', () => new PromiseAlias((resolve) => global.setTimeout(resolve, 10)));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const NativePromise = globalThis['Promise']; it.effect('static globalThis Promise alias executes its timer callback', () => new NativePromise((resolve) => global.setTimeout(resolve, 10)));",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('Node global process environment requires a live test', () => global.process.env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('computed globalThis process environment requires a live test', () => globalThis['process'].env.HOME);",
      message: "live",
      filename: "case.test.ts",
    },
  ],
);
run(
  "controlled-test-timeouts",
  [
    {
      code: "import { it } from '@effect/vitest'; it.effect('case', () => TestClock.adjust(Duration.seconds(1)));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { sleep as fixedSleep } from 'other-effect'; it.effect('wrong module named sleep stays opaque', () => fixedSleep('1 second'));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitInUnusedHelper() { return Effect.sleep(Duration.seconds(1)); } it.effect('unused sleep helper is not an executed clock path', () => Effect.void);",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const method = getEffectMethod(); it.effect('unknown computed Effect method stays opaque for timeout analysis', () => Effect[method](Duration.seconds(1)));",
      filename: "wait.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; const namespaceName = getEffectNamespace(); it.effect('unknown computed Effect namespace stays opaque for timeout analysis', () => E[namespaceName].sleep(E[namespaceName].Duration.seconds(1)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration as BaseDuration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; const LocalDuration = BaseDuration; const Time = LocalDuration; const delay = Time.seconds(5); it.effect('stable aliased Duration sleep is controlled before join', () => Effect.gen(function* () { const pending = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Effect.raceFirst(Fiber.join(pending), Effect.sleep(delay)).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(delay); return yield* Fiber.join(result); }).pipe(Effect.provide(TestClock.layer())));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const Time = Duration; it.effect('nonpositive aliased Duration is not a positive sleep', () => Effect.sleep(Time.seconds(0)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; let Time = Duration; Time = getDuration(); it.effect('mutable Duration namespace remains unknown', () => Effect.sleep(Time.seconds(5)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('shadowed Duration namespace remains unknown', () => { const Duration = { seconds: () => 5 }; return Effect.sleep(Duration.seconds(5)); });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect } from 'effect'; const Time = getDurationNamespace(); it.effect('unknown Duration namespace remains opaque', () => Effect.sleep(Time.seconds(5)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect } from 'effect'; const Time = { seconds: () => 5 }; it.effect('unrelated local duration-shaped object stays unknown', () => Effect.sleep(Time.seconds(5)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitInLiveHelper() { return Effect.sleep(Duration.seconds(1)); } it.live('live helper sleep is allowed', () => waitInLiveHelper());",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.live('static computed Effect.sleep is live timing', () => Effect['sleep'](Duration.seconds(1)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitInShadowedHelper() { return Effect.sleep(Duration.seconds(1)); } it.effect('a shadowed helper does not execute the outer sleep', () => { const waitInShadowedHelper = () => Effect.void; return waitInShadowedHelper(); });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; function controlledHelperSleep() { return Effect.sleep(Duration.seconds(5)); } it.effect('causal clock control still covers a helper sleep', () => Effect.gen(function* () { const pending = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Effect.raceFirst(Fiber.join(pending), controlledHelperSleep().pipe(Effect.as('timed out'))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(5)); return yield* Fiber.join(result); }).pipe(Effect.provide(TestClock.layer())));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { makePreviewAuth as createPreviewAuth } from './preview-auth'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('canonical preview adapter waits for its Deferred before advancing the test clock', () => Effect.gen(function* () { let started; const shouldDelay = true; const adapters = { provisionClient: () => Effect.gen(function* () { if (shouldDelay) { if (started) yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); } }) }; const auth = createPreviewAuth({ adapters }); started = yield* Deferred.make<void>(); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      filename: previewAuthTestFile,
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('immediate race fork adjusts its sleep before joining', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(6)); return yield* Fiber.join(resultFiber); }).pipe(Effect.provide(TestClock.layer())));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('five-second race deadline is advanced before join', () => Effect.gen(function* () { const pending = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Effect.raceFirst(Fiber.join(pending), Effect.sleep(Duration.seconds(5))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(5)); return yield* Fiber.join(result); }).pipe(Effect.provide(TestClock.layer())));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('awaits an HTTP callback signal before advancing its request clock', () => Effect.gen(function* () { const requestStarted = yield* Deferred.make<void>(); let requestCompleted = false; const client = HttpClient.make(() => Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(241))), Effect.andThen(Effect.sync(() => { requestCompleted = true; })))); const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(StagedRunnerSnapshotTransportLive({ httpClientLayer: Layer.succeed(HttpClient.HttpClient, client) }))); const request = yield* transport.activate({}).pipe(Effect.forkChild); yield* Deferred.await(requestStarted); yield* TestClock.adjust(Duration.seconds(240)); yield* TestClock.adjust(Duration.seconds(1)); yield* Fiber.join(request); expect(requestCompleted).toBe(true); }));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('executed nested Effect.gen signals before its HTTP sleep', () => Effect.gen(function* () { const requestStarted = yield* Deferred.make<void>(); const client = HttpClient.make(() => Effect.gen(function* () { yield* Deferred.succeed(requestStarted, undefined); yield* Effect.sleep(Duration.seconds(2)); })); const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(StagedRunnerSnapshotTransportLive({ httpClientLayer: Layer.succeed(HttpClient.HttpClient, client) }))); const request = yield* transport.activate({}).pipe(Effect.forkChild); yield* Deferred.await(requestStarted); yield* TestClock.adjust(Duration.seconds(2)); yield* Fiber.join(request); }));",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect } from 'effect'; it.effect('shadowed Effect object', () => { const Effect = { sleep: () => undefined }; return Effect.sleep('10 millis'); });",
      filename: "case.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.live('timing', () => new Promise((resolve) => setTimeout(resolve, 10)));",
      filename: "timing.test.ts",
    },
    {
      code: "import { it as effectIt } from '@effect/vitest'; effectIt.live('timing', () => new Promise((resolve) => delay(resolve, 10)));",
      filename: "timing.test.ts",
    },
    {
      code: "import * as effectVitest from '@effect/vitest'; import { Effect, Duration } from 'effect'; effectVitest.it.live('namespace live timing', () => Effect.sleep(Duration.seconds(1)));",
      filename: "wait.test.ts",
    },
    {
      code: "import * as effectVitest from '@effect/vitest'; import { Effect, Duration } from 'effect'; function run(effectVitest: unknown) { effectVitest.it.effect('shadowed namespace test', () => Effect.sleep(Duration.seconds(1))); }",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect } from 'effect'; it.effect('integration delay', () => Effect.sleep('10 millis'));",
      filename: "system.integration.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('zero callback-timer delay ignores callback values', () => setTimeout(() => {}, 0, 100));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('zero globalThis callback-timer delay ignores callback values', () => globalThis.setTimeout(() => {}, 0, 100));",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as resolveAfter } from 'node:timers/promises'; import { it } from '@effect/vitest'; it.effect('promise timer result value is not a delay', () => resolveAfter(0, 100));",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as schedule } from 'node:timers'; import { it } from '@effect/vitest'; it.effect('imported callback timer zero delay is controlled', () => new Promise((resolve) => schedule(resolve, 0)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const zeroDelay = 0; it.effect('zero const timer delay ignores callback values', () => setTimeout(() => {}, zeroDelay, 100));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('mapped Effect value does not execute its sleep', () => Effect.map(() => Effect.sleep(Duration.seconds(1)))(Effect.succeed(1)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('pipe map returned Effect remains data', () => Effect.succeed(1).pipe(Effect.map(() => Effect.sleep(Duration.seconds(1)))));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('sync Effect value does not execute its sleep', () => Effect.sync(() => Effect.sleep(Duration.seconds(1))));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('succeed Effect value does not execute its sleep', () => Effect.succeed(Effect.sleep(Duration.seconds(1))));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('promise result carries an Effect value without running it', () => Effect.promise(() => Promise.resolve(Effect.sleep(Duration.seconds(1)))));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('as result carries an Effect value without running it', () => Effect.as(Effect.sleep(Duration.seconds(1)))(Effect.void));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const makeSleepValue = () => Effect.sleep(Duration.seconds(1)); it.effect('mapped helper Effect value is not executed', () => Effect.map(() => makeSleepValue())(Effect.succeed(1)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('post-call nested-block reassignment does not change a captured Effect.void', () => { function wait() { return Effect.void; } const effect = wait(); { wait = () => Effect.sleep(Duration.seconds(1)); } return effect; });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('post-call branch reassignment does not change a captured Effect.void', () => { function wait() { return Effect.void; } const effect = wait(); if (shouldReplace) { wait = () => Effect.sleep(Duration.seconds(1)); } return effect; });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('post-call sequence reassignment does not change a captured Effect.void', () => { function wait() { return Effect.void; } let effect; return (effect = wait(), wait = () => Effect.sleep(Duration.seconds(1)), effect); });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('later assigned helper sleep is not executed after a safe capture', () => { let wait = () => Effect.void; const effect = wait(); wait = () => Effect.sleep(Duration.seconds(1)); return effect; });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitForRemoteFixture() { return Effect.sleep(Duration.seconds(1)); } waitForRemoteFixture = () => Effect.void; it.effect('reassigned helper no longer executes its stale sleep', () => waitForRemoteFixture());",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; let wait = setTimeout; wait = () => undefined; it.effect('reassigned timer alias is not the global timer', () => new Promise((resolve) => wait(resolve, 10)));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('shadowed sleep alias is not Effect.sleep', () => { const sleep = () => Effect.void; return sleep(Duration.seconds(1)); });",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('zero-delay Node global timer is not a positive wall-clock timeout', () => global.setTimeout(() => {}, 0));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; const runtimeGlobal = nodeGlobal; it.effect('zero-delay global alias is not a positive wall-clock timeout', () => runtimeGlobal['setTimeout'](() => {}, 0));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = { setTimeout: (callback) => callback() }; it.effect('local global-shaped timer alias is not a Node timer', () => nodeGlobal.setTimeout(() => {}, 10));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; const timerKey = getTimerProperty(); it.effect('dynamic timer key through global alias remains opaque', () => nodeGlobal[timerKey](() => {}, 10));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; let nodeGlobal = globalThis; nodeGlobal = getGlobalObject(); it.effect('mutated global-object alias remains opaque', () => nodeGlobal.setTimeout(() => {}, 10));",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; it.live('positive global alias timer stays allowed in a live test', () => nodeGlobal.setTimeout(() => {}, 10));",
      filename: "wait.test.ts",
    },
  ],
  [
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('adjustment before scheduling does not control sleep', () => Effect.gen(function* () { yield* TestClock.adjust(Duration.seconds(1)); yield* Effect.sleep(Duration.seconds(1)); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect as Fx } from 'effect'; it.effect('static computed Effect.sleep needs a controlled clock', () => Fx['sleep'](Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; it.effect('computed root Effect Duration remains recognized for timeout analysis', () => E['Effect'].sleep(E['Effect'].Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import * as E from 'effect'; import { it } from '@effect/vitest'; it.effect('static computed root Effect Duration needs a controlled clock', () => E['Effect'].sleep(E['Effect'].Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const wait = Effect['sleep']; it.effect('stable computed Effect.sleep alias needs a controlled clock', () => wait(Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('wait', () => new Promise((resolve) => setTimeout(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('pipe flatMap executes its sleep Effect', () => Effect.succeed(1).pipe(Effect.flatMap(() => Effect.sleep(Duration.seconds(1)))));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitForRemoteFixture() { return Effect.sleep(Duration.seconds(1)); } it.effect('executed local helper sleep needs a controlled test clock', () => waitForRemoteFixture());",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitForRemoteFixture() { return Effect.void; } waitForRemoteFixture = () => Effect.sleep(Duration.seconds(1)); it.effect('reassigned helper executes its sleep and needs a controlled clock', () => waitForRemoteFixture());",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('pre-call nested-block reassignment makes the executed sleep helper require a controlled clock', () => { function wait() { return Effect.void; } { wait = () => Effect.sleep(Duration.seconds(1)); } return wait(); });",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; let waitForRemoteFixture = () => Effect.void; it.effect('reassigned local helper sleep needs a controlled test clock', () => waitForRemoteFixture()); waitForRemoteFixture = () => Effect.sleep(Duration.seconds(1));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('captured helper sleep remains the executed callback after reassignment', () => { let wait = () => Effect.sleep(Duration.seconds(1)); const effect = wait(); wait = () => Effect.void; return effect; });",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function firstWaitHelper() { return secondWaitHelper(); } function secondWaitHelper() { if (shouldReenter) return firstWaitHelper(); return Effect.sleep(Duration.seconds(1)); } it.effect('recursive local helper graph terminates and reports its sleep', () => firstWaitHelper());",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('globalThis wait', () => new Promise((resolve) => globalThis.setTimeout(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('callback timer uses its actual positive delay position', () => setTimeout(() => {}, 10, 0));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as resolveAfter } from 'node:timers/promises'; import { it } from '@effect/vitest'; it.effect('promise timer uses its actual positive delay position', () => resolveAfter(10, 0));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as delay } from 'node:timers/promises'; import { it as effectIt } from '@effect/vitest'; effectIt.effect('wait', () => delay(10));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it as effectIt } from '@effect/vitest'; import { Effect as Fx, Duration as D } from 'effect'; effectIt.effect('wall clock', () => Fx.sleep(D.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect, Duration } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('unused clock helper does not control sleep', () => { function adjustClock() { return TestClock.adjust(Duration.seconds(1)); } return Effect.sleep(Duration.seconds(1)); });",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect, Duration } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('unreachable clock does not control sleep', () => { if (false) TestClock.adjust(Duration.seconds(1)); return Effect.sleep(Duration.seconds(1)); });",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect, Duration } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('adjustment after suspended sleep does not control it', () => Effect.gen(function* () { yield* Effect.sleep(Duration.seconds(1)); yield* TestClock.adjust(Duration.seconds(1)); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect, Duration } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('conditional adjustment does not control unrelated sleep', () => Effect.gen(function* () { if (flag) yield* TestClock.adjust(Duration.seconds(1)); yield* Effect.sleep(Duration.seconds(1)); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('short race advance leaves deadline pending', () => Effect.gen(function* () { const pending = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Effect.raceFirst(Fiber.join(pending), Effect.sleep(Duration.seconds(10))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(1)); return yield* Fiber.join(result); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('conditional yielded clock advance is not guaranteed', () => Effect.gen(function* () { const pending = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Effect.raceFirst(Fiber.join(pending), Effect.sleep(Duration.seconds(10))).pipe(Effect.forkScoped({ startImmediately: true })); yield* (shouldAdvance ? TestClock.adjust(Duration.seconds(10)) : Effect.void); return yield* Fiber.join(result); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('short-circuit yielded clock advance is not guaranteed', () => Effect.gen(function* () { const pending = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Effect.raceFirst(Fiber.join(pending), Effect.sleep(Duration.seconds(10))).pipe(Effect.forkScoped({ startImmediately: true })); yield* ((shouldAdvance && TestClock.adjust(Duration.seconds(10))) || Effect.void); return yield* Fiber.join(result); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as E from 'effect'; it.effect('namespace imported Effect Duration sleep is reported', () => E.Effect.sleep(E.Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { sleep as fixedSleep } from 'effect/Effect'; it.effect('named effect/Effect sleep is controlled', () => fixedSleep('1 second'));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import * as Fx from 'effect/Effect'; it.effect('effect/Effect namespace sleep is controlled', () => Fx.sleep('1 second'));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Effect as EffectApi } from 'effect'; const Fx = EffectApi; it.effect('stable Effect namespace alias sleep is controlled', () => Fx.sleep('1 second'));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { sleep as fixedSleep } from 'effect/Effect'; const sleepAlias = fixedSleep; it.effect('stable named sleep alias is controlled', () => sleepAlias('1 second'));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const deadline = Duration.seconds(5); it.effect('const Effect duration needs a controlled clock', () => Effect.sleep(deadline));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const seconds = 5; const deadline = Duration.seconds(seconds); it.effect('const unit amount resolves through a Duration expression', () => Effect.sleep(deadline));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const delayMs = 25; it.effect('const callback timer delay needs live timing', () => setTimeout(() => {}, delayMs));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as wait } from 'node:timers/promises'; import { it } from '@effect/vitest'; const delayMs = 25; it.effect('const promise timer delay needs live timing', () => wait(delayMs));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { makePreviewAuth } from './fake-preview-auth'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('wrong-module makePreviewAuth cannot use the five-second exemption', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: previewAuthTestFile,
    },
    {
      code: "import { it } from '@effect/vitest'; import { makePreviewAuth } from './fixtures/packages/developer-launcher/src/preview-auth'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('nested wrong-module path with canonical suffix cannot use the five-second exemption', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: nestedPreviewAuthConsumerFile,
    },
    {
      code: "import { it } from '@effect/vitest'; import { makePreviewAuth } from './preview-auth'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('shadowed makePreviewAuth cannot use the five-second exemption', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const makePreviewAuth = ({ adapters }) => ({ provision: () => adapters.provisionClient() }); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: previewAuthTestFile,
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('fork without immediate start does not control its sleep', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped()); yield* TestClock.adjust(Duration.seconds(6)); return yield* Fiber.join(resultFiber); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('forked race requires a join of that fiber', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(6)); return yield* Fiber.join(enqueueFiber); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('advancing after joining the race is too late', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped({ startImmediately: true })); const result = yield* Fiber.join(resultFiber); yield* TestClock.adjust(Duration.seconds(6)); return result; }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('deferred fork does not control its sleep', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped()); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped()); yield* TestClock.adjust(Duration.seconds(6)); return yield* Fiber.join(resultFiber); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('clock adjustment without joining the race fiber does not control sleep', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(6)); return resultFiber; }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('joining a different fiber does not control the race sleep', () => Effect.gen(function* () { const enqueueFiber = yield* Effect.never.pipe(Effect.forkScoped({ startImmediately: true })); const resultFiber = yield* Effect.raceFirst(Fiber.join(enqueueFiber).pipe(Effect.as('completed' as const)), Effect.sleep(Duration.seconds(6)).pipe(Effect.as('test timed out' as const))).pipe(Effect.forkScoped({ startImmediately: true })); yield* TestClock.adjust(Duration.seconds(6)); return yield* Fiber.join(enqueueFiber); }).pipe(Effect.provide(TestClock.layer())));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import * as effectVitest from '@effect/vitest'; import { Effect, Duration } from 'effect'; effectVitest.it.effect('namespace test sleep', () => Effect.sleep(Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('different Deferred bindings do not control the adapter sleep', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const other = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(other); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a shadowed Deferred value does not match the awaited binding', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: (started) => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a shadowed Deferred namespace is not the imported API', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { const Deferred = { succeed: (value) => Effect.succeed(value) }; yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a signal without an executed await does not control sleep', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a matching signal and await need a clock advancement', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('preview adapter advance below its timeout cannot complete', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(4)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "preview-auth.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a conditional signal cannot prove the adapter sleep will be released', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { if (shouldSignal) yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a conditional await cannot establish the adapter handshake', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); if (shouldAwait) yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('a conditional clock adjustment cannot establish the adapter handshake', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); if (shouldAdvance) yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('conditional signal cannot prove the adapter sleep will be released', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { if (shouldSignal) yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('conditional await cannot establish the adapter handshake', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); if (shouldAwait) yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('conditional advance cannot establish the adapter handshake', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); if (shouldAdvance) yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('HTTP callback requires awaiting its own Deferred', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const other = yield* Deferred.make<void>(); const client = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(2))))); const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(StagedRunnerSnapshotTransportLive({ httpClientLayer: Layer.succeed(HttpClient.HttpClient, client) }))); const request = yield* transport.activate({}).pipe(Effect.forkChild); yield* Deferred.await(other); yield* TestClock.adjust(Duration.seconds(2)); yield* Fiber.join(request); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('request advance must reach its delayed completion', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const client = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(241))))); const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(StagedRunnerSnapshotTransportLive({ httpClientLayer: Layer.succeed(HttpClient.HttpClient, client) }))); const request = yield* transport.activate({}).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(240)); yield* Fiber.join(request); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('shadowed HttpClient is not the imported callback API', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const HttpClient = { make: (run) => run() }; const client = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(2))))); const request = yield* Effect.never.pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(2)); yield* Fiber.join(request); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('unused HTTP callback cannot supply a clock handshake', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const client = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(2))))); const request = yield* Effect.never.pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(2)); yield* Fiber.join(request); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('HTTP callback handshake requires joining the request fiber', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const client = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(2))))); const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(StagedRunnerSnapshotTransportLive({ httpClientLayer: Layer.succeed(HttpClient.HttpClient, client) }))); const request = yield* transport.activate({}).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(2)); return request; }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber, Layer } from 'effect'; import { TestClock } from 'effect/testing'; import { HttpClient } from 'effect/unstable/http'; it.effect('advancing after the HTTP request join is too late', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const client = HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.sleep(Duration.seconds(2))))); const transport = yield* StagedRunnerSnapshotTransport.pipe(Effect.provide(StagedRunnerSnapshotTransportLive({ httpClientLayer: Layer.succeed(HttpClient.HttpClient, client) }))); const request = yield* transport.activate({}).pipe(Effect.forkChild); yield* Deferred.await(started); yield* Fiber.join(request); yield* TestClock.adjust(Duration.seconds(2)); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('an uncalled helper is not an executed adapter', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); function unusedAdapter() { return Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }); } const auth = makePreviewAuth({}); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('an uncalled nested helper cannot supply the outer clock handshake', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); const unusedAdvance = () => Effect.gen(function* () { yield* Deferred.await(started); yield* TestClock.adjust(Duration.seconds(5)); }); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Deferred, Duration, Effect, Fiber } from 'effect'; import { TestClock } from 'effect/testing'; it.effect('an unreachable signal and adjustment do not control sleep', () => Effect.gen(function* () { const started = yield* Deferred.make<void>(); const adapters = { provisionClient: () => Effect.gen(function* () { if (false) yield* Deferred.succeed(started, undefined); yield* Effect.sleep('10 seconds'); }) }; const auth = makePreviewAuth({ adapters }); const provision = yield* Effect.result(auth.provision()).pipe(Effect.forkChild); yield* Deferred.await(started); if (false) yield* TestClock.adjust(Duration.seconds(5)); yield* Fiber.join(provision); }));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('late Effect import', () => Effect.sleep(Duration.seconds(1))); import { Effect, Duration } from 'effect';",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('global interval', () => globalThis.setInterval(() => {}, 10));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; function waitForFixture() { return Effect.sleep(Duration.seconds(1)); } it.effect('named callback sleep needs a controlled clock', waitForFixture);",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect.only('focused callback sleep needs a controlled clock', () => Effect.sleep(Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect.each([1])('table-driven sleep needs a controlled clock', () => Effect.sleep(Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function waitWithTimer() { return new Promise((resolve) => setTimeout(resolve, 10)); } it.effect('named callback timer needs live', waitWithTimer);",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const wait = setTimeout; it.effect('stable callback timer alias needs live', () => new Promise((resolve) => wait(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as schedule } from 'node:timers'; import { it } from '@effect/vitest'; it.effect('imported callback timer delay needs live', () => new Promise((resolve) => schedule(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import * as timers from 'node:timers/promises'; import { it } from '@effect/vitest'; const wait = timers.setTimeout; it.effect('namespace promise timer alias needs live', () => wait(10));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import * as timers from 'node:timers'; import { it } from '@effect/vitest'; it.effect('namespace callback timer needs live', () => new Promise((resolve) => timers.setTimeout(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { setTimeout as delay } from 'node:timers/promises'; import { it } from '@effect/vitest'; const wait = delay; it.effect('stable promise timer alias needs live', () => wait(10));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const sleep = Effect.sleep; const wait = sleep; it.effect('stable Effect.sleep alias needs controlled clock', () => wait(Duration.seconds(1)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; const Time = Duration; const delay = Time.seconds(1); it.effect('stable Duration namespace alias needs a controlled clock', () => Effect.sleep(delay));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; import { Duration, Effect } from 'effect'; it.effect('explicit runner executes sleep inside a non-flattening callback', () => Effect.sync(() => Effect.runSync(Effect.sleep(Duration.seconds(1)))));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; it.effect('positive Node global timer requires controlled timeout handling', () => global.setTimeout(() => {}, 10));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const nodeGlobal = globalThis; const runtimeGlobal = nodeGlobal; it.effect('positive stable global alias timer requires controlled timeout handling', () => runtimeGlobal['setTimeout'](() => {}, 10));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const NativePromise = Promise; const PromiseAlias = NativePromise; it.effect('positive timer in a stable native Promise alias requires controlled timeout handling', () => new PromiseAlias((resolve) => global.setTimeout(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const NativePromise = globalThis['Promise']; it.effect('positive timer in a static globalThis Promise alias requires controlled timeout handling', () => new NativePromise((resolve) => global.setTimeout(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; function run(Promise) { const NativePromise = Promise; it.effect('positive timer remains a timeout violation with a shadowed Promise alias', () => new NativePromise((resolve) => global.setTimeout(resolve, 10))); }",
      message: "timeout",
      filename: "wait.test.ts",
    },
    {
      code: "import { it } from '@effect/vitest'; const PromiseConstructor = getPromiseConstructor(); const PromiseAlias = PromiseConstructor; it.effect('positive timer remains a timeout violation with an unknown Promise alias', () => new PromiseAlias((resolve) => global.setTimeout(resolve, 10)));",
      message: "timeout",
      filename: "wait.test.ts",
    },
  ],
);
run(
  "exhaustive-diagnostic-tables",
  [
    "const ordinaryRecord = { a: 'x' };",
    "const diagnosticsByReason = new Set<string>(['not a designated mapping']);",
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic } from './types'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number][\"id\"]; const doctorFailureCodes = { a: 'prerequisite-unavailable' } as const satisfies Readonly<Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>>;",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic as LauncherDiagnostic } from './types'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = { a: 'prerequisite-unavailable' } as const satisfies Record<ConnectedPreviewPrerequisiteId, LauncherDiagnostic['code']>;",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type * as LauncherTypes from './types'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = { a: 'prerequisite-unavailable' } as const satisfies Record<ConnectedPreviewPrerequisiteId, LauncherTypes.Diagnostic['code']>;",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { StagedSourceSnapshotValidationReason as SnapshotReason } from 'sheet-workflow-contracts'; const safeStagedSourceSnapshotValidationReasons = { 'missing-revision': true, 'snapshot-completion-mismatch': true, 'excluded-or-unsafe-path': true, 'duplicate-path': true, 'invalid-mode': true, 'invalid-base64-content': true, 'invalid-package-manifest-encoding': true, 'invalid-package-manifest': true, 'incomplete-workspace-manifest': true } satisfies Record<SnapshotReason, true>;",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic } from './types'; const prerequisites = [{ id: 'canonical-check' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = { 'canonical-check': 'prerequisite-unavailable' } as const satisfies Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>;",
    },
  ],
  [
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const doctorFailureCodes = { a: 'prerequisite-unavailable' };",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number][\"id\"]; const doctorFailureCodes = /* satisfies Readonly<Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>> */ { a: 'prerequisite-unavailable' };",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const doctorFailureCodes = new Set<string>(['prerequisite-unavailable']);",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { StagedSourceSnapshotValidationReason as SnapshotReason } from 'sheet-workflow-contracts'; const safeStagedSourceSnapshotValidationReasons = new Set<string>(['missing-revision']);",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { StagedSourceSnapshotValidationReason as SnapshotReason } from 'sheet-workflow-contracts'; const safeStagedSourceSnapshotValidationReasons = /* satisfies Record<SnapshotReason, true> */ { 'missing-revision': true };",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "type ConnectedPreviewPrerequisiteId = string;",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const prerequisites = [{ id: 'a' }] as const; type Diagnostic = { code: string }; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = { a: 'anything' } as const satisfies Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>;",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type * as Other from './other'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = { a: 'anything' } as const satisfies Record<ConnectedPreviewPrerequisiteId, Other.Diagnostic['code']>;",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic } from './types'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; type Record<K, V> = any; const doctorFailureCodes = { a: 'anything' } satisfies Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>;",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic } from './types'; import type * as Other from './other'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = { a: 'anything' } satisfies Other.Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>;",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic } from './types'; const prerequisites = [{ id: 'a' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; function check() { type Diagnostic = { code: string }; const doctorFailureCodes = { a: 'anything' } as const satisfies Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>; return doctorFailureCodes; }",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const prerequisites = [{ id: 'canonical-check' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; function localTable() { const prerequisites = [{ id: 'future-check' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; return prerequisites; }",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const prerequisites = [{ id: 'canonical-check' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; function shadowedTypeAlias() { type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; return null; }",
      message: "exhaustive",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "import type { Diagnostic } from './types'; const prerequisites = [{ id: 'canonical-check' }] as const; type ConnectedPreviewPrerequisiteId = (typeof prerequisites)[number]['id']; const doctorFailureCodes = ({ 'future-check': 'not-a-canonical-code' } as any) satisfies Record<ConnectedPreviewPrerequisiteId, Diagnostic['code']>;",
      message: "exhaustive",
    },
  ],
);
run(
  "preserve-unknown-evidence",
  [
    "const unrelated = { ordinaryReassignmentBlocked: Boolean(value) };",
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ?? false ? blocked : blocked }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const collapsed = blocked ?? false; return { ordinaryReassignmentBlocked: collapsed ? blocked : blocked }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: unknown) { const Boolean = (value: unknown) => value; return { ordinaryReassignmentBlocked: Boolean(blocked) }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "Schema.decodeUnknownEffect(WorkflowRecreationRecoverySchema)({ ordinaryReassignmentBlocked: value });",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const unrelated = { ordinaryReassignmentBlocked: Boolean(value) };",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked === null ? null : blocked });",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ? true : blocked }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: !!blocked ? true : blocked }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const preserveUnknown = null; function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked === null ? preserveUnknown : blocked }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const update = () => { const set = () => { blocked = true; }; set(); }; update(); const alias = blocked; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const observe = () => undefined; return { ordinaryReassignmentBlocked: alias === null ? (observe(), blocked) : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const aliasAgain = alias; blocked = true; return { ordinaryReassignmentBlocked: alias === null ? aliasAgain : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { blocked = true; const alias = blocked; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; if (false) blocked = true; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (false) setAlias = set; setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; const disabled = false; if (disabled) setAlias = set; setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; false && (setAlias = set); setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; false ? (setAlias = set) : undefined; setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; const retainedAlias = setAlias; if (false) setAlias = set; retainedAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; const shadowedWriter = () => { let setAlias = set; setAlias(); }; setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, copy: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let source = inert; if (false) source = set; let target = inert; if (copy) target = source; target(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; setAlias(); if (should) setAlias = set; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (should) { setAlias(); setAlias = set; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (should) { { setAlias(); } setAlias = set; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, outer: boolean, inner: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (outer) { if (inner) setAlias(); setAlias = set; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (should) { setAlias(); } else { setAlias = set; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; should ? setAlias() : (setAlias = set); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; should ? (setAlias(), setAlias = set) : undefined; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; let update = () => undefined; update(), update = () => { blocked = true; }; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; let update = () => undefined; (update(), undefined), update = () => { blocked = true; }; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; function update(blocked: boolean | null) { blocked = true; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { blocked = true; }; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { if (false) { const set = () => { blocked = true; }; set(); } }; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { const set = () => { blocked = true; }; }; update(); function updateShadow(blocked: boolean | null) { const set = () => { blocked = true; }; set(); } updateShadow(null); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked ?? null });",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ?? null ? blocked : blocked }; }",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked === null ? blocked : false });",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked !== null ? false : blocked });",
    },
    "const unrelatedProducer = () => ({ ordinaryReassignmentBlocked: blocked === null ? false : blocked });",
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ otherEvidence: !blocked });",
    },
    {
      filename: "packages/sheet-workflow-contracts/src/stagedSource.ts",
      code: "const WorkflowRecreationRecoverySchema = Schema.Struct({ ordinaryReassignmentBlocked: Schema.NullOr(Schema.Boolean) });",
    },
  ],
  [
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "Schema.decodeUnknownEffect(WorkflowRecreationRecoverySchema)({ ordinaryReassignmentBlocked: value ?? false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ?? null ? blocked : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked || null ? blocked : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const collapsed = blocked ?? null; return { ordinaryReassignmentBlocked: collapsed ? blocked : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "Schema.decodeUnknownEffect(WorkflowRecreationRecoverySchema)({ ordinaryReassignmentBlocked: Boolean(value) });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: globalThis.Boolean(blocked) });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "Schema.decodeUnknownEffect(WorkflowRecreationRecoverySchema)({ ordinaryReassignmentBlocked: !!value });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "Schema.decodeUnknownEffect(WorkflowRecreationRecoverySchema)({ ['ordinaryReassignmentBlocked']: value ?? false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "Schema.decodeUnknownEffect(WorkflowRecreationRecoverySchema)({ ordinaryReassignmentBlocked: value || false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked ?? false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: !blocked });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked ? true : false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked ? false : true });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ? blocked === true : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ? null : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: !!blocked ? true : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: Boolean(blocked) ? true : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const noEvidence = false; function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked === null ? noEvidence : blocked }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; return { ordinaryReassignmentBlocked: alias === null ? blocked === true : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const first = blocked; const alias = first; return { ordinaryReassignmentBlocked: alias === null ? blocked === true : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; blocked = true; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; blocked = true; return { ordinaryReassignmentBlocked: alias === null ? blocked === true : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; if (shouldReassign) blocked = true; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { blocked = true; }; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { const set = () => { blocked = true; }; set(); }; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { const set = () => { blocked = true; }; const setAlias = set; setAlias(); }; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; function update() { function set() { blocked = true; } set(); } update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; setAlias = set; setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (should) setAlias = set; setAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; if (should) { setAlias = set; setAlias(); } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; should ? (setAlias = set, setAlias()) : undefined; return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; let update = () => undefined; for (const iteration of [1, 2]) { update(), update = () => { blocked = true; }; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; for (const iteration of [1, 2]) { setAlias(); setAlias = set; } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; let writeNext = true; for (const iteration of [1, 2]) { if (writeNext) { setAlias = set; writeNext = false; } else { setAlias(); writeNext = true; } } return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean, copy: boolean) { const alias = blocked; const set = () => { blocked = true; }; const inert = () => undefined; let source = inert; if (should) source = set; let target = inert; if (copy) target = source; target(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const update = () => { const set = () => { blocked = true; }; set(); }; const alias = blocked; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { const set = () => { blocked = true; }; set(); }; return { ordinaryReassignmentBlocked: alias === null ? (update(), blocked) : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { const set = () => { blocked = true; }; set(); }; return { ordinaryReassignmentBlocked: (update(), alias === null ? blocked : alias) }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, should: boolean) { const alias = blocked; const update = () => { if (should) { const set = () => { blocked = true; }; set(); } }; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null, repeat: boolean) { const alias = blocked; const set = () => { blocked = true; }; const start = () => step(); const step = () => { if (repeat) start(); else set(); }; start(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { const set = () => { blocked = true; }; const inert = () => undefined; let setAlias = inert; setAlias = set; setAlias(); }; update(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const alias = blocked; const update = () => { blocked = true; }; let updateAlias = update; updateAlias = updateAlias; updateAlias(); return { ordinaryReassignmentBlocked: alias === null ? blocked : alias }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const noEvidence = false; function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: Boolean(blocked) ? blocked : noEvidence }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const noEvidence = false; function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: !!blocked ? blocked : noEvidence }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const affirmativeFallback = true; function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked === null ? affirmativeFallback : blocked }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked === null ? false : blocked });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked === null ? !blocked : blocked });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked === null ? Boolean(blocked) : blocked });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked ? blocked : false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked !== null ? blocked : false });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "const quarantineOldGroupAfterActivationFailure = () => ({ ordinaryReassignmentBlocked: blocked ?? true });",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked ?? false ? blocked : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { return { ordinaryReassignmentBlocked: blocked || false ? blocked : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/developer-launcher/src/connected-preview.ts",
      code: "function quarantineOldGroupAfterActivationFailure(blocked: boolean | null) { const collapsed = blocked ?? false; return { ordinaryReassignmentBlocked: collapsed ? blocked : false }; }",
      message: "unknown",
    },
    {
      filename: "packages/sheet-workflow-contracts/src/stagedSource.ts",
      code: "const WorkflowRecreationRecoverySchema = Schema.Struct({ ordinaryReassignmentBlocked: Schema.Boolean });",
      message: "unknown",
    },
  ],
);
run(
  "canonical-lifecycle-contracts",
  [
    {
      code: "import { LifecyclePhase as PlanePhase } from './owned-application-contract';",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import type { LifecyclePhase as PhaseType } from './owned-application-contract'; type Phase = PhaseType;",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import { LifecyclePhase as Phase } from './owned-application-contract'; type PhaseType = Phase.Type;",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import type * as PlaneContract from './owned-application-contract'; type Phase = PlaneContract.LifecyclePhase;",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "export const LifecyclePhase = Schema.Literals(['reserved', 'starting', 'ready']); export type LifecyclePhase = typeof LifecyclePhase.Type;",
      filename: "packages/developer-launcher/src/owned-application-contract.ts",
    },
    {
      code: "export type LifecyclePhase = 'reserved' | 'ready';",
      filename: "packages/developer-launcher/src/owned-application-contract.ts",
    },
    {
      code: "import * as PlaneContract from './owned-application-contract'; const phase = PlaneContract.LifecyclePhase;",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import * as PlaneContract from './owned-application-contract'; function unrelated(PlaneContract: unknown) { return (PlaneContract as any).LifecyclePhase; }",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "function unrelated(legacy: unknown) { return (legacy as any).WorkflowTransitionReasonSchema; }",
      filename: "packages/developer-launcher/src/owned-workflow-execution.ts",
    },
    {
      code: "type WorkflowTransitionReason = 'queued' | 'completed';",
      filename: "packages/developer-launcher/src/owned-workflow-execution.ts",
    },
    {
      code: "const LifecyclePhaseSchema = Schema.Literals(['open', 'closed']);",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    "const OtherPhase = Schema.Literals(['open', 'closed']);",
  ],
  [
    {
      code: "const LifecyclePhase = Schema.Literals(['open', 'closed']);",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import { LifecyclePhase as PlanePhase } from './some-other-contract';",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "type LifecyclePhase = 'open' | 'closed';",
      message: "contract",
      filename:
        "packages/tooling-config/test/fixtures/packages/developer-launcher/src/owned-application-contract.ts",
    },
    {
      code: "import { OtherPhase as LifecyclePhase } from './some-other-contract'; type Phase = LifecyclePhase;",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import LifecyclePhase from './owned-application-contract'; type Phase = LifecyclePhase;",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import { LifecyclePhase as PlanePhase } from './owned-application-contract'; function useShadowedPhase() { type PlanePhase = 'not-canonical'; type LocalPhase = PlanePhase; return null; }",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import * as Legacy from './some-other-contract'; const phase = Legacy.LifecyclePhase;",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import Legacy from './owned-application-contract'; const phase = Legacy.LifecyclePhase;",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import LifecyclePhase from './some-other-contract'; type Phase = LifecyclePhase;",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "import type * as Legacy from './some-other-contract'; type Phase = Legacy.LifecyclePhase;",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
    {
      code: "const LifecyclePhase = Schema.Literals(['open', 'closed']);",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-workflow-execution.ts",
    },
    {
      code: "const LifecyclePhase = Schema.Union(Schema.Literal('open'), Schema.Literal('closed'));",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-workflow-execution.ts",
    },
    {
      code: "type LifecyclePhase = 'open' | 'closed';",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-workflow-execution.ts",
    },
    {
      code: "enum LifecyclePhase { Open = 'open', Closed = 'closed' }",
      message: "contract",
      filename: "packages/developer-launcher/src/owned-application-plane.ts",
    },
  ],
);
run(
  "builtin-site-adoption",
  ["const safe = 'unchanged';"],
  [
    {
      code: "const changed = value as string; /* oxlint-disable-line typescript/no-unsafe-type-assertion -- inherited master site */",
      message:
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
    },
    {
      code: "const changed = `${value}`; /* oxlint-disable-line typescript/restrict-template-expressions -- inherited master site */",
      message:
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
    },
    {
      code: "const changed = /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ value as string /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;",
      message: [
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
      ],
    },
    {
      code: "/* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ const changed = value as string; /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */",
      message: [
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
      ],
    },
    {
      code: "/* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */ const changed = value as string;",
      message:
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
    },
    {
      code: "const changed = `${/* oxlint-disable typescript/restrict-template-expressions -- inherited master site */ value /* oxlint-enable typescript/restrict-template-expressions -- inherited master site */}`;",
      message: [
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
        "This inherited built-in diagnostic site changed; remove the stale suppression and resolve the diagnostic.",
      ],
    },
  ],
);

describe("nested ternary baseline sites", () => {
  it("consumes an exact inherited AST site once", () => {
    const remaining = new Map([
      ["Program.body[0]/VariableDeclaration.declarations[0]::inherited", 1],
    ]);
    expect(
      consumeBaselineSite(
        remaining,
        "Program.body[0]/VariableDeclaration.declarations[0]::inherited",
      ),
    ).toBe(true);
    expect(
      consumeBaselineSite(
        remaining,
        "Program.body[0]/VariableDeclaration.declarations[0]::inherited",
      ),
    ).toBe(false);
  });

  it("rejects a changed same-count site and an added duplicate", () => {
    const remaining = new Map([["Program.body[0]::inherited", 1]]);
    expect(consumeBaselineSite(remaining, "Program.body[0]::replacement")).toBe(false);
    expect(consumeBaselineSite(remaining, "Program.body[0]::inherited")).toBe(true);
    expect(consumeBaselineSite(remaining, "Program.body[1]::inherited")).toBe(false);
  });

  it("uses site identity before multiplicity for duplicate expressions", () => {
    const remaining = new Map([["JSXElement.children::same", 1]]);
    expect(consumeBaselineSite(remaining, "JSXElement.children::same")).toBe(true);
    expect(consumeBaselineSite(remaining, "JSXElement.children::same")).toBe(false);
  });
});
