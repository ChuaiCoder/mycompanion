import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { apps, commitCard, fullV2Card, waitFor } from "../testing/helpers.js";

afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

async function story() {
  const app = buildApp();
  apps.push(app);
  const character = await commitCard(app, fullV2Card);
  const created = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } });
  expect(created.statusCode, created.body).toBe(201);
  // 建会话时开场白已作为第一条消息落库，无需调用模型即可得到一个非空故事。
  const conversation = created.json();
  return { app, character, conversation };
}

const list = async (app: ReturnType<typeof buildApp>) => (await app.inject({ method: "GET", url: "/api/conversations" })).json();

describe("POST /api/conversations/delete-batch (批量软删除)", () => {
  /** 建两个故事，返回它们的 id。 */
  async function twoStories(app: ReturnType<typeof buildApp>, characterId: string) {
    const first = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId } });
    const second = await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId } });
    return [first.json().id as string, second.json().id as string];
  }

  it("deletes the whole selection in one request and hides all of them", async () => {
    const { app, character } = await story();
    const [first, second] = await twoStories(app, character.id);

    const deleted = await app.inject({ method: "POST", url: "/api/conversations/delete-batch", payload: { ids: [first, second] } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const body = deleted.json();
    expect(body.deleted.map((item: { id: string }) => item.id).sort()).toEqual([first, second].sort());
    expect(body.skipped).toEqual([]);
    // 同一批用同一个时间戳，便于把它们视作同一次操作。
    expect(new Set(body.deleted.map((item: { deletedAt: string }) => item.deletedAt)).size).toBe(1);
    expect((await list(app)).items.map((item: { id: string }) => item.id)).not.toContain(first);
    expect((await list(app)).items.map((item: { id: string }) => item.id)).not.toContain(second);
    // 仍然是软删除：内容保留，可逐个恢复。
    const restored = await app.inject({ method: "POST", url: `/api/conversations/${first}/restore` });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().messages.length).toBeGreaterThan(0);
  });

  it("reports already-deleted and unknown ids as skipped instead of claiming success", async () => {
    const { app, character } = await story();
    const [first, second] = await twoStories(app, character.id);
    // 先单独删掉一个，再把它和另一个、以及一个不存在的 id 一起提交。
    await app.inject({ method: "DELETE", url: `/api/conversations/${first}` });
    const unknown = "99999999-9999-4999-8999-999999999999";

    const body = (await app.inject({
      method: "POST", url: "/api/conversations/delete-batch", payload: { ids: [first, second, unknown] },
    })).json();
    expect(body.deleted.map((item: { id: string }) => item.id)).toEqual([second]);
    expect(body.skipped.sort()).toEqual([first, unknown].sort());
  });

  it("treats a repeated id as one deletion", async () => {
    const { app, character } = await story();
    const [first] = await twoStories(app, character.id);
    const body = (await app.inject({
      method: "POST", url: "/api/conversations/delete-batch", payload: { ids: [first, first, first] },
    })).json();
    expect(body.deleted).toHaveLength(1);
    expect(body.skipped).toEqual([]);
  });

  it("rejects an empty or oversized selection", async () => {
    const { app } = await story();
    const empty = await app.inject({ method: "POST", url: "/api/conversations/delete-batch", payload: { ids: [] } });
    expect(empty.statusCode, empty.body).toBe(400);
    const tooMany = await app.inject({
      method: "POST", url: "/api/conversations/delete-batch",
      payload: { ids: Array.from({ length: 201 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`) },
    });
    expect(tooMany.statusCode, tooMany.body).toBe(400);
  });

  it("leaves nothing deleted when the whole batch is unknown", async () => {
    const { app, character } = await story();
    const [first] = await twoStories(app, character.id);
    const body = (await app.inject({
      method: "POST", url: "/api/conversations/delete-batch",
      payload: { ids: ["99999999-9999-4999-8999-999999999999"] },
    })).json();
    expect(body.deleted).toEqual([]);
    // 没被牵连的故事必须还在。
    expect((await list(app)).items.map((item: { id: string }) => item.id)).toContain(first);
  });
});

describe("DELETE /api/conversations/:id (FR-DATA-004 软删除)", () => {
  it("hides the story from the list and detail while keeping every message for recovery", async () => {
    const { app, conversation } = await story();
    const before = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` });
    const messagesBefore = before.json().messages.length;

    const deleted = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().id).toBe(conversation.id);
    expect(Number.isNaN(Date.parse(deleted.json().deletedAt))).toBe(false);

    // 列表与详情都不再暴露已删除的故事。
    expect((await list(app)).items.map((item: { id: string }) => item.id)).not.toContain(conversation.id);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);
    // 但底层数据没有被删：恢复后消息一条不少。
    const restored = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/restore` });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().messages).toHaveLength(messagesBefore);
    expect((await list(app)).items.map((item: { id: string }) => item.id)).toContain(conversation.id);
  });

  it("is idempotent and reports a stable deletion time on a repeated delete", async () => {
    const { app, conversation } = await story();
    const first = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    const second = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().deletedAt).toBe(first.json().deletedAt);
  });

  it("distinguishes a missing story from one that is merely not deleted", async () => {
    const { app, conversation } = await story();
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${"0".repeat(8)}-0000-4000-8000-000000000000` })).statusCode).toBe(404);
    // 未删除就调用恢复：明确冲突，而不是假装成功。
    const notDeleted = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/restore` });
    expect(notDeleted.statusCode, notDeleted.body).toBe(409);
    expect(notDeleted.json().error.code).toBe("CONVERSATION_NOT_DELETED");
  });

  it("keeps a deleted story out of the model context of a sibling story", async () => {
    const { app, character, conversation } = await story();
    // 同角色的第二条故事继续存在，不应受到兄弟故事删除的影响。
    const sibling = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
    await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    const remaining = await list(app);
    expect(remaining.items.map((item: { id: string }) => item.id)).toEqual([sibling.id]);
    const detail = await app.inject({ method: "GET", url: `/api/conversations/${sibling.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages.length).toBeGreaterThan(0);
  });

  it("aborts an in-flight generation so the deleted story stops receiving output", async () => {
    // 以前删除只做软删除，不取消在途生成：模型会继续跑完并把消息写进已删故事。
    const { app, conversation } = await story();
    let modelSignal: AbortSignal | undefined;
    let releaseStream: (() => void) | undefined;
    // 把模型请求挂住，等删除发生后再看它是否被取消。
    const held = new Promise<void>(resolve => { releaseStream = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init?: RequestInit) => {
      modelSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"写"}}]}\n\n'));
          // 一直不结束，直到删除把它取消。
          await held;
          try { controller.close(); } catch { /* 已被取消 */ }
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));

    const sending = app.inject({
      method: "POST", url: `/api/conversations/${conversation.id}/messages`, payload: { content: "继续" },
    });
    // 等生成真的注册进 inFlightGenerations（否则删除时可能还没挂上）。
    await waitFor(async () => (modelSignal ? true : undefined));

    const deleted = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    expect(deleted.statusCode, deleted.body).toBe(200);
    // 关键：删除必须取消该故事的模型请求。
    expect(modelSignal?.aborted).toBe(true);

    releaseStream?.();
    await sending.catch(() => undefined);
    vi.unstubAllGlobals();
    // 已删故事不再出现在列表里。
    const remaining = await list(app);
    expect(remaining.items.map((item: { id: string }) => item.id)).not.toContain(conversation.id);
  });

  it("survives a service restart with the deletion intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mycompanion-conversation-delete-"));
    const databasePath = join(directory, "profile.sqlite");
    const reopenedApps: Array<ReturnType<typeof buildApp>> = [];
    try {
      const app = buildApp({ databasePath });
      const character = await commitCard(app, fullV2Card);
      const conversation = (await app.inject({ method: "POST", url: "/api/conversations", payload: { characterId: character.id } })).json();
      await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
      await app.close();

      const reopened = buildApp({ databasePath });
      reopenedApps.push(reopened);
      expect((await list(reopened)).items).toHaveLength(0);
      expect((await reopened.inject({ method: "GET", url: `/api/conversations/${conversation.id}` })).statusCode).toBe(404);
      expect((await reopened.inject({ method: "POST", url: `/api/conversations/${conversation.id}/restore` })).statusCode).toBe(200);
    } finally {
      // 先关库再删目录，否则 Windows 上文件仍被占用会 EPERM。
      for (const app of reopenedApps.splice(0)) await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
