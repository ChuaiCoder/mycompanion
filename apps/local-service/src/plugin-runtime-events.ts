// Project-authored implementation of the ST 1.19 event emitter contract.
// emit awaits listeners in order; the historically named emitAndWait invokes
// them synchronously. Readiness events replay for listeners installed later.
export const eventBusSource = String.raw`
class EventBus {
  events = Object.create(null);
  autoFireLastArgs = new Map();
  autoFireAfterEmit;
  constructor(replay = []) { this.autoFireAfterEmit = new Set(replay); }
  on(name, callback) {
    if (name === undefined) return;
    (this.events[name] ||= []).push(callback);
    this.replay(name, callback);
  }
  replay(name, callback) {
    if (this.autoFireAfterEmit.has(name) && this.autoFireLastArgs.has(name))
      callback.apply(this, this.autoFireLastArgs.get(name));
  }
  makeFirst(name, callback) {
    this.removeListener(name, callback);
    (this.events[name] ||= []).unshift(callback);
    this.replay(name, callback);
  }
  makeLast(name, callback) {
    this.removeListener(name, callback);
    this.on(name, callback);
  }
  once(name, callback) {
    const bus = this;
    this.on(name, function onceListener(...args) {
      bus.removeListener(name, onceListener);
      // Preserve the host's awaited save/navigation listeners when emit is
      // used. emitAndWait still invokes this wrapper without awaiting it.
      return callback.apply(this, args);
    });
  }
  removeListener(name, callback) {
    const listeners = this.events[name];
    const index = listeners?.indexOf(callback) ?? -1;
    if (index >= 0) listeners.splice(index, 1);
  }
  off(name, callback) { this.removeListener(name, callback); }
  async emit(name, ...args) {
    await this.dispatch(name, args, false);
  }
  // Internal request preflight preserves the application's existing guarantee:
  // a failed prompt/settings transformation must not send a partial request.
  async emitChecked(name, ...args) {
    await this.dispatch(name, args, true);
  }
  async dispatch(name, args, checked) {
    for (const callback of [...(this.events[name] || [])]) {
      try { await callback.apply(this, args); }
      catch (error) { if (checked) throw error; console.error(error); }
    }
    if (this.autoFireAfterEmit.has(name)) this.autoFireLastArgs.set(name, args);
  }
  emitAndWait(name, ...args) {
    for (const callback of [...(this.events[name] || [])]) {
      try { callback.apply(this, args); }
      catch (error) { console.error(error); }
    }
    if (this.autoFireAfterEmit.has(name)) this.autoFireLastArgs.set(name, args);
  }
}
`;
