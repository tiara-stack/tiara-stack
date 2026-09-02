import { sheets, type sheets_v4 } from "@googleapis/sheets";
import {
  Cache,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Semaphore,
} from "effect";
import { GoogleAuth } from "google-auth-library";
import { formatSheetRangeOption } from "sheet-domain";
import {
  type SheetSnapshotReadPolicy,
  type SheetSnapshotDimension,
  type SheetSnapshotTab,
  type SheetSnapshotWindow,
  SpreadsheetId,
  type SheetsDescribeSuccess,
  type SheetsReadSnapshotSuccess,
} from "sheet-workflow-contracts";
import {
  sheetsProviderMetadataResponse,
  sheetsProviderTabProperties,
} from "../shared/sheetsProviderResponse";

const maximumSnapshotBytes = 2 * 1024 * 1024;
const metadataCacheTtl = "60 seconds";
const windowCacheTtl = "30 seconds";
const metadataCacheCapacity = 256;
// A snapshot can occupy up to 2 MiB; keep worst-case cached payloads near 64 MiB.
const windowCacheCapacity = 32;
const snapshotTimeout = "30 seconds";
const snapshotOverallTimeout = "45 seconds";
const providerRequestTimeoutMillis = 30_000;

const providerColor = Schema.Struct({
  red: Schema.optional(Schema.NullOr(Schema.Number)),
  green: Schema.optional(Schema.NullOr(Schema.Number)),
  blue: Schema.optional(Schema.NullOr(Schema.Number)),
  alpha: Schema.optional(Schema.NullOr(Schema.Number)),
});

const providerCellFormat = Schema.Struct({
  textFormat: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        foregroundColor: Schema.optional(Schema.NullOr(providerColor)),
        bold: Schema.optional(Schema.NullOr(Schema.Boolean)),
        italic: Schema.optional(Schema.NullOr(Schema.Boolean)),
        underline: Schema.optional(Schema.NullOr(Schema.Boolean)),
        strikethrough: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  backgroundColor: Schema.optional(Schema.NullOr(providerColor)),
});

const providerCell = Schema.Struct({
  formattedValue: Schema.optional(Schema.NullOr(Schema.String)),
  effectiveFormat: Schema.optional(Schema.NullOr(providerCellFormat)),
});

const providerGridData = Schema.Struct({
  startRow: Schema.optional(Schema.NullOr(Schema.Number)),
  startColumn: Schema.optional(Schema.NullOr(Schema.Number)),
  rowMetadata: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          hiddenByFilter: Schema.optional(Schema.NullOr(Schema.Boolean)),
          hiddenByUser: Schema.optional(Schema.NullOr(Schema.Boolean)),
          pixelSize: Schema.optional(Schema.NullOr(Schema.Number)),
        }),
      ),
    ),
  ),
  columnMetadata: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          hiddenByFilter: Schema.optional(Schema.NullOr(Schema.Boolean)),
          hiddenByUser: Schema.optional(Schema.NullOr(Schema.Boolean)),
          pixelSize: Schema.optional(Schema.NullOr(Schema.Number)),
        }),
      ),
    ),
  ),
  rowData: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          values: Schema.optional(Schema.NullOr(Schema.Array(providerCell))),
        }),
      ),
    ),
  ),
});

const providerMerge = Schema.Struct({
  startRowIndex: Schema.optional(Schema.NullOr(Schema.Number)),
  endRowIndex: Schema.optional(Schema.NullOr(Schema.Number)),
  startColumnIndex: Schema.optional(Schema.NullOr(Schema.Number)),
  endColumnIndex: Schema.optional(Schema.NullOr(Schema.Number)),
});

// The snapshot envelope intentionally mirrors provider metadata while adding grid data and merges.
// fallow-ignore-next-line code-duplication
const providerSnapshotResponse = Schema.Struct({
  spreadsheetId: Schema.optional(Schema.NullOr(Schema.String)),
  sheets: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          properties: Schema.optional(Schema.NullOr(sheetsProviderTabProperties)),
          data: Schema.optional(Schema.NullOr(Schema.Array(providerGridData))),
          merges: Schema.optional(Schema.NullOr(Schema.Array(providerMerge))),
        }),
      ),
    ),
  ),
});

