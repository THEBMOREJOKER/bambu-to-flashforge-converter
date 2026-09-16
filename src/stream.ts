/**
 * Reading a member too big to hold: a project's model file runs to 200 MB of XML, and the only things wanted
 * from it are tags. The callback sees text that always ends on a complete tag, so a scanner never has to worry
 * about a `<vertex` split across two chunks.
 */
import { createReadStream } from "node:fs";
import { createInflateRaw } from "node:zlib";
import { pipeline } from "node:stream/promises";

import type { Zip } from "./zip.js";

export async function streamMemberText(
  zip: Zip,
  name: string,
  onText: (text: string) => void,
): Promise<void> {
  const { start, end, method } = zip.byteRange(name);
  if (end < start) return;
  const file = createReadStream(zip.path, { start, end });
  const source = method === 8 ? file.pipe(createInflateRaw()) : file;

  let carry = "";
  await pipeline(source, async function (chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      const text = carry + chunk.toString("utf8");
      const cut = text.lastIndexOf(">") + 1;
      if (cut > 0) {
        onText(text.slice(0, cut));
        carry = text.slice(cut);
      } else {
        carry = text;
      }
    }
    if (carry) onText(carry);
  });
}
