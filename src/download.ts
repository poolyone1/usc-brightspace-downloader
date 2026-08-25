import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StreamedFile {
  sha256: string;
  size: number;
}

export async function streamToFile(
  source: NodeJS.ReadableStream | AsyncIterable<Uint8Array>,
  target: string,
  expectedLength?: number,
): Promise<StreamedFile> {
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  const readable = Symbol.asyncIterator in Object(source)
    ? Readable.from(source as AsyncIterable<Uint8Array>)
    : source as NodeJS.ReadableStream;
  await pipeline(readable, meter, createWriteStream(target, { mode: 0o600 }));
  if (expectedLength !== undefined && expectedLength !== size) {
    throw new Error(`Incomplete download: expected ${expectedLength} bytes, received ${size}.`);
  }
  return { sha256: hash.digest("hex"), size };
}