export const SheetSnapshotProviderCode = Schema.Literals([
  "InvalidProviderResponse",
  "AccessDenied",
  "RateLimited",
  "ProviderRejected",
  "SheetMissing",
  "UnsupportedSheetType",
  "WindowOutOfBounds",
  "SnapshotTooLarge",
]);
export type SheetSnapshotProviderCode = Schema.Schema.Type<typeof SheetSnapshotProviderCode>;

export class SheetSnapshotProviderError extends Data.TaggedError("SheetSnapshotProviderError")<{
  readonly operation: "create-client" | "describe" | "readSnapshot";
  readonly code: SheetSnapshotProviderCode;
  readonly cause?: unknown;
}> {}

interface SheetSnapshotProviderShape {
  readonly describe: (
    spreadsheetId: string,
    readPolicy: SheetSnapshotReadPolicy,
  ) => Effect.Effect<Omit<SheetsDescribeSuccess, "workspaceId">, SheetSnapshotProviderError>;
  readonly readSnapshot: (
    spreadsheetId: string,
    sheetId: number,
    window: SheetSnapshotWindow,
    readPolicy: SheetSnapshotReadPolicy,
  ) => Effect.Effect<Omit<SheetsReadSnapshotSuccess, "workspaceId">, SheetSnapshotProviderError>;
}

export class SheetSnapshotProvider extends Context.Service<
  SheetSnapshotProvider,
  SheetSnapshotProviderShape
>()("sheet-workflows/SheetSnapshotProvider") {}

type InternalTab = Omit<SheetSnapshotTab, "sheetType"> & {
  readonly sourceSheetType: string;
};

const publicTab = (tab: InternalTab): SheetSnapshotTab => ({
  sheetId: tab.sheetId,
  title: tab.title,
  hidden: tab.hidden,
  sheetType: "GRID",
  rowCount: tab.rowCount,
  columnCount: tab.columnCount,
});

interface MetadataCacheValue {
  readonly spreadsheetId: typeof SpreadsheetId.Type;
  readonly tabs: ReadonlyArray<InternalTab>;
  readonly fetchedAtEpochMs: number;
}

class WindowCacheKey extends Data.Class<{
  readonly spreadsheetId: typeof SpreadsheetId.Type;
  readonly sheetId: number;
  readonly sheetTitle: string;
  readonly sheetHidden: boolean;
  readonly sourceSheetType: string;
  readonly sheetRowCount: number;
  readonly sheetColumnCount: number;
  readonly startRow: number;
  readonly rowCount: number;
  readonly startColumn: number;
  readonly columnCount: number;
  readonly metadataFetchedAtEpochMs: number;
}> {}

const providerError = (
  operation: SheetSnapshotProviderError["operation"],
  code: SheetSnapshotProviderCode,
  cause?: unknown,
) => new SheetSnapshotProviderError({ operation, code, ...(cause === undefined ? {} : { cause }) });

const providerErrorFromUnknown = (
  operation: SheetSnapshotProviderError["operation"],
  cause: unknown,
): SheetSnapshotProviderError | undefined => {
  if (!Predicate.isTagged("SheetSnapshotProviderError")(cause)) return undefined;
  if (!Predicate.hasProperty(cause, "code")) return undefined;
  const code = Schema.decodeUnknownOption(SheetSnapshotProviderCode)(cause.code);
  return Option.match(code, {
    onNone: () => undefined,
    onSome: (value) => providerError(operation, value, cause),
  });
};

const decodeProviderResponse = <A>(
  operation: "describe" | "readSnapshot",
  schema: Schema.Decoder<A>,
  value: unknown,
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "ignore" });
  } catch (cause) {
    throw providerError(operation, "InvalidProviderResponse", cause);
  }
};

const retrySchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);

