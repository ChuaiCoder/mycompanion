/** Single Tavern-style random choice parser for native and browser prompts. */
export function expandTavernRandom(text: string, random: () => number = Math.random, postProcess: (value: string) => string = value => value): string {
  return text.replace(/{{random\s?::?([^}]+)}}/gi, (match, body: string) => {
    const choices = body.includes("::")
      ? body.split("::")
      : body.replace(/\\,/g, "\u0000").split(",").map(value => value.trim().replace(/\u0000/g, ","));
    if (!choices.length || choices.every(value => value === "")) return match;
    const value = random();
    const index = Math.max(0, Math.min(choices.length - 1, Math.floor(value * choices.length)));
    return postProcess(choices[index] ?? "");
  });
}

export const tavernRandomBrowserSource = `export const expandTavernRandom = ${expandTavernRandom.toString()};`;
