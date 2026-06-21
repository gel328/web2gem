let supportedAcceptEncodingCache: string | null = null;

export function socketAcceptEncoding(acceptCompressed: boolean): string {
  if (!acceptCompressed) return "identity";
  if (supportedAcceptEncodingCache !== null) return supportedAcceptEncodingCache;
  supportedAcceptEncodingCache = supportsGzipDecompression() ? "gzip" : "identity";
  return supportedAcceptEncodingCache;
}

export function contentDecompressionFormat(raw: string | null): CompressionFormat | null {
  const value = String(raw || "").trim().toLowerCase();
  if ((value === "gzip" || value === "x-gzip") && supportsGzipDecompression()) return "gzip";
  return null;
}

export function maybeDecompressSocketBody(
  stream: ReadableStream<Uint8Array>,
  headers: Headers,
  noBody: boolean,
  contentLength: number | null,
): ReadableStream<Uint8Array> {
  const decompressionFormat = noBody || contentLength === 0 ? null : contentDecompressionFormat(headers.get("content-encoding"));
  if (!decompressionFormat) return stream;
  headers.delete("content-encoding");
  headers.delete("content-length");
  return stream.pipeThrough(new DecompressionStream(decompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

function supportsGzipDecompression(): boolean {
  if (typeof DecompressionStream !== "function") return false;
  try {
    new DecompressionStream("gzip");
    return true;
  } catch (_) {
    return false;
  }
}