// Provider clients expose status through several error shapes; keep the classification exhaustive.
const responseStatus = (cause: unknown): number | undefined =>
  Predicate.hasProperty(cause, "response") &&
  Predicate.isObject(cause.response) &&
  Predicate.hasProperty(cause.response, "status") &&
  Predicate.isNumber(cause.response.status)
    ? cause.response.status
    : Predicate.hasProperty(cause, "code") && Predicate.isNumber(cause.code)
      ? cause.code
      : undefined;

// fallow-ignore-next-line complexity
const responseCode = (cause: unknown): SheetSnapshotProviderCode => {
  const status = responseStatus(cause);
  return status === 401 || status === 403
    ? "AccessDenied"
    : status === 429
      ? "RateLimited"
      : "ProviderRejected";
};

const isRetryableProviderCause = (cause: unknown): boolean => {
  const status = responseStatus(cause);
  return status === undefined || status === 429 || status >= 500;
};

const isRetryableProviderError = (error: SheetSnapshotProviderError): boolean =>
  error.code === "RateLimited" ||
  (error.code === "ProviderRejected" && isRetryableProviderCause(error.cause));

const finiteNonNegative = (value: number | null | undefined): number | undefined =>
  Predicate.isNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;

const normalizeColor = (color: typeof providerColor.Type | null | undefined) => {
  if (Predicate.isNullish(color)) return undefined;
  const normalized = Object.fromEntries(
    (["red", "green", "blue", "alpha"] as const).flatMap((key) =>
      Predicate.isNumber(color[key]) && Number.isFinite(color[key])
        ? [[key, color[key]] as const]
        : [],
    ),
  );
  return Object.keys(normalized).length === 0 ? undefined : normalized;
};

const normalizeDimensionMetadata = (options: {
  readonly dimensions: ReadonlyArray<{
    readonly hiddenByFilter?: boolean | null | undefined;
    readonly hiddenByUser?: boolean | null | undefined;
    readonly pixelSize?: number | null | undefined;
  }>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly operation: "describe" | "readSnapshot";
}): ReadonlyArray<SheetSnapshotDimension> =>
  options.dimensions.flatMap((dimension, index) => {
    const absoluteIndex = options.startIndex + index;
    if (absoluteIndex >= options.endIndex) {
      throw providerError(options.operation, "InvalidProviderResponse");
    }
    const hidden =
      dimension.hiddenByUser === true || dimension.hiddenByFilter === true ? true : undefined;
    const pixelSize = finiteNonNegative(dimension.pixelSize);
    if (hidden === undefined && pixelSize === undefined) {
      return [];
    }
    return [
      {
        index: absoluteIndex,
        ...(hidden === undefined ? {} : { hidden }),
        ...(pixelSize === undefined ? {} : { pixelSize }),
      },
    ];
  });

const normalizeTabs = (
  data: typeof sheetsProviderMetadataResponse.Type,
): {
  readonly spreadsheetId: typeof SpreadsheetId.Type;
  readonly tabs: ReadonlyArray<InternalTab>;
} => {
  const spreadsheetId = decodeProviderResponse("describe", SpreadsheetId, data.spreadsheetId);
  // Metadata normalization validates every tab before it becomes an addressable grid target.
  // fallow-ignore-next-line complexity
  const tabs = (data.sheets ?? []).flatMap(({ properties }) => {
    const sheetId = finiteNonNegative(properties?.sheetId);
    const title = properties?.title;
    const rowCount = finiteNonNegative(properties?.gridProperties?.rowCount);
    const columnCount = finiteNonNegative(properties?.gridProperties?.columnCount);
    const sourceSheetType = properties?.sheetType;
    if (
      sheetId === undefined ||
      title === null ||
      title === undefined ||
      title.length === 0 ||
      sourceSheetType === null ||
      sourceSheetType === undefined
    ) {
      throw providerError("describe", "InvalidProviderResponse");
    }
    if (sourceSheetType === "GRID" && (rowCount === undefined || columnCount === undefined)) {
      throw providerError("describe", "InvalidProviderResponse");
    }
    return [
      {
        sheetId,
        title,
        hidden: properties?.hidden ?? false,
        sourceSheetType,
        rowCount: rowCount ?? 0,
        columnCount: columnCount ?? 0,
      },
    ];
  });
  if (tabs.length === 0) throw providerError("describe", "InvalidProviderResponse");
  if (new Set(tabs.map(({ sheetId }) => sheetId)).size !== tabs.length) {
    throw providerError("describe", "InvalidProviderResponse");
  }
  return { spreadsheetId, tabs };
};

