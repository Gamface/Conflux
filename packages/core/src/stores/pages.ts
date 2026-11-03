import type { Db, Row } from "../db.ts";
import { ftsQuery, now } from "../db.ts";
import { newId } from "../events.ts";

/**
 * Spaces and pages (OpenDots): a home for durable work. Coworkers save results here; people edit
 * them directly. Every write carries the revision it was based on, so a stale edit — from a person
 * or an agent — can never silently overwrite newer content.
 */
export class StaleRevisionError extends Error {
  current: Row;
  constructor(current: Row) {
    super(`page was changed since revision ${current.revision - 0}; reload and re-apply your edit`);
    this.current = current;
  }
}

export class PageStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(space?: string): Row[] {
    return space
      ? this.db.all("SELECT id, space, parent_id, title, revision, author, updated_at, substr(body,1,240) AS excerpt FROM pages WHERE space=? ORDER BY updated_at DESC", space)
      : this.db.all("SELECT id, space, parent_id, title, revision, author, updated_at, substr(body,1,240) AS excerpt FROM pages ORDER BY updated_at DESC");
  }

  spaces(): string[] {
    return this.db.all("SELECT DISTINCT space FROM pages ORDER BY space").map((r) => r.space);
  }

  get(id: string): Row | undefined {
    return this.db.get("SELECT * FROM pages WHERE id=?", id);
  }

  findByTitle(space: string, title: string): Row | undefined {
    return this.db.get("SELECT * FROM pages WHERE space=? AND lower(title)=lower(?)", space, title);
  }

  create(p: { title: string; body: string; space?: string; parentId?: string; author: string }): Row {
    const id = newId("pg_");
    const t = now();
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO pages (id, space, parent_id, title, body, revision, author, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)",
        id, p.space ?? "default", p.parentId, p.title, p.body, p.author, t, t,
      );
      this.db.run("INSERT INTO pages_fts (title, body, page_id) VALUES (?,?,?)", p.title, p.body, id);
    });
    return this.get(id)!;
  }

  update(id: string, p: { title?: string; body?: string; baseRevision?: number; author: string }): Row {
    const cur = this.get(id);
    if (!cur) throw new Error(`no page ${id}`);
    if (p.baseRevision !== undefined && p.baseRevision !== cur.revision) throw new StaleRevisionError(cur);
    const title = p.title ?? cur.title;
    const body = p.body ?? cur.body;
    this.db.tx(() => {
      this.db.run("UPDATE pages SET title=?, body=?, revision=revision+1, author=?, updated_at=? WHERE id=?", title, body, p.author, now(), id);
      this.db.run("DELETE FROM pages_fts WHERE page_id=?", id);
      this.db.run("INSERT INTO pages_fts (title, body, page_id) VALUES (?,?,?)", title, body, id);
    });
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.tx(() => {
      this.db.run("UPDATE pages SET parent_id=NULL WHERE parent_id=?", id);
      this.db.run("DELETE FROM pages WHERE id=?", id);
      this.db.run("DELETE FROM pages_fts WHERE page_id=?", id);
    });
  }

  search(query: string, spaces?: string[], limit = 8): Row[] {
    const rows = this.db.all(
      "SELECT page_id AS id, title, snippet(pages_fts, 1, '[', ']', '…', 24) AS snippet, bm25(pages_fts) AS score FROM pages_fts WHERE pages_fts MATCH ? ORDER BY score LIMIT ?",
      ftsQuery(query), limit * 3,
    );
    return rows
      .map((r) => ({ ...r, space: this.get(r.id)?.space }))
      .filter((r) => !spaces || spaces.includes(r.space))
      .slice(0, limit);
  }
}
