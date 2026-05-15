import camelCase from "camelcase";
import path from "node:path";
import type { CodeBlockWriter, Project, SourceFile } from "ts-morph";
import { VariableDeclarationKind } from "ts-morph";
import { inferTable, type InferredColumn, type InferredTable } from "./infer";
import type { EffectZeroSchema, RelationshipConfig } from "./types";
import { typedEntries } from "./util";

export type ConfigImport = {
  readonly exportName: "default" | "schema";
  readonly configFilePath: string;
};

export type GeneratedSchemaOptions = {
  readonly tsProject: Project;
  readonly zeroSchema: EffectZeroSchema;
  readonly outputFilePath: string;
  readonly configImport: ConfigImport;
  readonly jsExtensionOverride?: "auto" | "force" | "none";
  readonly skipTypes?: boolean;
  readonly skipBuilder?: boolean;
  readonly skipDeclare?: boolean;
  readonly enableLegacyMutators?: boolean;
  readonly enableLegacyQueries?: boolean;
  readonly debug?: boolean;
};

const schemaObjectName = "schema";

const sanitizeIdentifier = (value: string, fallback: string) => {
  const base = camelCase(value, { pascalCase: false }) || fallback;
  const cleaned = base.replace(/[^A-Za-z0-9_$]/g, "") || fallback;
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
};

const ensureSuffix = (identifier: string, suffix: string) =>
  identifier.toLowerCase().endsWith(suffix.toLowerCase()) ? identifier : `${identifier}${suffix}`;