const normalizeDescribe = (
  data: typeof sheetsProviderMetadataResponse.Type,
  fetchedAtEpochMs: number,
): MetadataCacheValue => {
  const normalized = normalizeTabs(data);
  return { ...normalized, fetchedAtEpochMs };
};

const toDescribeSuccess = (
  value: MetadataCacheValue,
): Omit<SheetsDescribeSuccess, "workspaceId"> => ({
  spreadsheetId: value.spreadsheetId,
  tabs: value.tabs.filter(({ sourceSheetType }) => sourceSheetType === "GRID").map(publicTab),
  metadataFetchedAtEpochMs: value.fetchedAtEpochMs,
});

const intersects = (
  left: {
    readonly startRow: number;
    readonly endRow: number;
    readonly startColumn: number;
    readonly endColumn: number;
  },
  right: SheetSnapshotWindow,
) =>
  left.startRow < right.startRow + right.rowCount &&
  left.endRow > right.startRow &&
  left.startColumn < right.startColumn + right.columnCount &&
  left.endColumn > right.startColumn;

// Snapshot normalization is the trust boundary for bounds, identity, formatting, and merges.
// fallow-ignore-next-line complexity
const normalizeSnapshot = (options: {
  readonly data: typeof providerSnapshotResponse.Type;
  readonly metadata: MetadataCacheValue;
  readonly sheetId: number;
  readonly window: SheetSnapshotWindow;
  readonly fetchedAtEpochMs: number;
}): Omit<SheetsReadSnapshotSuccess, "workspaceId"> => {
  if (options.data.spreadsheetId !== options.metadata.spreadsheetId) {
    throw providerError("readSnapshot", "InvalidProviderResponse");
  }
  const tab = options.metadata.tabs.find(({ sheetId }) => sheetId === options.sheetId);
  if (tab === undefined) throw providerError("readSnapshot", "SheetMissing");
  if (tab.sourceSheetType !== "GRID") {
    throw providerError("readSnapshot", "UnsupportedSheetType");
  }
  if (
    options.window.startRow + options.window.rowCount > tab.rowCount ||
    options.window.startColumn + options.window.columnCount > tab.columnCount
  ) {
    throw providerError("readSnapshot", "WindowOutOfBounds");
  }
  if (options.data.sheets?.length !== 1) {
    throw providerError("readSnapshot", "InvalidProviderResponse");
  }
  const responseSheet = options.data.sheets[0];
  const responseSheetId = finiteNonNegative(responseSheet?.properties?.sheetId);
  if (
    responseSheetId !== options.sheetId ||
    responseSheet?.properties?.title !== tab.title ||
    responseSheet?.properties?.sheetType !== "GRID"
  ) {
    throw providerError("readSnapshot", "InvalidProviderResponse");
  }
  if ((responseSheet.data?.length ?? 0) > 1) {
    throw providerError("readSnapshot", "InvalidProviderResponse");
  }
  const gridData = responseSheet?.data?.[0];
  // A provider response without coordinates is not proof that it returned the requested window.
  // Default to the API's origin so the equality check below rejects an omitted or shifted range.
  const startRow = finiteNonNegative(gridData?.startRow) ?? 0;
  const startColumn = finiteNonNegative(gridData?.startColumn) ?? 0;
  if (startRow !== options.window.startRow || startColumn !== options.window.startColumn) {
    throw providerError("readSnapshot", "InvalidProviderResponse");
  }
  const rowMetadata = normalizeDimensionMetadata({
    dimensions: gridData?.rowMetadata ?? [],
    startIndex: startRow,
    endIndex: options.window.startRow + options.window.rowCount,
    operation: "readSnapshot",
  });
  const columnMetadata = normalizeDimensionMetadata({
    dimensions: gridData?.columnMetadata ?? [],
    startIndex: startColumn,
    endIndex: options.window.startColumn + options.window.columnCount,
    operation: "readSnapshot",
  });
  const cells = (gridData?.rowData ?? []).flatMap(({ values }, rowIndex) =>
    // Each provider cell is bounds-checked before formatting is admitted to the public snapshot.
    // fallow-ignore-next-line complexity
    (values ?? []).flatMap((cell, columnIndex) => {
      if (
        startRow + rowIndex >= options.window.startRow + options.window.rowCount ||
        startColumn + columnIndex >= options.window.startColumn + options.window.columnCount
      ) {
        throw providerError("readSnapshot", "InvalidProviderResponse");
      }
      const formattedValue = cell.formattedValue;
      const textFormat = cell.effectiveFormat?.textFormat;
      const textColor = normalizeColor(textFormat?.foregroundColor);
      const backgroundColor = normalizeColor(cell.effectiveFormat?.backgroundColor);
      const hasFormatting =
        textColor !== undefined ||
        backgroundColor !== undefined ||
        textFormat?.bold === true ||
        textFormat?.italic === true ||
        textFormat?.underline === true ||
        textFormat?.strikethrough === true;
      if (Predicate.isNullish(formattedValue) && !hasFormatting) {
        return [];
      }
      return [
        {
          row: startRow + rowIndex,
          column: startColumn + columnIndex,
          formattedValue: formattedValue ?? "",
          ...(textColor === undefined ? {} : { textColor }),
          ...(backgroundColor === undefined ? {} : { backgroundColor }),
          ...(textFormat?.bold === true ? { bold: true } : {}),
          ...(textFormat?.italic === true ? { italic: true } : {}),
          ...(textFormat?.underline === true ? { underline: true } : {}),
          ...(textFormat?.strikethrough === true ? { strikethrough: true } : {}),
        },
      ];
    }),
  );
  // Merge normalization rejects malformed or out-of-bounds provider geometry.
  // fallow-ignore-next-line complexity
  const merges = (responseSheet?.merges ?? []).flatMap((merge) => {
    const startMergeRow = finiteNonNegative(merge.startRowIndex);
    const endMergeRow = finiteNonNegative(merge.endRowIndex);
    const startMergeColumn = finiteNonNegative(merge.startColumnIndex);
    const endMergeColumn = finiteNonNegative(merge.endColumnIndex);
    if (
      startMergeRow === undefined ||
      endMergeRow === undefined ||
      startMergeColumn === undefined ||
      endMergeColumn === undefined
    ) {
      throw providerError("readSnapshot", "InvalidProviderResponse");
    }
    if (
      endMergeRow <= startMergeRow ||
      endMergeColumn <= startMergeColumn ||
      endMergeRow > tab.rowCount ||
      endMergeColumn > tab.columnCount
    ) {
      throw providerError("readSnapshot", "InvalidProviderResponse");
    }
    if (
      !intersects(
        {
          startRow: startMergeRow,
          endRow: endMergeRow,
          startColumn: startMergeColumn,
          endColumn: endMergeColumn,
        },
        options.window,
      )
    ) {
      return [];
    }
    return [
      {
        startRow: startMergeRow,
        endRow: endMergeRow,
        startColumn: startMergeColumn,
        endColumn: endMergeColumn,
      },
    ];
  });
  const value: Omit<SheetsReadSnapshotSuccess, "workspaceId"> = {
    spreadsheetId: options.metadata.spreadsheetId,
    tab: publicTab(tab),
    window: options.window,
    cells,
    rowMetadata,
    columnMetadata,
    merges,
    metadataFetchedAtEpochMs: options.metadata.fetchedAtEpochMs,
    windowFetchedAtEpochMs: options.fetchedAtEpochMs,
  };
  const serialized = JSON.stringify(value);
  if (serialized.length > maximumSnapshotBytes) {
    throw providerError("readSnapshot", "SnapshotTooLarge");
  }
  const encoded = new Uint8Array(Math.min(maximumSnapshotBytes + 1, serialized.length * 3));
  const { read, written } = new TextEncoder().encodeInto(serialized, encoded);
  if (read < serialized.length || written > maximumSnapshotBytes) {
    throw providerError("readSnapshot", "SnapshotTooLarge");
  }
  return value;
};

