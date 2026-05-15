export type MigrationStatement = {
  readonly sql: string;
  readonly destructive?: boolean;
  readonly unsupported?: boolean;
  readonly reason?: string;
};

export type DiffResult = {
  readonly statements: readonly MigrationStatement[];
};
