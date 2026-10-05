import { expect, it } from "vitest";
import { expandTavernRandom, tavernRandomBrowserSource } from "./tavern-random-core.js";

it("serves the exact native parser body to the browser and preserves choice syntax", () => {
  const browser = new Function(tavernRandomBrowserSource.replace(/^export /, "") + "return expandTavernRandom")() as typeof expandTavernRandom;
  for (const expand of [expandTavernRandom, browser]) {
    expect(expand("{{random::晴天::雨天}}", () => 0)).toBe("晴天");
    expect(expand("{{random::晴天::雨天}}", () => 0.99)).toBe("雨天");
    expect(expand("{{random:红\\,蓝,绿}}", () => 0)).toBe("红,蓝");
    expect(expand("{{random:: 前 :: 后 }}", () => 0)).toBe(" 前 ");
    expect(expand("{{random::}}", () => 0)).toBe(":");
  }
});
