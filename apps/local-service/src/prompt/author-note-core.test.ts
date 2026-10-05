import { expect, it } from "vitest";
import { buildAuthorNotePrompt } from "./author-note-core.js";

it("uses the Author's Note interval, defaults and placement", () => {
  const metadata = { note_prompt: "Remember the map", note_interval: 2, note_position: 1, note_depth: 3, note_role: 1 };
  const settings = { note: { allowWIScan: true } };
  expect(buildAuthorNotePrompt(metadata, settings, 2)).toEqual({ active: true, prompt: {
    key: "2_floating_prompt", value: "Remember the map", position: 1, depth: 3, role: 1, scan: true,
  } });
  expect(buildAuthorNotePrompt(metadata, settings, 1)).toEqual({ active: false, prompt: null });
  expect(buildAuthorNotePrompt({}, { note: { default: "Default note" } }, 1).prompt?.value).toBe("Default note");
  expect(buildAuthorNotePrompt({ note_interval: 0, note_prompt: "Hidden" }, {}, 10).prompt).toBeNull();
  expect(() => buildAuthorNotePrompt({ note_prompt: "Bad", note_depth: -1 }, {}, 1)).toThrow("设置无效");
});
