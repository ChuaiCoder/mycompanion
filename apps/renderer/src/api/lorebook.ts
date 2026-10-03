import type {
  CharacterLorebookEntry,
  LorebookReport,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

// 世界书条目（FR-LORE-001/002）：读取、启用/停用、测试器。
export async function listLorebookEntries(id: string): Promise<CharacterLorebookEntry[]> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/lorebook`, {
    headers: { Accept: "application/json" },
  });
  const payload = (await readApiPayload(response)) as { entries: CharacterLorebookEntry[] };
  return payload.entries;
}

export async function setLorebookEntryState(
  id: string,
  index: number,
  enabled: boolean,
): Promise<CharacterLorebookEntry[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/lorebook/${index}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return readApiPayload(response) as Promise<CharacterLorebookEntry[]>;
}

export async function setAllLorebookEntriesState(
  id: string,
  enabled: boolean,
): Promise<CharacterLorebookEntry[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/lorebook/all`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return readApiPayload(response) as Promise<CharacterLorebookEntry[]>;
}

export async function testCharacterLorebook(
  id: string,
  input: string,
): Promise<LorebookReport> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/lorebook/test`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  return readApiPayload(response) as Promise<LorebookReport>;
}
