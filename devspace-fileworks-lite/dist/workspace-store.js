import { eq } from "drizzle-orm";
import { openDatabase } from "./db/client.js";
import { workspaceSessions, } from "./db/schema.js";
export class SqliteWorkspaceStore {
    database;
    constructor(stateDir) {
        this.database = openDatabase(stateDir);
    }
    createSession(input) {
        const now = new Date().toISOString();
        const session = {
            id: input.id,
            root: input.root,
            status: "active",
            mode: input.mode ?? "checkout",
            sourceRoot: input.sourceRoot,
            baseRef: input.baseRef,
            baseSha: input.baseSha,
            managed: input.managed ?? false,
            createdAt: now,
            lastUsedAt: now,
        };
        this.database.db
            .insert(workspaceSessions)
            .values({
            id: session.id,
            root: session.root,
            status: session.status,
            mode: session.mode,
            sourceRoot: session.sourceRoot ?? null,
            baseRef: session.baseRef ?? null,
            baseSha: session.baseSha ?? null,
            managed: String(session.managed),
            createdAt: session.createdAt,
            lastUsedAt: session.lastUsedAt,
        })
            .run();
        return session;
    }
    getSession(id) {
        const row = this.database.db
            .select()
            .from(workspaceSessions)
            .where(eq(workspaceSessions.id, id))
            .get();
        return row ? rowToWorkspaceSession(row) : undefined;
    }
    touchSession(id) {
        this.database.db
            .update(workspaceSessions)
            .set({ lastUsedAt: new Date().toISOString() })
            .where(eq(workspaceSessions.id, id))
            .run();
    }
    close() {
        this.database.close();
    }
}
export function createWorkspaceStore(stateDir) {
    return new SqliteWorkspaceStore(stateDir);
}
function rowToWorkspaceSession(row) {
    return {
        id: row.id,
        root: row.root,
        status: row.status,
        mode: row.mode === "worktree" ? "worktree" : "checkout",
        sourceRoot: row.sourceRoot ?? undefined,
        baseRef: row.baseRef ?? undefined,
        baseSha: row.baseSha ?? undefined,
        managed: row.managed === "true",
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
    };
}
