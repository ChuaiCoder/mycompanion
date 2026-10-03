import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlashFixture } from "./slash-runtime-fixture.js";

const cases = [
  '/array-wrap null', '/array-wrap stringify=false null', '/array-wrap stringify=false 42',
  '/list-wrap stringify=false false', '/array-wrap {"place":"tower"}', '/array-wrap [1,2]',
  '/array-wrap "quoted value"', '/array-wrap {: /pass untouched :}',
  '/array-unwrap [1,2]', '/list-unwrap [{"place":"tower"}]', '/array-unwrap []',
  '/array-unwrap [null]', '/array-unwrap [false]', '/array-unwrap not-json',
  '/array-unwrap {: /pass untouched :}',
  '/trimstart incomplete. Whole sentence!', '/trimstart partial\nFull sentence.',
  '/trimend Full sentence! unfinished', '/trimend 中文。未完成', '/trimend finished 🙂 partial',
  '/trimend no punctuation  ', '/stop', '/generate-stop', '/forcesave', '/chat-reload',
  '/tokens sample text', '/tokens {: /pass uncalled :}',
];

describe("original list/text and existing native slash command adapters", () => {
  it("preserves JSON primitive/list/alias and upstream sentence trimming behavior", async () => {
    const h = await createSlashFixture();
    try {
      const run = async (text: string) => (await h.api.executeSlashCommandsWithOptions(text,
        { handleParserErrors: false, handleExecutionErrors: false })).pipe;
      expect(await run(cases[0]!)).toBe('["null"]');
      expect(await run(cases[1]!)).toBe('[null]');
      expect(await run(cases[2]!)).toBe('[42]');
      expect(await run(cases[3]!)).toBe('[false]');
      expect(await run(cases[4]!)).toBe('[{"place":"tower"}]');
      expect(await run(cases[5]!)).toBe('[1,2]');
      expect(await run(cases[8]!)).toBe('1');
      expect(await run(cases[9]!)).toBe('{"place":"tower"}');
      expect(await run(cases[10]!)).toBe('');
      expect(await run(cases[11]!)).toBe('');
      expect(await run(cases[12]!)).toBe('false');
      // The fixed upstream callback passes the reason as the error's first
      // constructor argument (cause), leaving message empty. Closure adds its
      // own error wrapper, so the original reason is two causes deep.
      const reason = { message: '', cause: { message: '', cause: expect.stringMatching(/Closures are not supported/) } };
      await expect(run(cases[7]!)).rejects.toMatchObject(reason);
      await expect(run(cases[14]!)).rejects.toMatchObject(reason);
      expect(await run(cases[15]!)).toBe('Whole sentence!');
      expect(await run(cases[17]!)).toBe('Full sentence!');
      expect(await run(cases[18]!)).toBe('中文。');
      expect(await run(cases[19]!)).toBe('finished 🙂');
      expect(h.traces.filter(item => /Save|Reload|Stop|tokenCount/.test(item[0]))).toEqual([]);
    } finally { h.close(); }
  });
  it("dispatches the existing native adapters in order and propagates a failed save", async () => {
    let fail = true;
    const h = await createSlashFixture(undefined, undefined, { saveSettings: async () => { if (fail) throw new Error('Native save failed'); } });
    try {
      const run = (text: string) => h.api.executeSlashCommandsWithOptions(text,
        { handleParserErrors: false, handleExecutionErrors: false });
      h.context.nativeGenerating = true;
      expect((await run('/generate-stop')).pipe).toBe('true');
      expect((await run('/stop')).pipe).toBe('false');
      await expect(run('/forcesave')).rejects.toThrow(/Native save failed/);
      expect(h.traces.filter(item => /settingsSave|chatSave/.test(item[0]))).toEqual([["settingsSave"]]);
      fail = false;
      expect((await run('/forcesave')).pipe).toBe('');
      expect(h.traces.filter(item => /settingsSave|chatSave/.test(item[0]))).toEqual([["settingsSave"], ["settingsSave"], ["chatSave"]]);
      expect((await run('/chat-reload')).pipe).toBe('');
      expect(h.traces).toContainEqual(["chatReload", "story-a"]);
      expect((await run('/tokens sample text')).pipe).toBe('7');
      expect(h.traces).toContainEqual(["tokenCount", "sample text"]);
      await expect(run('/tokens {: /pass uncalled :}')).rejects.toThrow(/cannot be a closure/);
      expect(h.context.chat).toEqual([]);
    } finally { h.close(); }
  });
});

const root = process.env.SILLYTAVERN_SLASH_ORACLE_ROOT;
describe.skipIf(!root)("pristine list/text/native command execution oracle", () => {
  it("executes fixed original registrations, callbacks and utilities in both engines", async () => {
    const records = [];
    for (const experimental of [false, true]) for (const text of cases) {
      const original = await createSlashFixture(root), actual = await createSlashFixture();
      try {
        for (const h of [original, actual]) { h.power_user.experimental_macro_engine = experimental; h.context.nativeGenerating = true; }
        const errorInfo = (error: any): any => typeof error === 'string' ? error : error ? {
          name: error.name, message: error.message, cause: errorInfo(error.cause),
        } : null;
        const execute = async (h: typeof actual) => {
          try { return { pipe: (await h.api.executeSlashCommandsWithOptions(text,
            { handleParserErrors: false, handleExecutionErrors: false })).pipe, traces: h.traces }; }
          catch (error: any) { return { error: errorInfo(error), traces: h.traces }; }
        };
        const expected = await execute(original), observed = await execute(actual);
        expect(observed).toEqual(expected); records.push({ experimental, text, expected, observed });
      } finally { original.close(); actual.close(); }
    }
    const destination = process.env.MYCOMPANION_SLASH_NATIVE_ORACLE_REPORT;
    if (destination) {
      mkdirSync(dirname(resolve(destination)), { recursive: true });
      writeFileSync(resolve(destination), JSON.stringify({ passed: true, upstreamCommit: "7e8663cd9c184a550b37238218bdd32c6efc68e9",
        scope: `${records.length} original command executions; native persistence/stop/tokenizer boundaries supplied by fixture, actual EXE verified separately`,
        sourceHashes: ["public/scripts/slash-commands.js", "public/scripts/utils.js"].map(path => ({ path,
          sha256: createHash("sha256").update(readFileSync(resolve(root!, path))).digest("hex") })), records }, null, 2) + "\n", { flag: "wx" });
    }
  }, 60_000);
});
