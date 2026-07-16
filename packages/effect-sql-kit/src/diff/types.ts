export type MigrationStatement = {
  readonly sql: string;
  readonly destructive?: boolean | undefined;
  readonly unsupported?: boolean | undefined;
  readonly reason?: string | undefined;
};

export type DiffResult = {
  readonly statements: readonly MigrationStatement[];
};
