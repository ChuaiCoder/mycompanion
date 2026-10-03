import { expect, it } from "vitest";
import { createSlashFixture } from "./slash-runtime-fixture.js";

const executeOptions = { handleParserErrors: false, handleExecutionErrors: false };

it("preserves the original stop command's boolean pipe while cancelling other pending slash executions", async () => {
  const h = await createSlashFixture(undefined, undefined, { generationControls: true });
  try {
    const pending = h.api.executeSlashCommandsWithOptions('/delay 60000 | /setvar key=late forbidden', executeOptions);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(h.timers.size).toBe(1);
    h.context.nativeGenerating = true;
    const stopped = await h.api.executeSlashCommandsWithOptions('/generate-stop | /pass {{pipe}}', executeOptions);
    expect(stopped).toMatchObject({ pipe: 'true', isAborted: false, isError: false });
    expect(h.traces).toContainEqual(['generationStop', true]);
    expect(await pending).toMatchObject({ isAborted: true });
    expect(h.timers.size).toBe(0);
    expect(h.context.chatMetadata.variables.late).toBeUndefined();
    for (const command of ['/stop', '/generate-stop']) {
      expect(await h.api.executeSlashCommandsWithOptions(command, executeOptions))
        .toMatchObject({ pipe: 'false', isAborted: false, isError: false });
    }
  } finally { h.close(); }
});

it("keeps external generation stops cancelling slash pipelines and delivers the original zero-argument event", async () => {
  const h = await createSlashFixture(undefined, undefined, { generationControls: true });
  try {
    const events: unknown[][] = [];
    h.api.eventSource.on(h.api.event_types.GENERATION_STOPPED, (...args: unknown[]) => { events.push(args); });
    const pending = h.api.executeSlashCommandsWithOptions('/delay 60000 | /setvar key=late forbidden', executeOptions);
    await new Promise(resolve => setTimeout(resolve, 5));
    h.context.nativeGenerating = true;
    expect(h.api.stopGeneration()).toBe(true);
    expect(await pending).toMatchObject({ isAborted: true });
    expect(events).toEqual([[]]);
    expect(h.timers.size).toBe(0);
    expect(h.context.chatMetadata.variables.late).toBeUndefined();
    await h.api.eventSource.emit(h.api.event_types.GENERATION_STOPPED);
    expect(events).toEqual([[], []]);
  } finally { h.close(); }
});

it("captures cancellation before asynchronous stop listeners without leaking an exemption to a later external event", async () => {
  const h = await createSlashFixture(undefined, undefined, { generationControls: true });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    let notifications = 0;
    const order: string[] = [];
    h.api.eventSource.makeFirst(h.api.event_types.GENERATION_STOPPED, async () => {
      const notification = ++notifications;
      order.push('start-' + notification);
      if (notification === 1) await held;
      order.push('end-' + notification);
    });
    h.api.eventSource.on(h.api.event_types.GENERATION_STOPPED, (...args: unknown[]) => {
      expect(args).toEqual([]);
      order.push('tail');
    });
    h.context.nativeGenerating = true;
    expect(await h.api.executeSlashCommandsWithOptions('/stop', executeOptions))
      .toMatchObject({ pipe: 'true', isAborted: false });
    const next = h.api.executeSlashCommandsWithOptions('/delay 60000 | /setvar key=late forbidden', executeOptions);
    await new Promise(resolve => setTimeout(resolve, 5));
    await h.api.eventSource.emit(h.api.event_types.GENERATION_STOPPED);
    expect(await next).toMatchObject({ isAborted: true });
    const after = h.api.executeSlashCommandsWithOptions('/delay 10 | /pass after', executeOptions);
    release();
    expect(await after).toMatchObject({ pipe: 'after', isAborted: false });
    expect(notifications).toBe(2);
    expect(order).toEqual(['start-1', 'start-2', 'end-2', 'tail', 'end-1', 'tail']);
    expect(h.timers.size).toBe(0);
  } finally { release(); h.close(); }
});

