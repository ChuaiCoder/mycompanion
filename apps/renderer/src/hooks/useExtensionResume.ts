import { useEffect } from "react";

export type WorkspaceView = "library" | "chat" | "plugins" | "settings";

export interface ExtensionResumeState {
  view?: WorkspaceView | undefined;
  conversationId?: string | undefined;
  characterId?: string | undefined;
  input?: string | undefined;
}

const RESUME_STORAGE_KEY = "mycompanion.extension-resume";

// 读取扩展刷新前暂存的界面状态（sessionStorage），格式非法时按空处理。
export function readExtensionResume(): ExtensionResumeState {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RESUME_STORAGE_KEY) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    return {
      view: ["library", "chat", "plugins", "settings"].includes(saved.view) ? saved.view : undefined,
      characterId: typeof saved.characterId === "string" ? saved.characterId : undefined,
      conversationId: typeof saved.conversationId === "string" ? saved.conversationId : undefined,
      input: typeof saved.input === "string" ? saved.input : undefined,
    };
  } catch { return {}; }
}

// 扩展启用/停用/卸载后需要整页刷新，刷新前暂存当前界面状态。
export function persistExtensionResume(state: ExtensionResumeState): void {
  sessionStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(state));
}

// 挂载时消费一次暂存状态（避免二次恢复），并在 pagehide 时持久化当前选择。
export function useExtensionResume(deps: {
  workspaceView: WorkspaceView;
  conversationId: string | undefined;
  characterId: string | undefined;
  chatInput: string;
}): void {
  const { workspaceView, conversationId, characterId, chatInput } = deps;

  useEffect(() => {
    sessionStorage.removeItem(RESUME_STORAGE_KEY);
  }, []);

  useEffect(() => {
    const preserveSelection = () => {
      persistExtensionResume({
        view: workspaceView, conversationId, characterId, input: chatInput,
      });
    };
    window.addEventListener("pagehide", preserveSelection);
    return () => window.removeEventListener("pagehide", preserveSelection);
  }, [workspaceView, conversationId, characterId, chatInput]);
}
