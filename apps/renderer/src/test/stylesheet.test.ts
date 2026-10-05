// Static guards over the stylesheet for two bug classes that have actually shipped:
//
//  1. A grid shell reserving a column that no element occupies. `runtime-shell`
//     did this twice: once at the 900px/1280px breakpoints, and again because
//     `--memory` kept adding a 340px track after the memory pane had become an
//     absolute overlay (the pane leaves the grid, the track stays empty).
//  2. Selectors left behind by removed markup (`story-list-pane`,
//     `favorite-character`), which silently do nothing and hide the fact that a
//     feature was deleted.
//
// Source-level assertions only: no browser, no computed layout. Real layout is
// verified in Electron; this stops the regressions from being re-added.
// Files are pulled in by Vite so the test needs no Node APIs (the renderer
// tsconfig has no node types).
import { test } from "vitest";
import stylesheet from "../styles.css?raw";

const componentSources = import.meta.glob("../**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const helperSources = import.meta.glob("../**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const markup = Object.entries({ ...helperSources, ...componentSources })
  // Test files describe expectations, not markup, so they must not count as usage.
  .filter(([path]) => !path.includes(".test."))
  .map(([, source]) => source)
  .join("\n");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + " (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")");
  }
}

interface Rule { selector: string; body: string; media: string | null; at: boolean }

// Strip block comments so commented-out rules can neither satisfy nor trip a check.
const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");

/** Walk a stylesheet, tagging each rule with the media query it sits inside. */
function collectRules(source: string, media: string | null = null, found: Rule[] = []): Rule[] {
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open < 0) break;
    const selector = source.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + 1, cursor - 1);
    if (selector.startsWith("@media")) {
      collectRules(body, selector, found);
    } else if (selector.startsWith("@")) {
      found.push({ selector, body, media, at: true });
    } else {
      found.push({ selector, body, media, at: false });
    }
    index = cursor;
  }
  return found;
}

const allRules = collectRules(css);
const inOverlayQuery = (rule: Rule) => Boolean(rule.media?.includes("max-width: 1280px"));

test("the memory overlay does not leave an empty grid track behind", () => {
  const overlay = allRules.filter(rule => inOverlayQuery(rule) && rule.selector.includes(".memory-side-pane") && rule.body.includes("position: absolute"));
  assert(overlay.length === 1, "the overlay media query must still remove the memory pane from the grid");
  // The trailing `;` matters: without it, `minmax(0,1fr) 340px` also matches and the
  // check passes on exactly the bug it is meant to catch.
  const restored = allRules.filter(rule => inOverlayQuery(rule) && rule.selector.includes(".runtime-shell--memory") && /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(rule.body));
  assert(restored.length === 1, "inside the overlay query, --memory must fall back to a single column");
});

test("no breakpoint gives the chat shell a fixed first track", () => {
  // ChatView renders one child (.chat-pane) unless the memory pane is present, so a
  // fixed leading track is reserved for nothing and squeezes the conversation.
  const suspicious = allRules
    .filter(rule => rule.selector.includes(".runtime-shell") && /grid-template-columns:\s*(?:\d+px|minmax\(\d+px)/.test(rule.body))
    .map(rule => rule.selector + " @ " + (rule.media ?? "base"));
  assertEqual(suspicious, [], "runtime-shell must not declare a fixed first track");
});

test("every class selector is referenced by the markup or derived from a runtime value", () => {
  const classNames = new Set<string>();
  for (const rule of allRules) {
    for (const match of rule.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) classNames.add(match[1]!);
  }
  // 两类选择器无法逐字出现在源码里，前者按修饰段判定，后者是运行期拼出来的值：
  //   .foo--bar            状态类由基础类 + 变量拼成（chat-message--${status}）
  //   .foo--character_core 修饰段来自数据枚举（区域 key），名字里含下划线
  const referenced = (name: string): boolean => {
    if (markup.includes(name)) return true;
    const modifier = name.includes("--") ? name.slice(name.indexOf("--") + 2) : name;
    return modifier.length >= 4 && (modifier.includes("_") || markup.includes(modifier));
  };
  const missing = [...classNames].filter(name => !referenced(name));
  assertEqual(missing, [], "these selectors match no element any more: " + missing.join(", "));
});
