import { randomUUID } from "node:crypto";
import type { CharacterDetail, ExtensionChatMessage } from "@mycompanion/shared";
import { collectNativeRegexScripts, TavernRegexExecutor } from "./tavern-regex-service.js";

/** Builds an unsaved greeting with the same output-rule engine as generation. */
export async function buildCharacterGreeting(character: CharacterDetail, settings: Record<string, unknown> = {},
  options: { transform?: (text: string) => Promise<string> } = {}): Promise<ExtensionChatMessage> {
  const executor = options.transform ? undefined : new TavernRegexExecutor();
  const scripts = collectNativeRegexScripts(settings, character);
  const transform = options.transform ?? ((text: string) => executor!.run(text, 2, scripts, character.name));
  try {
  const mes = await transform(character.firstMessage);
  const message: ExtensionChatMessage = { id: randomUUID(), name: character.name, is_user: false, is_system: false,
    send_date: new Date().toISOString(), mes, extra: {} };
  if (character.alternateGreetings.length) {
    const swipes = [mes];
    for (const greeting of character.alternateGreetings) swipes.push(await transform(greeting));
    if (!mes) swipes.shift();
    message.mes = swipes[0] ?? "";
    message.swipe_id = 0; message.swipes = swipes;
    message.swipe_info = swipes.map(() => ({ send_date: message.send_date, extra: {} }));
  }
  return message;
  } finally { executor?.close(); }
}
