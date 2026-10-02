import { getEncoding } from "js-tiktoken";
import type { File as ParseDiffFile } from 'parse-diff';

const encoding = getEncoding("gpt2");
const TOKEN_LIMIT = 1500; // model limit ~2000, keep buffer for prompt + completion

/**
 * Groups parsed git diffs into token-aware buckets to avoid LLM context limits.
 * Each chunk contains hunks from exactly one file.
 */
export function createAIChunks(files: ParseDiffFile[]): string[] {
  const chunks: string[] = [];

  for (const file of files) {
    const fileName = file.to || file.from;
    if (!fileName) continue; // skip malformed file

    const fileHeader = `\n--- File: ${fileName} ---\n`;

    let currentFileChunk = "";
    let currentFileTokens = 0;

    for (const hunk of file.chunks) {
      let hunkContent = `Hunk at line ${hunk.newStart}:\n`;
      let currentNewLine = hunk.newStart;

      for (const change of hunk.changes) {
        if (change.type === 'add' || change.type === 'normal') {
          hunkContent += `L${currentNewLine}: ${change.content}\n`;
          currentNewLine++;
        } else if (change.type === 'del') {
          hunkContent += `OLD: ${change.content}\n`;
        }
      }

      const hunkTokens = encoding.encode(hunkContent).length;

      // Handle oversized single hunk by splitting line-by-line
      if (hunkTokens > TOKEN_LIMIT) {
        if (currentFileChunk.trim()) {
          chunks.push(fileHeader + currentFileChunk);
          currentFileChunk = "";
          currentFileTokens = 0;
        }

        // Split the oversized hunk line-by-line
        let lineBuffer = "";
        for (const line of hunkContent.split("\n")) {
          const candidate = lineBuffer + line + "\n";
          if (encoding.encode(candidate).length > TOKEN_LIMIT && lineBuffer) {
            chunks.push(fileHeader + lineBuffer);
            lineBuffer = line + "\n";
          } else {
            lineBuffer = candidate;
          }
        }
        if (lineBuffer.trim()) chunks.push(fileHeader + lineBuffer);
        continue;
      }

      if (currentFileTokens + hunkTokens > TOKEN_LIMIT && currentFileChunk !== "") {
        chunks.push(fileHeader + currentFileChunk);
        currentFileChunk = hunkContent;
        currentFileTokens = hunkTokens;
      } else {
        currentFileChunk += hunkContent;
        currentFileTokens += hunkTokens;
      }
    }

    if (currentFileChunk.trim()) {
      chunks.push(fileHeader + currentFileChunk);
    }

  }

  return chunks;
}
