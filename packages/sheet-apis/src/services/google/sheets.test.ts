import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { GoogleSheets, toCellOption } from "./sheets";

describe("GoogleSheets", () => {
  it("trims non-empty cells", () => {
    expect(toCellOption(" Alice ")).toEqual(Option.some("Alice"));
  });

  it("treats blank and whitespace-only cells as empty", () => {
    expect(toCellOption("")).toEqual(Option.none());
    expect(toCellOption("   ")).toEqual(Option.none());
    expect(toCellOption(null)).toEqual(Option.none());
  });

  it("decodes sparse row data cells from Google without requiring missing keys", () => {
    const decoded = Schema.decodeUnknownSync(GoogleSheets.rowDataCellToCellSchema)({
      effectiveValue: { numberValue: 18 },
      formattedValue: "18",
    });

    expect(decoded).toEqual(Option.some("18"));
  });

  it("decodes empty option cells for derived scalar parsers", () => {
    expect(Schema.decodeUnknownSync(GoogleSheets.cellToBooleanSchema)(Option.none())).toEqual(
      Option.none(),
    );
    expect(Schema.decodeUnknownSync(GoogleSheets.cellToNumberSchema)(Option.none())).toEqual(
      Option.none(),
    );
    expect(Schema.decodeUnknownSync(GoogleSheets.cellToStringArraySchema)(Option.none())).toEqual(
      Option.none(),
    );
  });

  it("decodes empty row-data cells to none", () => {
    expect(Schema.decodeUnknownSync(GoogleSheets.rowDataToCellSchema)([{}])).toEqual(Option.none());
  });

  it("prefers effective format when checking whether a cell is bold", () => {
    const [cell] = Schema.decodeUnknownSync(GoogleSheets.rowDataSchema)([
      {
        formattedValue: "Alice",
        effectiveFormat: { textFormat: { bold: true } },
        userEnteredFormat: { textFormat: { bold: false } },
      },
    ]);

    expect(cell).toBeDefined();
    expect(GoogleSheets.rowDataCellIsBold(cell!)).toBe(true);
  });

  it("falls back to user-entered format when effective format is missing", () => {
    const [cell] = Schema.decodeUnknownSync(GoogleSheets.rowDataSchema)([
      {
        formattedValue: "Alice",
        userEnteredFormat: { textFormat: { bold: true } },
      },
    ]);

    expect(cell).toBeDefined();
    expect(GoogleSheets.rowDataCellIsBold(cell!)).toBe(true);
  });

  it("prefers effective format when checking whether a cell is underlined", () => {
    const [cell] = Schema.decodeUnknownSync(GoogleSheets.rowDataSchema)([
      {
        formattedValue: "Alice",
        effectiveFormat: { textFormat: { underline: true } },
        userEnteredFormat: { textFormat: { underline: false } },
      },
    ]);

    expect(cell).toBeDefined();
    expect(GoogleSheets.rowDataCellIsUnderline(cell!)).toBe(true);
  });

  it("falls back to user-entered underline format when effective format is missing", () => {
    const [cell] = Schema.decodeUnknownSync(GoogleSheets.rowDataSchema)([
      {
        formattedValue: "Alice",
        userEnteredFormat: { textFormat: { underline: true } },
      },
    ]);

    expect(cell).toBeDefined();
    expect(GoogleSheets.rowDataCellIsUnderline(cell!)).toBe(true);
  });
});
