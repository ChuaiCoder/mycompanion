import type { DatabaseSync } from "node:sqlite";
import { EMBEDDING_BATCH_SIZE, embedTexts, embeddingSignature, vectorContentFingerprint } from "./embedding-client.js";
import type { EmbeddingSelection } from "./semantic-memory.js";
import type { VectorStore } from "./vector-store.js";

export interface VectorItem { hash: number; text: string; index: string | number }
export interface VectorMatch { item: { metadata: VectorItem }; score: number }
const namespace = (collectionId: string) => `vector:${collectionId}`;
export class VectorCollectionChangedError extends Error { constructor(){super("向量集合在索引期间发生变化，请重试。");} }

/** Extension-managed collections contain rebuildable raw metadata, never memory
 * facts. Generation still selects its current books before authorizing a scan. */
export class VectorCollectionRepository {
  private readonly revisions = new Map<string, number>();
  constructor(private readonly database: DatabaseSync, private readonly vectors: VectorStore) {
    database.exec(`CREATE TABLE IF NOT EXISTS vector_collection_items (
      collection_id TEXT NOT NULL, signature TEXT NOT NULL, hash REAL NOT NULL, text TEXT NOT NULL, item_index TEXT NOT NULL,
      PRIMARY KEY(collection_id,signature,hash)
    )`);
  }
  revision(collectionId: string, signature: string): number { return this.revisions.get(JSON.stringify([collectionId, signature])) ?? 0; }
  private changed(collectionId: string, signature: string): void {
    const key=JSON.stringify([collectionId,signature]);this.revisions.set(key,this.revision(collectionId,signature)+1);
  }
  items(collectionId: string, signature: string): VectorItem[] {
    return (this.database.prepare("SELECT hash,text,item_index FROM vector_collection_items WHERE collection_id=? AND signature=? ORDER BY rowid")
      .all(collectionId,signature) as Array<{hash:number;text:string;item_index:string}>).map(row=>({hash:row.hash,text:row.text,index:JSON.parse(row.item_index)}));
  }
  list(collectionId: string, signature: string): number[] {
    return this.items(collectionId,signature).filter(item=>this.vectors.get(namespace(collectionId),signature,String(item.hash),vectorContentFingerprint(item.text))).map(item=>item.hash);
  }
  put(collectionId: string, signature: string, items: VectorItem[], vectors: number[][], before = this.revision(collectionId,signature)): boolean {
    if (this.revision(collectionId,signature)!==before) return false;
    this.database.exec("SAVEPOINT vector_collection_insert");
    try {
      const statement=this.database.prepare(`INSERT INTO vector_collection_items(collection_id,signature,hash,text,item_index) VALUES(?,?,?,?,?)
        ON CONFLICT(collection_id,signature,hash) DO UPDATE SET text=excluded.text,item_index=excluded.item_index`);
      items.forEach((item,index)=>{
        this.vectors.put(namespace(collectionId),signature,String(item.hash),vectorContentFingerprint(item.text),vectors[index]!);
        statement.run(collectionId,signature,item.hash,item.text,JSON.stringify(item.index));
      });
      this.database.exec("RELEASE vector_collection_insert");this.changed(collectionId,signature);return true;
    } catch(error) {this.database.exec("ROLLBACK TO vector_collection_insert; RELEASE vector_collection_insert");throw error;}
  }
  remove(collectionId: string, signature: string, hashes?: number[]): void {
    if(hashes){const statement=this.database.prepare("DELETE FROM vector_collection_items WHERE collection_id=? AND signature=? AND hash=?");
      for(const hash of hashes)statement.run(collectionId,signature,hash);this.vectors.remove(namespace(collectionId),signature,hashes.map(String));
    }else{this.database.prepare("DELETE FROM vector_collection_items WHERE collection_id=? AND signature=?").run(collectionId,signature);this.vectors.remove(namespace(collectionId),signature);}
    this.changed(collectionId,signature);
  }
  purge(collectionId?: string): void {
    const pairs=this.database.prepare(collectionId===undefined?"SELECT DISTINCT collection_id,signature FROM vector_collection_items":"SELECT DISTINCT collection_id,signature FROM vector_collection_items WHERE collection_id=?")
      .all(...(collectionId===undefined?[]:[collectionId])) as Array<{collection_id:string;signature:string}>;
    for(const pair of pairs)this.remove(pair.collection_id,pair.signature);
    // Also invalidate a cold in-flight insertion that has not written a row.
    for(const key of this.revisions.keys()){const [id,signature]=JSON.parse(key);if(collectionId===undefined||id===collectionId)this.changed(id,signature);}
  }
  begin(collectionId: string, signature: string): number {
    const value=this.revision(collectionId,signature);this.revisions.set(JSON.stringify([collectionId,signature]),value);return value;
  }
  query(collectionId: string, signature: string, vector: number[], topK: number): VectorMatch[] {
    const items=this.items(collectionId,signature),byHash=new Map(items.map(item=>[String(item.hash),item]));
    return this.vectors.query(namespace(collectionId),signature,vector,items.map(item=>({id:String(item.hash),fingerprint:vectorContentFingerprint(item.text)})),topK,-1)
      .map(match=>({item:{metadata:byHash.get(match.id)!},score:match.score}));
  }
}

/** One immutable model/credential snapshot owns every batch and query. */
export class VectorCollectionSession {
  readonly signature: string;
  constructor(private readonly collections: VectorCollectionRepository, readonly selection: EmbeddingSelection,
    private readonly signal: AbortSignal, private readonly embed: typeof embedTexts = embedTexts) {
    this.signature=embeddingSignature(selection.settings,selection.profileId);
  }
  list(id: string): number[] {this.signal.throwIfAborted();return this.collections.list(id,this.signature);}
  remove(id: string, hashes: number[]): void {this.signal.throwIfAborted();this.collections.remove(id,this.signature,hashes);}
  async insert(id: string, items: VectorItem[]): Promise<void> {
    this.signal.throwIfAborted();if(!items.length)return;
    const before=this.collections.begin(id,this.signature),vectors:number[][]=[];
    for(let index=0;index<items.length;index+=EMBEDDING_BATCH_SIZE){
      vectors.push(...await this.embed(this.selection.settings,items.slice(index,index+EMBEDDING_BATCH_SIZE).map(item=>item.text),{apiKey:this.selection.apiKey,signal:this.signal}));
    }
    this.signal.throwIfAborted();
    if(!this.collections.put(id,this.signature,items,vectors,before))throw new VectorCollectionChangedError();
  }
  async getVector(text: string): Promise<number[]> {
    const [vector]=await this.embed(this.selection.settings,[text],{apiKey:this.selection.apiKey,signal:this.signal});this.signal.throwIfAborted();return vector!;
  }
  getIndex(id: string): { queryItems: (vector:number[],topK:number)=>Promise<VectorMatch[]> } {
    return {queryItems:async(vector,topK)=>{this.signal.throwIfAborted();return this.collections.query(id,this.signature,vector,topK);}};
  }
}
