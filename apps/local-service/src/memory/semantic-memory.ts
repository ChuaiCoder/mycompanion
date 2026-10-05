import type { MemoryRecord, MemoryRetrievalReport } from "@mycompanion/shared";
import { EMBEDDING_BATCH_SIZE, embedTexts, embeddingSignature, vectorContentFingerprint, type EmbeddingProvider } from "./embedding-client.js";
import { retrieveMemories, type MemoryRetrievalInput } from "./memory-engine.js";
import type { VectorStore } from "./vector-store.js";

export const MEMORY_SIMILARITY_THRESHOLD = 0.4;
export interface EmbeddingSelection { profileId: string; settings: EmbeddingProvider; apiKey?: string | undefined }
export interface SemanticMemoryInput extends MemoryRetrievalInput {
  semanticQuery?: string | undefined;
  signal?: AbortSignal | undefined;
  dryRun?: boolean | undefined;
  /** undefined resolves now; null explicitly disables for this invocation. */
  embeddingSelection?: EmbeddingSelection | null | undefined;
  /** An assigned profile failed to decrypt/resolve; keep this separate from no assignment. */
  embeddingSelectionUnavailable?: boolean | undefined;
}
interface IndexJob { selection: EmbeddingSelection; items: Map<string,MemoryRecord>; inFlight: Map<string,string>; running?: Promise<void> | undefined }

/** A rebuildable cache never grants source visibility. Callers supply reachable
 * memories after applying story/character/user scope and branch version checks. */
export class SemanticMemoryRetriever {
  private readonly shutdown = new AbortController();
  private readonly jobs = new Map<string,IndexJob>();
  private readonly failedIndexes = new Set<string>();
  constructor(private readonly store: VectorStore,
    private readonly resolve: () => EmbeddingSelection | undefined,
    private readonly current: (id: string) => MemoryRecord | undefined,
    private readonly embed: typeof embedTexts = embedTexts) {}

