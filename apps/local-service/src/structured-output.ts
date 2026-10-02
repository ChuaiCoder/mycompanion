// Shared by server quiet generation and the browser raw-generation bridge.
// This formats JSON output; validation against the schema belongs to the model.
export function normalizeStructuredOutput(text: string, returnInvalid = false): string {
  try {
    const value: unknown = JSON.parse(text);
    if (!value && returnInvalid) return text;
    return JSON.stringify(value ?? {});
  } catch {
    return returnInvalid ? text : "{}";
  }
}
