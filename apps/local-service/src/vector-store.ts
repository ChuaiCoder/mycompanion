import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, validVector, MAX_VECTOR_DIMENSIONS } from "./embedding-client.js";

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
    if (!row || !Number.isInteger(row.dimensions) || row.dimensions<1 || row.dimensions>MAX_VECTOR_DIMENSIONS
      || !(row.vector instanceof Uint8Array) || row.vector.byteLength !== row.dimensions * 8) return undefined;
    const bytes = Buffer.from(row.vector);
    const vector = Array.from({length:row.dimensions},(_,index)=>bytes.readDoubleLE(index*8));
    return validVector(vector) ? vector : undefined;
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
    const results: Array<{id:string;score:number}> = [];
    for (const item of candidates) {
      const vector = this.get(namespace,signature,item.id,item.fingerprint);
      if (!vector || vector.length!==query.length) continue;
      const score = cosineSimilarity(query,vector);
      if (score>=threshold) results.push({id:item.id,score});
    }
    return results.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).slice(0,Math.max(0,Math.floor(topK)));
  }
}
