import { useEffect, useState } from "react";

import type { CharacterDetail, CharacterSummary } from "@mycompanion/shared";

import { ApiRequestError, fetchCharacter, listCharacters } from "../api";
import type { WorkspaceView } from "./useExtensionResume";

// 角色列表与选中角色：含初始加载、刷新恢复和选中时的防竞态（navigationRevision）。
export function useCharacterSelection(deps: {
  navigationRevision: { current: number };
  resumeCharacterId: string | undefined;
  setWorkspaceView: (view: WorkspaceView) => void;
  closeCharacterPanels: () => void;
  clearImportState: () => void;
  setSuccessMessage: (message: string | null) => void;
}) {
  const {
    navigationRevision,
    resumeCharacterId,
    setWorkspaceView,
    closeCharacterPanels,
    clearImportState,
    setSuccessMessage,
  } = deps;
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterDetail | null>(null);
  const [isLoadingCharacter, setIsLoadingCharacter] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const revision = navigationRevision.current;
    const current = () => !controller.signal.aborted && revision === navigationRevision.current;
    if (resumeCharacterId) {
      void fetchCharacter(resumeCharacterId, controller.signal)
        .then(character => { if (current()) setSelectedCharacter(character); })
        .catch(error => { if (current() && error?.name !== "AbortError") setListError("无法恢复之前的角色。"); });
    }

    void listCharacters(controller.signal)
      .then((result) => setCharacters(result.items))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setListError("暂时无法读取角色列表。");
      });

    return () => controller.abort();
    // 仅在挂载时执行一次：resumeCharacterId 来自挂载快照。
  }, []);

  const handleSelectCharacter = async (id: string): Promise<void> => {
    const revision = ++navigationRevision.current;
    setIsLoadingCharacter(true);
    setListError(null);
    setSuccessMessage(null);
    try {
      const character = await fetchCharacter(id);
      if (revision !== navigationRevision.current) return;
      setSelectedCharacter(character);
      closeCharacterPanels();
      setWorkspaceView("library");
      clearImportState();
    } catch (error) {
      if (revision !== navigationRevision.current) return;
      setListError(
        error instanceof ApiRequestError ? error.message : "暂时无法读取角色详情。",
      );
    } finally {
      setIsLoadingCharacter(false);
    }
  };

  return {
    characters,
    setCharacters,
    selectedCharacter,
    setSelectedCharacter,
    isLoadingCharacter,
    listError,
    setListError,
    handleSelectCharacter,
  };
}
