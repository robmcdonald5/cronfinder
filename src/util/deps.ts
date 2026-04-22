import type { Clock } from "./now";

// Dependencies injected into every adapter. Keeps adapters pure and trivially
// testable — tests pass a fetch stub that returns fixture JSON for the exact URL.

export type FetchFn = typeof globalThis.fetch;

export interface Logger {
  log: (payload: Record<string, unknown>) => void;
}

export interface Deps {
  fetch: FetchFn;
  clock: Clock;
  logger: Logger;
}

export const consoleLogger: Logger = {
  log: (payload) => console.log(JSON.stringify(payload)),
};
