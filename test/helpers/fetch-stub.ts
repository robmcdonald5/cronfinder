import type { FetchFn, Logger } from "../../src/util/deps";

export function silentLogger(): Logger {
  return { log: () => {} };
}

export function makeFetchStub(
  handlers: Record<string, (req: Request) => Response | Promise<Response>>,
): FetchFn {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const urlKey = req.url;
    // Prefix match so callers can register "https://api.example.com/foo" and
    // match "https://api.example.com/foo?bar=baz".
    for (const prefix of Object.keys(handlers)) {
      if (urlKey.startsWith(prefix)) return handlers[prefix]!(req);
    }
    throw new Error(`fetch-stub: no handler for ${urlKey}`);
  }) as FetchFn;
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
