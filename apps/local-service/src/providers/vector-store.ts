import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, validVector, MAX_VECTOR_DIMENSIONS } from "./embedding-client.js";

function decodeVector(row: { dimensions: number; vector: Uint8Array }): number[] | undefined {
  if (!Number.isInteger(row.dimensions) || row.dimensions<1 || row.dimensions>MAX_VECTOR_DIMENSIONS
    || !(row.vector instanceof Uint8Array) || row.vector.byteLength !== row.dimensions * 8) return undefined;
  const bytes = Buffer.from(row.vector);
  const vector = Array.from({length:row.dimensions},(_,index)=>bytes.readDoubleLE(index*8));
  return validVector(vector) ? vector : undefined;
}

/** Derived, rebuildable cache. Source facts and branch reachability stay in the runtime repository. */
export class VectorStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS embedding_vectors (
      namespace TEXT NOT NULL, signature TEXT NOT NULL, entity_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(namespace,signature,entity_id)
    );`);
  }
  get(namespace: string, signature: string, id: string, fingerprint: string): number[] | undefined {
    const row = this.database.prepare("SELECT dimensions,vector FROM embedding_vectors WHERE namespace=? AND signature=? AND entity_id=? AND fingerprint=?")
      .get(namespace,signature,id,fingerprint) as {dimensions:number;vector:Uint8Array}|undefined;
    return row ? decodeVector(row) : undefined;
  }
  put(namespace: string, signature: string, id: string, fingerprint: string, vector: number[]): void {
    if (!validVector(vector)) throw new Error("Invalid embedding vector");
    const bytes = Buffer.alloc(vector.length*8);
    vector.forEach((value,index)=>bytes.writeDoubleLE(value,index*8));
    this.database.prepare(`INSERT INTO embedding_vectors(namespace,signature,entity_id,fingerprint,dimensions,vector) VALUES(?,?,?,?,?,?)
      ON CONFLICT(namespace,signature,entity_id) DO UPDATE SET fingerprint=excluded.fingerprint, dimensions=excluded.dimensions,vector=excluded.vector`)
      .run(namespace,signature,id,fingerprint,vector.length,bytes);
  }
  remove(namespace: string, signature: string, ids?: string[]): void {
    if (ids) {
      const statement = this.database.prepare("DELETE FROM embedding_vectors WHERE namespace=? AND signature=? AND entity_id=?");
      for (const id of ids) statement.run(namespace,signature,id);
    } else this.database.prepare("DELETE FROM embedding_vectors WHERE namespace=? AND signature=?").run(namespace,signature);
  }
  query(namespace: string, signature: string, query: number[], candidates: Array<{id:string;fingerprint:string}>, topK:number, threshold:number): Array<{id:string;score:number}> {
    if (!candidates.length) return [];
    const fingerprints = new Map(candidates.map(item => [item.id, item.fingerprint]));
    const results: Array<{id:string;score:number}> = [];
    // 批量取候选向量，避免每个候选一次 SELECT（N+1）；分块防止超出 SQLite 变量上限。
    for (let offset = 0; offset < candidates.length; offset += 500) {
      const chunk = candidates.slice(offset, offset + 500);
      const rows = this.database.prepare(
        `SELECT entity_id,fingerprint,dimensions,vector FROM embedding_vectors WHERE namespace=? AND signature=? AND entity_id IN (${chunk.map(() => "?").join(",")})`,
      ).all(namespace, signature, ...chunk.map(item => item.id)) as Array<{entity_id:string;fingerprint:string;dimensions:number;vector:Uint8Array}>;
      for (const row of rows) {
        // 指纹不一致 = 向量已过期，与 get() 的语义一致（过期即不存在）。
        if (row.fingerprint !== fingerprints.get(row.entity_id)) continue;
        const vector = decodeVector(row);
        if (!vector || vector.length!==query.length) continue;
        const score = cosineSimilarity(query,vector);
        if (score>=threshold) results.push({id:row.entity_id,score});
      }
    }
    return results.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).slice(0,Math.max(0,Math.floor(topK)));
  }
}