const makeSnapshotProvider = (
  client: sheets_v4.Sheets,
): Effect.Effect<SheetSnapshotProviderShape> =>
  Effect.gen(function* () {
    const providerRequestSemaphore = Semaphore.makeUnsafe(4);

    const request = <A>(
      operation: "describe" | "readSnapshot",
      run: () => Promise<A>,
    ): Effect.Effect<A, SheetSnapshotProviderError> =>
      providerRequestSemaphore
        .withPermit(
          Effect.tryPromise({
            try: run,
            catch: (cause) =>
              providerErrorFromUnknown(operation, cause) ??
              providerError(operation, responseCode(cause), cause),
          }),
        )
        .pipe(
          Effect.timeout(snapshotTimeout),
          Effect.mapError((error) =>
            Predicate.isTagged("SheetSnapshotProviderError")(error)
              ? error
              : providerError(operation, "ProviderRejected", error),
          ),
          Effect.retry({
            schedule: retrySchedule,
            times: 2,
            while: isRetryableProviderError,
          }),
          Effect.timeout(snapshotOverallTimeout),
          Effect.mapError((error) =>
            Predicate.isTagged("SheetSnapshotProviderError")(error)
              ? error
              : providerError(operation, "ProviderRejected", error),
          ),
        );

    const cacheTtl =
      (ttl: Duration.Input) =>
      (exit: Exit.Exit<unknown, SheetSnapshotProviderError>, _key: unknown) =>
        Exit.isSuccess(exit) ? ttl : "0 millis";

    const loadMetadataFromProvider = (spreadsheetId: string) =>
      request("describe", async () => {
        const response = await client.spreadsheets.get(
          {
            spreadsheetId,
            fields:
              "spreadsheetId,sheets(properties(sheetId,title,hidden,sheetType,gridProperties(rowCount,columnCount)))",
          },
          { timeout: providerRequestTimeoutMillis },
        );
        const value = normalizeDescribe(
          decodeProviderResponse("describe", sheetsProviderMetadataResponse, response.data),
          Date.now(),
        );
        if (value.spreadsheetId !== spreadsheetId) {
          throw providerError("describe", "InvalidProviderResponse");
        }
        return value;
      });

    const metadataCache = yield* Cache.makeWith<
      string,
      MetadataCacheValue,
      SheetSnapshotProviderError
    >(loadMetadataFromProvider, {
      capacity: metadataCacheCapacity,
      timeToLive: cacheTtl(metadataCacheTtl),
    });

    const loadMetadata = (
      spreadsheetId: string,
      readPolicy: SheetSnapshotReadPolicy,
    ): Effect.Effect<MetadataCacheValue, SheetSnapshotProviderError> =>
      readPolicy === "cached"
        ? Cache.get(metadataCache, spreadsheetId)
        : loadMetadataFromProvider(spreadsheetId).pipe(
            Effect.tap((value) => Cache.set(metadataCache, spreadsheetId, value)),
          );

    const describe = (
      spreadsheetId: string,
      readPolicy: SheetSnapshotReadPolicy,
    ): Effect.Effect<Omit<SheetsDescribeSuccess, "workspaceId">, SheetSnapshotProviderError> =>
      loadMetadata(spreadsheetId, readPolicy).pipe(Effect.map(toDescribeSuccess));

    const loadWindowFromProvider = (key: WindowCacheKey) =>
      request("readSnapshot", async () => {
        const tab: InternalTab = {
          sheetId: key.sheetId,
          title: key.sheetTitle,
          hidden: key.sheetHidden,
          sourceSheetType: key.sourceSheetType,
          rowCount: key.sheetRowCount,
          columnCount: key.sheetColumnCount,
        };
        const metadata: MetadataCacheValue = {
          spreadsheetId: key.spreadsheetId,
          tabs: [tab],
          fetchedAtEpochMs: key.metadataFetchedAtEpochMs,
        };
        const range = formatSheetRangeOption(tab.title, {
          sheetId: key.sheetId,
          startRow: key.startRow,
          endRow: key.startRow + key.rowCount,
          startColumn: key.startColumn,
          endColumn: key.startColumn + key.columnCount,
        });
        if (range === undefined) {
          throw new Error("The requested Sheet Configuration preview window is invalid");
        }
        const response = await client.spreadsheets.get(
          {
            spreadsheetId: key.spreadsheetId,
            includeGridData: true,
            ranges: [range],
            fields:
              "spreadsheetId,sheets(properties(sheetId,title,hidden,sheetType,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowMetadata(hiddenByFilter,hiddenByUser,pixelSize),columnMetadata(hiddenByFilter,hiddenByUser,pixelSize),rowData(values(formattedValue,effectiveFormat(textFormat(foregroundColor,bold,italic,underline,strikethrough),backgroundColor)))),merges(startRowIndex,endRowIndex,startColumnIndex,endColumnIndex))",
          },
          { timeout: providerRequestTimeoutMillis },
        );
        return normalizeSnapshot({
          data: decodeProviderResponse("readSnapshot", providerSnapshotResponse, response.data),
          metadata,
          sheetId: key.sheetId,
          window: {
            startRow: key.startRow,
            rowCount: key.rowCount,
            startColumn: key.startColumn,
            columnCount: key.columnCount,
          },
          fetchedAtEpochMs: Date.now(),
        });
      });

    const windowCache = yield* Cache.makeWith<
      WindowCacheKey,
      Omit<SheetsReadSnapshotSuccess, "workspaceId">,
      SheetSnapshotProviderError
    >(loadWindowFromProvider, {
      capacity: windowCacheCapacity,
      timeToLive: cacheTtl(windowCacheTtl),
    });

    const readSnapshot = (
      spreadsheetId: string,
      sheetId: number,
      window: SheetSnapshotWindow,
      readPolicy: SheetSnapshotReadPolicy,
    ): Effect.Effect<Omit<SheetsReadSnapshotSuccess, "workspaceId">, SheetSnapshotProviderError> =>
      Effect.gen(function* () {
        const metadata = yield* loadMetadata(spreadsheetId, readPolicy);
        const tab = metadata.tabs.find((candidate) => candidate.sheetId === sheetId);
        if (tab === undefined)
          return yield* Effect.fail(providerError("readSnapshot", "SheetMissing"));
        if (tab.sourceSheetType !== "GRID") {
          return yield* Effect.fail(providerError("readSnapshot", "UnsupportedSheetType"));
        }
        if (
          window.startRow + window.rowCount > tab.rowCount ||
          window.startColumn + window.columnCount > tab.columnCount
        ) {
          return yield* Effect.fail(providerError("readSnapshot", "WindowOutOfBounds"));
        }
        const key = new WindowCacheKey({
          spreadsheetId: metadata.spreadsheetId,
          sheetId,
          sheetTitle: tab.title,
          sheetHidden: tab.hidden,
          sourceSheetType: tab.sourceSheetType,
          sheetRowCount: tab.rowCount,
          sheetColumnCount: tab.columnCount,
          startRow: window.startRow,
          rowCount: window.rowCount,
          startColumn: window.startColumn,
          columnCount: window.columnCount,
          metadataFetchedAtEpochMs: metadata.fetchedAtEpochMs,
        });
        return yield* readPolicy === "cached"
          ? Cache.get(windowCache, key)
          : loadWindowFromProvider(key).pipe(
              Effect.tap((value) => Cache.set(windowCache, key, value)),
            );
      });

    return { describe, readSnapshot };
  });

export const sheetSnapshotProviderLayer = Layer.effect(
  SheetSnapshotProvider,
  Effect.gen(function* () {
    const auth = yield* Effect.try({
      try: () =>
        new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] }),
      catch: (cause) => providerError("create-client", "ProviderRejected", cause),
    });
    const client = yield* Effect.try({
      try: () => sheets({ version: "v4", auth }),
      catch: (cause) => providerError("create-client", "ProviderRejected", cause),
    });
    return yield* makeSnapshotProvider(client);
  }),
);
