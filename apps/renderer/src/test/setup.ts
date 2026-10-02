import "@testing-library/jest-dom/vitest";

// jsdom has no layout/scroll implementation; real Electron coverage exercises
// the mounted chat independently.
Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });
