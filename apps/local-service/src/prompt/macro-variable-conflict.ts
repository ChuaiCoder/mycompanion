/** Safe, actionable generation failure; no provider request has been sent. */
export class MacroVariableConflictError extends Error {
  constructor(key: string) {
    super(`生成期间变量 ${key} 已被修改，请重新生成以使用最新值。`);
    this.name = "MacroVariableConflictError";
  }
}
