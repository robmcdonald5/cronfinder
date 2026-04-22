// gzip via the native CompressionStream (Web Streams API, available in Workers).
// Used to keep raw_responses.body well under D1's 2 MB row limit.

export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function gzipText(input: string): Promise<Uint8Array> {
  return gzipBytes(new TextEncoder().encode(input));
}

export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(input).body!.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function gunzipText(input: Uint8Array): Promise<string> {
  const bytes = await gunzipBytes(input);
  return new TextDecoder().decode(bytes);
}