it("preserves a nested stop's originating controller while cancelling distinct controllers, then accepts a later stop", async () => {
  const h = await createSlashFixture(undefined, undefined, { generationControls: true });
  try {
    const controllers = [new h.api.SlashCommandAbortController(), new h.api.SlashCommandAbortController()];
    const others = controllers.map(abortController => h.api.executeSlashCommandsWithOptions(
      '/delay 60000 | /setvar key=other forbidden', { ...executeOptions, abortController }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const origin = new h.api.SlashCommandAbortController();
    h.context.nativeGenerating = true;
    const own = h.api.executeSlashCommandsWithOptions(
      '/run {: /generate-stop | /pass nested:{{pipe}} :} | /setvar key=stopPipe {{pipe}} | /delay 60000',
      { ...executeOptions, abortController: origin });
    for (let attempt = 0; attempt < 100 && h.context.chatMetadata.variables.stopPipe !== 'nested:true'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(h.context.chatMetadata.variables.stopPipe).toBe('nested:true');
    expect(origin.signal.aborted).toBe(false);
    for (const pending of others) expect(await pending).toMatchObject({ isAborted: true });
    expect(controllers.every(controller => controller.signal.aborted)).toBe(true);
    expect(h.context.chatMetadata.variables.other).toBeUndefined();
    await h.api.eventSource.emit(h.api.event_types.GENERATION_STOPPED);
    expect(await own).toMatchObject({ isAborted: true });
    expect(origin.signal.aborted).toBe(true);
    expect(h.timers.size).toBe(0);
    for (const controller of [...controllers, origin]) expect(controller.listeners.abort ?? []).toHaveLength(0);
  } finally { h.close(); }
});

it("does not pass a stop command's exemption into a native abort listener's reentrant external stop", async () => {
  let reenter = true;
  const h = await createSlashFixture(undefined, undefined, { generationControls: true, onNativeStop: () => {
    if (reenter) { reenter = false; h.api.stopGeneration(); }
  } });
  try {
    h.context.nativeGenerating = true;
    const result = await h.api.executeSlashCommandsWithOptions('/stop | /setvar key=late forbidden', executeOptions);
    // A distinct external stop is allowed to cancel the originating script.
    expect(result).toMatchObject({ isAborted: true });
    expect(h.context.chatMetadata.variables.late).toBeUndefined();
    expect(h.traces.filter(item => item[0] === 'generationStop')).toEqual([
      ['generationStop', true], ['generationStop', false],
    ]);
    expect(await h.api.executeSlashCommandsWithOptions('/generate-stop', executeOptions))
      .toMatchObject({ pipe: 'false', isAborted: false });
  } finally { h.close(); }
});

it.skipIf(!process.env.SILLYTAVERN_SLASH_ORACLE_ROOT)("matches original stop registration and nested pipe results with real native stop events in both macro modes", async () => {
  for (const experimental of [false, true]) {
    const original = await createSlashFixture(process.env.SILLYTAVERN_SLASH_ORACLE_ROOT, undefined, { generationControls: true });
    const actual = await createSlashFixture(undefined, undefined, { generationControls: true });
    try {
      for (const h of [original, actual]) h.power_user.experimental_macro_engine = experimental;
      for (const command of ['/generate-stop | /pass {{pipe}}', '/stop', '/run {: /generate-stop | /pass nested:{{pipe}} :}']) {
        for (const h of [original, actual]) h.context.nativeGenerating = command !== '/stop';
        const project = (result: any) => ({ pipe: result.pipe, isAborted: result.isAborted, isError: result.isError });
        const expected = project(await original.api.executeSlashCommandsWithOptions(command, executeOptions));
        const observed = project(await actual.api.executeSlashCommandsWithOptions(command, executeOptions));
        expect(observed).toEqual(expected);
        expect(observed).toEqual({ pipe: command === '/stop' ? 'false' : command.startsWith('/run') ? 'nested:true' : 'true', isAborted: false, isError: false });
      }
    } finally { original.close(); actual.close(); }
  }
});
