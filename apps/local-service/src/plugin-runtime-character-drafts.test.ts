import { afterEach, expect, it, vi } from "vitest";
import { mergeJsonChanges } from "@mycompanion/shared";
import { characterEditorSource } from "./plugin-runtime-character-editor.js";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
function form() {
  const element = document.createElement("form");
  const names = ["avatar_url", "json_data", "ch_name", "description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions", "creator_notes", "creator", "character_version", "tags", "world", "chat", "create_date", "depth_prompt_prompt", "depth_prompt_depth", "depth_prompt_role"];
  element.innerHTML = `<p data-character-status></p><p data-character-error></p><fieldset>${names.map(name => `<input name="${name}">`).join("")}<input name="avatar" type="file"><button data-crop-avatar></button><select class="character_world_info_selector"></select><button class="open_alternate_greetings"></button><div id="alternate-greetings-list"></div><button data-add-greeting></button><img id="avatar_load_preview"></fieldset>`;
  document.body.append(element);
  Object.defineProperty(element.elements.namedItem("avatar"), "files", { configurable: true, writable: true, value: [] });
  const upload = element.elements.namedItem("avatar") as HTMLInputElement;
  const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  Object.defineProperty(upload, "value", { configurable: true, get() { return value.get!.call(this); }, set(next) { value.set!.call(this, next); if (next === "") Object.defineProperty(this, "files", { configurable: true, writable: true, value: [] }); } });
  return element;
}
function character(avatar = "A.png") { return { avatar, chat: "chat", create_date: "date", json_data: "{}", data: { name: avatar, description: "saved", personality: "", scenario: "", first_mes: "", mes_example: "", system_prompt: "", post_history_instructions: "", creator_notes: "", creator: "", character_version: "", tags: [], alternate_greetings: [], extensions: {} } }; }
function runtime(settings: Record<string, unknown>, selected: { characters: ReturnType<typeof character>[]; characterId: number }) {
  const saves = vi.fn();
  const jquery = (element: HTMLElement) => {
    const chain = { on: (events: string, callback: EventListener) => { for (const name of events.split(" ")) element.addEventListener(name.split(".")[0]!, callback); return chain; }, off: vi.fn(), data: vi.fn() }; return chain;
  };
  class Transfers { files: File[] = []; items = { add: (file: File) => this.files.push(file) }; }
  vi.stubGlobal("DataTransfer", Transfers);
  const OriginalFormData = FormData;
  class TestFormData extends OriginalFormData {
    constructor(element?: HTMLFormElement) { super(element); const upload = element?.elements.namedItem("avatar") as HTMLInputElement | null;
      this.delete("avatar"); if (upload?.files?.[0]) this.append("avatar", upload.files[0]); }
  }
  const bindings = { getContext: () => selected, subscribeHostContext: () => () => {}, eventSource: { emit: vi.fn() }, event_types: {},
    getOneCharacter: vi.fn(), getCharacters: vi.fn(), getPastCharacterChats: vi.fn(), forgetCharacter: vi.fn(), loadCharacterState: vi.fn(), mergeJsonChanges,
    flushChatSaves: vi.fn(), saveChatConditional: vi.fn(), clearChat: vi.fn(), printMessages: vi.fn(), world_names: [],
    lodash: { isEqual: isDeepStrictEqual }, toastr: {},
    extension_settings: settings, loadExtensionSettings: async () => {}, saveSettingsDebounced: saves, $: jquery, FormData: TestFormData };
  const source = characterEditorSource.replace(/^import .*;\r?\n/gm, "").replace(/\bexport (?=(?:async )?function)/g, "");
  const exports = new Function(...Object.keys(bindings), source + "\nreturn {attachCharacterEditor,flushCharacterSaves,syncCharacterEditor};")(...Object.values(bindings)) as {
    attachCharacterEditor(form: HTMLFormElement): () => void; flushCharacterSaves(): Promise<void>; syncCharacterEditor(): void;
  };
  return { ...exports, saves };
}
const input = (element: HTMLFormElement, name: string) => element.elements.namedItem(name) as HTMLInputElement;

