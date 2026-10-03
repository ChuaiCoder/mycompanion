import type {
  CharacterRegexRule,
  RegexTestResponse,
} from "@mycompanion/shared";

import { readApiPayload } from "./core";

// 正则规则（FR-REGEX-001/007）：读取、启用/停用、测试器。
export async function listRegexRules(id: string): Promise<CharacterRegexRule[]> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}/regex`, {
    headers: { Accept: "application/json" },
  });
  const payload = (await readApiPayload(response)) as { rules: CharacterRegexRule[] };
  return payload.rules;
}

export async function setRegexRuleState(
  id: string,
  order: number,
  enabled: boolean,
): Promise<CharacterRegexRule[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/regex/${order}`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  const rules = await readApiPayload(response) as CharacterRegexRule[];
  window.dispatchEvent(new CustomEvent('mycompanion:regex-rules', { detail: { id, enabled } }));
  return rules;
}

export async function setAllRegexRulesState(
  id: string,
  enabled: boolean,
): Promise<CharacterRegexRule[]> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/regex/all`,
    {
      method: "PUT",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  const rules = await readApiPayload(response) as CharacterRegexRule[];
  window.dispatchEvent(new CustomEvent('mycompanion:regex-rules', { detail: { id, enabled } }));
  return rules;
}

export async function testCharacterRegex(
  id: string,
  input: string,
): Promise<RegexTestResponse> {
  const response = await fetch(
    `/api/characters/${encodeURIComponent(id)}/regex/test`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    },
  );
  return readApiPayload(response) as Promise<RegexTestResponse>;
}