  stop(): void { this.shutdown.abort(); }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.jobs.values()].flatMap(job=>job.running ? [job.running] : []));
  }
  /** Useful for diagnostics/tests; the chat path does not wait for cold indexing. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].flatMap(job=>job.running ? [job.running] : []));
  }
  private queue(selection: EmbeddingSelection, signature: string, memories: MemoryRecord[], dimensions?: number): void {
    if (this.shutdown.signal.aborted) return;
    let job = this.jobs.get(signature);
    for (const memory of memories) {
      const fingerprint = vectorContentFingerprint(memory.content);
      const vector = this.store.get("memory",signature,memory.id,fingerprint);
      if ((!vector || (dimensions!==undefined && vector.length!==dimensions)) && job?.inFlight.get(memory.id)!==fingerprint) {
        if (!job) { job = {selection,items:new Map(),inFlight:new Map()}; this.jobs.set(signature,job); }
        job.items.set(memory.id,structuredClone(memory));
      }
    }
    if (!job || job.running || !job.items.size) return;
    this.failedIndexes.delete(signature);
    const currentJob = job;
    currentJob.running = (async () => {
      try {
        while (currentJob.items.size && !this.shutdown.signal.aborted) {
          const batch = [...currentJob.items.values()].slice(0,EMBEDDING_BATCH_SIZE);
          batch.forEach(item=>{currentJob.items.delete(item.id);currentJob.inFlight.set(item.id,vectorContentFingerprint(item.content));});
          const vectors = await this.embed(currentJob.selection.settings,batch.map(item=>item.content),
            {apiKey:currentJob.selection.apiKey,signal:this.shutdown.signal});
          this.shutdown.signal.throwIfAborted();
          // A different model endpoint, edited/deleted fact or inactive branch
          // after the request must not authorize a late cache write.
          const resolved = this.resolve();
          if (!resolved || embeddingSignature(resolved.settings,resolved.profileId)!==signature) { currentJob.items.clear(); break; }
          batch.forEach((item,index)=>{
            const latest = this.current(item.id);
            if (latest?.status === "active" && latest.content === item.content && !latest.pinned)
              this.store.put("memory",signature,item.id,vectorContentFingerprint(item.content),vectors[index]!);
            currentJob.inFlight.delete(item.id);
          });
        }
      } catch { if (!this.shutdown.signal.aborted) this.failedIndexes.add(signature); currentJob.items.clear(); }
      finally { currentJob.running = undefined; this.jobs.delete(signature); }
    })();
  }

  async retrieve(input: SemanticMemoryInput): Promise<MemoryRetrievalReport> {
    const started = Date.now();
    input.signal?.throwIfAborted();
    const diagnostic = (message:string, model?:string, indexed=0, pending=0, scores?:ReadonlyMap<string,number>): MemoryRetrievalReport => {
      const report = retrieveMemories({...input,...(scores ? {semanticScores:scores} : {})});
      report.retrieval = {mode:scores ? "hybrid" : "keyword",...(model ? {embeddingModel:model} : {}),indexedCount:indexed,pendingCount:pending,
        threshold:MEMORY_SIMILARITY_THRESHOLD,diagnostics:[message]};
      report.durationMs = Date.now()-started;
      return report;
    };
    if (input.embeddingSelectionUnavailable) return diagnostic("Embedding 配置或凭据不可用，已使用关键词检索。");
    let selection: EmbeddingSelection | undefined;
    try { selection = input.embeddingSelection===undefined ? this.resolve() : input.embeddingSelection ?? undefined; }
    catch { return diagnostic("Embedding 配置或凭据不可用，已使用关键词检索。"); }
    if (!selection) return diagnostic("未指定 Embedding 模型，已使用关键词检索。");
    const active = input.memories.filter(memory=>memory.status==="active" && !memory.pinned);
    if (!active.length || !(input.semanticQuery ?? input.scanText).trim()) return diagnostic("没有待检索的普通记忆；固定记忆使用独立预算。",selection.settings.model);
    let signature: string;
    try { signature = embeddingSignature(selection.settings,selection.profileId); }
    catch { return diagnostic("当前提供商不支持 Embedding，已使用关键词检索。",selection.settings.model); }
    const candidates = active.map(memory=>({id:memory.id,fingerprint:vectorContentFingerprint(memory.content)}));
    let indexed = candidates.filter(item=>this.store.get("memory",signature,item.id,item.fingerprint)).length;
    const failedIndex = this.failedIndexes.has(signature);
    if (!input.dryRun) this.queue(selection,signature,active);
    if (!indexed) return diagnostic(failedIndex ? input.dryRun ? "Embedding 索引失败；本次预览使用关键词且不写入索引。" : "Embedding 索引失败，正在重试；本轮使用关键词检索。"
      : input.dryRun ? "语义索引尚未建立；本次预览使用关键词且不写入索引。" : "正在建立语义索引，本轮使用关键词检索。",selection.settings.model,0,active.length);
    const signal = AbortSignal.any([this.shutdown.signal,...(input.signal ? [input.signal] : [])]);
    try {
      // Use the latest question/context, not an unbounded complete transcript.
      // Embedding truncation is explicit; keyword recall still sees scanText.
      const queryText = (input.semanticQuery ?? input.scanText).slice(-8_000);
      const [query] = await this.embed(selection.settings,[queryText],{apiKey:selection.apiKey,signal});
      signal.throwIfAborted();
      const valid = candidates.filter(item=>this.store.get("memory",signature,item.id,item.fingerprint)?.length===query!.length);
      indexed = valid.length;
      if (!input.dryRun) this.queue(selection,signature,active,query!.length);
      const matches = this.store.query("memory",signature,query!,valid,active.length,MEMORY_SIMILARITY_THRESHOLD);
      return diagnostic(`关键词与语义联合检索；${indexed}/${active.length} 条普通记忆已索引${(input.semanticQuery ?? input.scanText).length>8_000 ? "；语义查询使用末尾 8,000 字符" : ""}。`,
        selection.settings.model,indexed,active.length-indexed,new Map(matches.map(item=>[item.id,item.score])));
    } catch {
      signal.throwIfAborted();
      return diagnostic("Embedding 请求失败，本轮已降级为关键词检索。",selection.settings.model,indexed,active.length-indexed);
    }
  }
}