it("edits a real depth prompt JSON path and restores all advanced draft controls while preserving unknown fields", async () => {
  const role = character(); Object.assign(role.data.extensions, { depth_prompt: { prompt: "saved note", depth: 4, role: "system", future: "keep" }, unrelated: { keep: true } });
  role.json_data = JSON.stringify({ data: role.data });
  const context = { characters: [role], characterId: 0 }, settings = {};
  const first = runtime(settings, context), editor = form(); first.attachCharacterEditor(editor); await first.flushCharacterSaves();
  for (const [name, value] of [["depth_prompt_prompt", "new note"], ["depth_prompt_depth", "2"], ["depth_prompt_role", "user"]]) {
    input(editor, name!).value = value!; input(editor, name!).dispatchEvent(new Event("input", { bubbles: true }));
  }
  await first.flushCharacterSaves();
  expect(JSON.parse(input(editor, "json_data").value).data.extensions).toMatchObject({ depth_prompt: { prompt: "new note", depth: 2, role: "user", future: "keep" }, unrelated: { keep: true } });
  document.body.replaceChildren(); const second = runtime(JSON.parse(JSON.stringify(settings)), context), restored = form(); second.attachCharacterEditor(restored); await second.flushCharacterSaves();
  expect(input(restored, "depth_prompt_prompt").value).toBe("new note"); expect(input(restored, "depth_prompt_depth").value).toBe("2"); expect(input(restored, "depth_prompt_role").value).toBe("user");
  expect(JSON.parse(role.json_data).data.extensions.depth_prompt.prompt).toBe("saved note");
});

it("persists role-specific unsaved text and PNG, restores them in a fresh runtime, and leaves character data unchanged", async () => {
  const settings = {}, context = { characters: [character(), character("B.png")], characterId: 0 };
  const first = runtime(settings, context), editor = form(); first.attachCharacterEditor(editor); await Promise.resolve(); await Promise.resolve();
  input(editor, "description").value = "A draft"; editor.dispatchEvent(new Event("input", { bubbles: true }));
  const png = new File([new Uint8Array([137, 80, 78, 71])], "new.png", { type: "image/png" });
  Object.defineProperty(input(editor, "avatar"), "files", { configurable: true, writable: true, value: [png] });
  context.characterId = 1; first.syncCharacterEditor(); input(editor, "description").value = "B draft";
  input(editor, "description").dispatchEvent(new Event("input", { bubbles: true })); await first.flushCharacterSaves();
  const durable = JSON.parse(JSON.stringify(settings)); expect(context.characters[0]!.data.description).toBe("saved");
  document.body.replaceChildren(); context.characterId = 0; const second = runtime(durable, context), restored = form(); second.attachCharacterEditor(restored);
  await second.flushCharacterSaves();
  expect(input(restored, "description").value).toBe("A draft"); expect(input(restored, "avatar").files![0]!.name).toBe("new.png");
  context.characterId = 1; second.syncCharacterEditor(); expect(input(restored, "description").value).toBe("B draft"); expect(input(restored, "avatar").files).toHaveLength(0);
  expect(context.characters[1]!.data.description).toBe("saved");
});

it("merges a recovered draft with remotely changed fields and removes it after the user restores saved values", async () => {
  const context = { characters: [character()], characterId: 0 }, settings = {};
  const first = runtime(settings, context), editor = form(); first.attachCharacterEditor(editor); await first.flushCharacterSaves();
  input(editor, "description").value = "draft"; input(editor, "description").dispatchEvent(new Event("input", { bubbles: true })); await first.flushCharacterSaves();
  context.characters[0]!.data.personality = "remote edit";
  document.body.replaceChildren(); const second = runtime(JSON.parse(JSON.stringify(settings)), context), restored = form(); second.attachCharacterEditor(restored); await second.flushCharacterSaves();
  expect(input(restored, "description").value).toBe("draft"); expect(input(restored, "personality").value).toBe("remote edit");
  input(restored, "description").value = "saved"; input(restored, "description").dispatchEvent(new Event("input", { bubbles: true })); await second.flushCharacterSaves();
  expect(restored.querySelector("[data-character-status]")?.textContent).toBe("已保存");
});
// @vitest-environment jsdom
import { isDeepStrictEqual } from "node:util";
