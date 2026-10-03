import { expect, it } from "vitest";
import { encodeWorldInfoGraph, decodeWorldInfoGraph } from "./world-info-event-graph.js";

it("round-trips graph aliases, Map/Set keys, cycles and scalars while reusing identities across loops",()=>{
  const nativeObjects:object[]=[],browserObjects:object[]=[];
  const item:any={uid:1,missing:undefined,positive:Infinity,negative:-Infinity,nan:NaN,big:123n};item.self=item;
  const native:any={entries:[item],activated:new Map([["one",item]]),selected:new Set([item])};
  const browser=decodeWorldInfoGraph(encodeWorldInfoGraph(native,nativeObjects),browserObjects),remembered=browser.entries[0];
  expect(browser.activated.get("one")).toBe(remembered);expect(browser.selected.has(remembered)).toBe(true);expect(remembered.self).toBe(remembered);
  browser.entries[0].content="changed";browser.activated.set(remembered,browser.entries);browser.selected.add(browser.entries);
  const updated=decodeWorldInfoGraph(encodeWorldInfoGraph(browser,browserObjects),nativeObjects);
  expect(updated).toBe(native);expect(native.entries[0]).toBe(item);expect(native.activated.get(item)).toBe(native.entries);
  const next=decodeWorldInfoGraph(encodeWorldInfoGraph(native,nativeObjects),browserObjects);
  expect(next.entries[0]).toBe(remembered);expect(next.entries[0].content).toBe("changed");expect(next.entries[0].big).toBe(123n);
  expect(()=>encodeWorldInfoGraph({callback(){}})).toThrow("transportable data");
});

it("handles special property names as data without altering object prototypes",()=>{
  const raw=JSON.parse('{"__proto__":{"polluted":true},"constructor":"own"}');
  const restored=decodeWorldInfoGraph(encodeWorldInfoGraph(raw));
  expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);expect(Object.hasOwn(restored,"__proto__")).toBe(true);
  expect(restored.__proto__.polluted).toBe(true);expect(({} as any).polluted).toBeUndefined();
});
