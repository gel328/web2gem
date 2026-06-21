import { TEXT_ENCODER } from "../../shared/runtime";
import type { ByteChunk, ByteQueue } from "./socket-types";

export function _joinByteChunks(chunks: readonly ByteChunk[] | null | undefined, totalLength: number): ByteChunk {
  if (!chunks || !chunks.length) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] || new Uint8Array(0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesFromBody(body: unknown): ByteChunk | null {
  if (body == null) return null;
  if (typeof body === "string") return TEXT_ENCODER.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return new Uint8Array(body as ArrayBufferLike);
}

export function createByteQueue(initial?: ByteChunk | null): ByteQueue {
  const chunks: ByteChunk[] = [];
  let headIndex = 0;
  let headOffset = 0;
  let length = 0;
  let scanActive = false;
  let scanChunkIndex = 0;
  let scanOffset = 0;
  let scanBytes = 0;
  let scanPrev = -1;
  if (initial && initial.length) {
    chunks.push(initial);
    length = initial.length;
  }
  const resetScan = () => {
    scanActive = false;
    scanChunkIndex = headIndex;
    scanOffset = headOffset;
    scanBytes = 0;
    scanPrev = -1;
  };
  const compact = () => {
    while (headIndex < chunks.length) {
      const first = chunks[headIndex];
      if (!first || headOffset < first.length) break;
      headOffset -= first.length;
      headIndex += 1;
    }
    if (headIndex >= chunks.length) {
      chunks.length = 0;
      headIndex = 0;
      headOffset = 0;
      resetScan();
    } else if (headIndex > 32 && headIndex * 2 >= chunks.length) {
      chunks.splice(0, headIndex);
      if (scanActive) scanChunkIndex = Math.max(0, scanChunkIndex - headIndex);
      headIndex = 0;
    }
  };
  const readByte = (): number => {
    compact();
    if (headIndex >= chunks.length) return -1;
    const first = chunks[headIndex];
    if (!first) return -1;
    const value = first[headOffset];
    if (value === undefined) return -1;
    headOffset += 1;
    length -= 1;
    compact();
    resetScan();
    return value;
  };
  const api: ByteQueue = {
    get length() { return length; },
    push(chunk: ByteChunk | null | undefined) {
      if (!chunk || !chunk.length) return;
      chunks.push(chunk);
      length += chunk.length;
    },
    read(n: unknown) {
      const count = Math.max(0, Math.min(Number(n) || 0, length));
      if (!count) return new Uint8Array(0);
      compact();
      const first = chunks[headIndex];
      if (first) {
        const available = first.length - headOffset;
        if (count <= available) {
          const out = first.subarray(headOffset, headOffset + count);
          headOffset += count;
          length -= count;
          compact();
          resetScan();
          return out;
        }
      }
      const out = new Uint8Array(count);
      let offset = 0;
      while (offset < count) {
        compact();
        const first = chunks[headIndex];
        if (!first) break;
        const take = Math.min(count - offset, first.length - headOffset);
        out.set(first.subarray(headOffset, headOffset + take), offset);
        headOffset += take;
        offset += take;
        length -= take;
      }
      compact();
      resetScan();
      return out;
    },
    readLine() {
      const out: number[] = [];
      for (;;) {
        const b = readByte();
        if (b < 0) return null;
        if (b === 13) {
          const next = readByte();
          if (next === 10) return new Uint8Array(out);
          out.push(b);
          if (next >= 0) out.push(next);
          continue;
        }
        out.push(b);
      }
    },
    readLineIfAvailable() {
      compact();
      if (
        !scanActive
        || scanChunkIndex < headIndex
        || (scanChunkIndex === headIndex && scanOffset < headOffset)
      ) {
        scanActive = true;
        scanChunkIndex = headIndex;
        scanOffset = headOffset;
        scanBytes = 0;
        scanPrev = -1;
      }
      for (let c = scanChunkIndex; c < chunks.length; c++) {
        const chunk = chunks[c];
        if (!chunk) continue;
        const start = c === scanChunkIndex ? scanOffset : (c === headIndex ? headOffset : 0);
        for (let i = start; i < chunk.length; i++) {
          const b = chunk[i];
          if (b === undefined) continue;
          if (scanPrev === 13 && b === 10) {
            const line = api.read(scanBytes - 1);
            api.skipCRLF();
            resetScan();
            return line;
          }
          scanPrev = b;
          scanBytes += 1;
          scanChunkIndex = c;
          scanOffset = i + 1;
        }
        scanChunkIndex = c + 1;
        scanOffset = 0;
      }
      return null;
    },
    skipCRLF() {
      const a = readByte();
      const b = readByte();
      return a === 13 && b === 10;
    },
    drain(controller: ReadableStreamDefaultController<ByteChunk>) {
      compact();
      if (!length) return;
      while (headIndex < chunks.length) {
        const first = chunks[headIndex];
        if (!first) break;
        const out = headOffset ? first.subarray(headOffset) : first;
        if (out.length) controller.enqueue(out);
        headIndex += 1;
        headOffset = 0;
      }
      chunks.length = 0;
      headIndex = 0;
      length = 0;
      resetScan();
    },
  };
  return api;
}

