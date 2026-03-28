import { getDb, schema } from "../db/index";
import { eq, and } from "drizzle-orm";

export interface WorkspaceValidationResult {
  workspace: typeof schema.workspace.$inferSelect | null;
  error: string | null;
}

export async function getValidWorkspaceByUserAndName(
  userId: string,
  name: string,
): Promise<WorkspaceValidationResult> {
  const db = getDb();

  const workspace = db
    .select()
    .from(schema.workspace)
    .where(and(eq(schema.workspace.userId, userId), eq(schema.workspace.name, name)))
    .get();

  if (!workspace) {
    return { workspace: null, error: `Workspace "${name}" not found!` };
  }

  if (workspace.deletedAt) {
    return { workspace: null, error: `Workspace "${name}" has been deleted!` };
  }

  return { workspace, error: null };
}

export async function getWorkspaceByUserAndName(userId: string, name: string) {
  const db = getDb();

  return db
    .select()
    .from(schema.workspace)
    .where(and(eq(schema.workspace.userId, userId), eq(schema.workspace.name, name)))
    .get();
}

export async function createOrUpdateWorkspace(
  userId: string,
  name: string,
  cwd: string,
): Promise<{ action: "created" | "updated" }> {
  const db = getDb();

  const existing = await getWorkspaceByUserAndName(userId, name);

  if (existing) {
    await db
      .update(schema.workspace)
      .set({ cwd, updatedAt: new Date() })
      .where(eq(schema.workspace.id, existing.id));
    return { action: "updated" };
  } else {
    await db.insert(schema.workspace).values({ userId, name, cwd });
    return { action: "created" };
  }
}