const getUniqueIdentifier = (used: Set<string>, identifier: string) => {
  let candidate = identifier;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${identifier}${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
};

const writeObjectReferenceMap = (
  writer: CodeBlockWriter,
  map: Record<string, unknown>,
  names: Map<string, string>,
  indent: number,
) => {
  const entries = Object.keys(map);
  const indentString = " ".repeat(indent);

  writer.write("{");
  if (entries.length > 0) {
    writer.newLine();
    for (let i = 0; i < entries.length; i++) {
      const key = entries[i];
      writer.write(`${indentString}  ${JSON.stringify(key)}: ${names.get(key) ?? "undefined"}`);
      if (i < entries.length - 1) {
        writer.write(",");
      }
      writer.newLine();
    }
    writer.write(indentString);
  }
  writer.write("}");
};

const writeJsonValue = (writer: CodeBlockWriter, value: unknown, indent = 0) => {
  const indentString = " ".repeat(indent);

  if (Array.isArray(value)) {
    writer.write("[");
    value.forEach((item, index) => {
      if (index > 0) {
        writer.write(", ");
      }
      writeJsonValue(writer, item, indent);
    });
    writer.write("]");
    return;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    writer.write("{");
    if (entries.length > 0) {
      writer.newLine();
      for (let i = 0; i < entries.length; i++) {
        const [key, child] = entries[i];
        writer.write(`${indentString}  ${JSON.stringify(key)}: `);
        writeJsonValue(writer, child, indent + 2);
        if (i < entries.length - 1) {
          writer.write(",");
        }
        writer.newLine();
      }
      writer.write(indentString);
    }
    writer.write("}");
    return;
  }

  writer.write(JSON.stringify(value));
};

const columnCustomType = (tableName: string, columnName: string) =>
  `null as unknown as EffectZero.ColumnType<typeof effectZeroConfig, ${JSON.stringify(tableName)}, ${JSON.stringify(columnName)}>`;

const writeColumn = (
  writer: CodeBlockWriter,
  tableName: string,
  columnName: string,
  column: InferredColumn,
  indent = 4,
) => {
  const indentString = " ".repeat(indent);

  writer.write("{");
  writer.newLine();
  writer.write(`${indentString}type: ${JSON.stringify(column.type)},`);
  writer.newLine();
  writer.write(`${indentString}optional: ${String(column.optional)},`);
  writer.newLine();
  writer.write(`${indentString}customType: ${columnCustomType(tableName, columnName)}`);
  if (column.serverName) {
    writer.write(",");
    writer.newLine();
    writer.write(`${indentString}serverName: ${JSON.stringify(column.serverName)}`);
  }
  writer.newLine();
  writer.write(" ".repeat(indent - 2));
  writer.write("}");
};

const writeTableObject = (writer: CodeBlockWriter, tableName: string, table: InferredTable) => {
  writer.write("{");
  writer.newLine();
  writer.write(`  name: ${JSON.stringify(table.name)},`);
  writer.newLine();
  writer.write("  columns: {");
  const columnEntries = typedEntries(table.columns);
  if (columnEntries.length > 0) {
    writer.newLine();
    for (let i = 0; i < columnEntries.length; i++) {
      const [columnName, column] = columnEntries[i];
      writer.write(`    ${JSON.stringify(columnName)}: `);
      writeColumn(writer, tableName, columnName, column, 6);
      if (i < columnEntries.length - 1) {
        writer.write(",");
      }
      writer.newLine();
    }
    writer.write("  ");
  }
  writer.write("},");
  writer.newLine();
  writer.write("  primaryKey: ");
  writeJsonValue(writer, table.primaryKey);
  if (table.serverName && table.serverName !== table.name) {
    writer.write(",");
    writer.newLine();
    writer.write(`  serverName: ${JSON.stringify(table.serverName)}`);
  }
  writer.newLine();
  writer.write("}");
};

const writeRelationships = (
  writer: CodeBlockWriter,
  relationships: RelationshipConfig,
  indent = 2,
) => {
  writeJsonValue(writer, relationships, indent);
};

const moduleSpecifierFrom = (source: SourceFile, targetPath: string, needsJsExtension: boolean) => {
  const target = source.getProject().addSourceFileAtPathIfExists(targetPath);
  if (!target) {
    const relativePath = path
      .relative(path.dirname(source.getFilePath()), targetPath)
      .replaceAll(path.sep, "/");
    const withDot = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
    const withoutExtension = withDot.replace(/\.[cm]?tsx?$/, "");
    return needsJsExtension ? `${withoutExtension}.js` : withoutExtension;
  }

  const specifier = source.getRelativePathAsModuleSpecifierTo(target);
  return needsJsExtension && !specifier.endsWith(".js") ? `${specifier}.js` : specifier;
};

export const getGeneratedSchema = ({
  tsProject,
  zeroSchema,
  outputFilePath,
  configImport,
  jsExtensionOverride = "auto",
  skipTypes = false,
  skipBuilder = false,
  skipDeclare = false,
  enableLegacyMutators = false,
  enableLegacyQueries = false,
  debug = false,
}: GeneratedSchemaOptions): string => {
  const compilerOptions = tsProject.getCompilerOptions();
  const moduleResolution = compilerOptions.moduleResolution;
  const needsJsExtension =
    jsExtensionOverride === "force" ||
    (jsExtensionOverride === "auto" && (moduleResolution === 3 || moduleResolution === 99));

  const sourceFile = tsProject.createSourceFile(outputFilePath, "", { overwrite: true });
  sourceFile.addStatements("// This file was automatically generated by effect-zero.");
  sourceFile.addStatements(
    "// You should NOT make any changes in this file as it will be overwritten.",
  );
  sourceFile.addStatements("");

  if (!skipBuilder) {
    sourceFile.addImportDeclaration({
      moduleSpecifier: "@rocicorp/zero",
      namedImports: [{ name: "createBuilder" }],
    });
  }
  sourceFile.addImportDeclaration({
    moduleSpecifier: "effect-zero",
    namespaceImport: "EffectZero",
    isTypeOnly: true,
  });

  const configModuleSpecifier = moduleSpecifierFrom(
    sourceFile,
    path.resolve(process.cwd(), configImport.configFilePath),
    needsJsExtension,
  );
  sourceFile.addImportDeclaration(
    configImport.exportName === "default"
      ? {
          moduleSpecifier: configModuleSpecifier,
          defaultImport: "effectZeroConfig",
          isTypeOnly: true,
        }
      : {
          moduleSpecifier: configModuleSpecifier,
          namedImports: [{ name: configImport.exportName, alias: "effectZeroConfig" }],
          isTypeOnly: true,
        },
  );

  const usedNames = new Set<string>([schemaObjectName, "builder", "zql"]);
  const tableConstNames = new Map<string, string>();
  const inferredTables = new Map<string, InferredTable>();

  for (const [tableKey, table] of typedEntries(zeroSchema.tables)) {
    const constName = getUniqueIdentifier(
      usedNames,
      ensureSuffix(sanitizeIdentifier(tableKey, "table"), "Table"),
    );
    tableConstNames.set(tableKey, constName);
    inferredTables.set(tableKey, inferTable(table, { debug }));
  }

  for (const [tableKey, table] of inferredTables) {
    sourceFile.addVariableStatement({
      declarationKind: VariableDeclarationKind.Const,
      declarations: [
        {
          name: tableConstNames.get(tableKey) ?? `${tableKey}Table`,
          initializer: (writer) => {
            writeTableObject(writer, tableKey, table);
            writer.write(" as const");
          },
        },
      ],
    });
  }

  sourceFile.addVariableStatement({
    isExported: true,
    declarationKind: VariableDeclarationKind.Const,
    declarations: [
      {
        name: schemaObjectName,
        initializer: (writer) => {
          writer.write("{");
          writer.newLine();
          writer.write("  tables: ");
          writeObjectReferenceMap(writer, zeroSchema.tables, tableConstNames, 2);
          writer.write(",");
          writer.newLine();
          writer.write("  relationships: ");
          writeRelationships(writer, zeroSchema.relationships, 2);
          writer.write(",");
          writer.newLine();
          writer.write(
            `  enableLegacyQueries: ${String(enableLegacyQueries || zeroSchema.enableLegacyQueries === true)},`,
          );
          writer.newLine();
          writer.write(
            `  enableLegacyMutators: ${String(enableLegacyMutators || zeroSchema.enableLegacyMutators === true)}`,
          );
          writer.newLine();
          writer.write("} as const");
        },
      },
    ],
  });

  if (!skipTypes) {
    sourceFile.addTypeAlias({
      isExported: true,
      name: "Schema",
      type: `typeof ${schemaObjectName}`,
    });
  }

  if (!skipBuilder) {
    sourceFile.addVariableStatement({
      isExported: true,
      declarationKind: VariableDeclarationKind.Const,
      declarations: [{ name: "zql", initializer: `createBuilder(${schemaObjectName})` }],
    });
    sourceFile.addVariableStatement({
      isExported: true,
      declarationKind: VariableDeclarationKind.Const,
      declarations: [{ name: "builder", initializer: "zql" }],
    });
  }

  if (!skipDeclare && !skipTypes) {
    sourceFile.addStatements((writer) => {
      writer.blankLine();
      writer.write('declare module "@rocicorp/zero" {');
      writer.newLine();
      writer.write("  interface ZeroSchema extends Schema {}");
      writer.newLine();
      writer.write("}");
    });
  }

  return sourceFile.getFullText();
};
