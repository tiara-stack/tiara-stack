import { getDb, schema } from "../db/index";
import { eq, sql } from "drizzle-orm";

export interface SessionValidationResult {
  session: typeof schema.session.$inferSelect | null;
  error: string | null;
}

export interface CloseSessionResult {
  success: boolean;
  error: string | null;
}

export async function getValidSessionByThreadId(
  threadId: string,
): Promise<SessionValidationResult> {
  const db = getDb();

  const session = db
    .select()
    .from(schema.session)
    .where(eq(schema.session.threadId, threadId))
    .get();

  if (!session) {
    return { session: null, error: "No session found for this thread." };
  }

  if (session.deletedAt) {
    return { session: null, error: "This session has been deleted." };
  }

  return { session, error: null };
}

export async function getSessionByAcpSessionId(acpSessionId: string) {
  const db = getDb();

  return db
    .select()
    .from(schema.session)
    .where(eq(schema.session.acpSessionId, acpSessionId))
    .get();
}

export async function getWorkspaceById(workspaceId: number) {
  const db = getDb();

  return db.select().from(schema.workspace).where(eq(schema.workspace.id, workspaceId)).get();
}

export async function getSessionWithWorkspace(acpSessionId: string) {
  const db = getDb();

  const session = db
    .select({
      session: schema.session,
      workspace: schema.workspace,
    })
    .from(schema.session)
    .where(eq(schema.session.acpSessionId, acpSessionId))
    .leftJoin(schema.workspace, eq(schema.session.workspaceId, schema.workspace.id))
    .get();

  return session;
}

export async function closeSession(sessionId: number): Promise<CloseSessionResult> {
  const db = getDb();

  try {
    // Soft delete the session by setting deletedAt
    await db
      .update(schema.session)
      .set({
        deletedAt: sql`(strftime('%s', 'now'))`,
        updatedAt: sql`(strftime('%s', 'now'))`,
      })
      .where(eq(schema.session.id, sessionId));

    return { success: true, error: null };
  } catch (error) {
    return {
      success: false,
      error: `Failed to close session: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
