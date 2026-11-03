import type { Db, Row } from "../db.ts";
import { ftsQuery, now } from "../db.ts";
import { newId } from "../events.ts";

/**
 * Knowledge bases (Dify): datasets of documents, chunked on paragraph boundaries and retrieved with
 * BM25 full-text ranking. No embedding service is required, which keeps retrieval local, cheap and
 * explainable; an embedding retriever can be added behind the same `search` signature.
 */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const paras = text.replace(/\r/g, "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > size && cur) {
      chunks.push(cur);
      cur = cur.slice(-overlap) + "\n\n" + p;
    } else cur = cur ? cur + "\n\n" + p : p;
    while (cur.length > size * 1.5) {
      chunks.push(cur.slice(0, size));
      cur = cur.slice(size - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

export class KnowledgeStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  datasets(): Row[] {
    return this.db.all("SELECT dataset, COUNT(DISTINCT title) AS documents, COUNT(*) AS chunks FROM knowledge GROUP BY dataset ORDER BY dataset");
  }

  documents(dataset: string): Row[] {
    return this.db.all("SELECT title, source, COUNT(*) AS chunks, MAX(created_at) AS created_at FROM knowledge WHERE dataset=? GROUP BY title ORDER BY title", dataset);
  }

  add(dataset: string, title: string, content: string, source?: string): number {
    const chunks = chunkText(content);
    this.db.tx(() => {
      this.removeDocument(dataset, title, false);
      chunks.forEach((c, i) => {
        const id = newId("kn_");
        this.db.run("INSERT INTO knowledge (id, dataset, title, chunk, content, source, created_at) VALUES (?,?,?,?,?,?,?)", id, dataset, title, i, c, source, now());
        this.db.run("INSERT INTO knowledge_fts (content, title, dataset, chunk_id) VALUES (?,?,?,?)", c, title, dataset, id);
      });
    });
    return chunks.length;
  }

  removeDocument(dataset: string, title: string, tx = true): void {
    const work = () => {
      const ids = this.db.all("SELECT id FROM knowledge WHERE dataset=? AND title=?", dataset, title);
      for (const r of ids) this.db.run("DELETE FROM knowledge_fts WHERE chunk_id=?", r.id);
      this.db.run("DELETE FROM knowledge WHERE dataset=? AND title=?", dataset, title);
    };
    if (tx) this.db.tx(work);
    else work();
  }

  search(query: string, opts: { dataset?: string; topK?: number } = {}): Row[] {
    const topK = opts.topK ?? 5;
    const rows = this.db.all(
      `SELECT k.id, k.dataset, k.title, k.chunk, k.source, k.content, bm25(knowledge_fts) AS score
       FROM knowledge_fts JOIN knowledge k ON k.id = knowledge_fts.chunk_id
       WHERE knowledge_fts MATCH ? ${opts.dataset ? "AND knowledge_fts.dataset = ?" : ""}
       ORDER BY score LIMIT ?`,
      ...(opts.dataset ? [ftsQuery(query), opts.dataset, topK] : [ftsQuery(query), topK]),
    );
    return rows;
  }
}
