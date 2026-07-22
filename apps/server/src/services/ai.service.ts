import { getEncoding } from "js-tiktoken";

const encoding = getEncoding("gpt2");
const TOKEN_LIMIT = 2000;

/**
 * Groups parsed git diffs into token-aware buckets to avoid LLM context limits.
 */
export function createAIChunks(files: any[]) {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const file of files) {
    const fileHeader = `\n--- File: ${file.to} ---\n`;
    
    for (const hunk of file.chunks) {
      let hunkContent = `Hunk at line ${hunk.newStart}:\n`;
      
let currentNewLine = hunk.newStart;

  for (const change of hunk.changes) {
    if (change.type === 'add') {
      hunkContent += `L${currentNewLine}: ${change.content}\n`;
      currentNewLine++;
    } else if (change.type === 'normal') {
      hunkContent += `L${currentNewLine}: ${change.content}\n`;
      currentNewLine++;
    } else if (change.type === 'del') {
      hunkContent += `OLD: ${change.content}\n`;
    }
  }

      const hunkTokens = encoding.encode(hunkContent).length;
      const currentChunkTokens = encoding.encode(currentChunk).length;

      // If adding this hunk pushes us over the limit, start a new bucket
      if (currentChunkTokens + hunkTokens > TOKEN_LIMIT && currentChunk !== "") {
        chunks.push(currentChunk);
        currentChunk = fileHeader + hunkContent;
      } else {
        // If it's the start of a new file in the same bucket, add the header
        if (!currentChunk.includes(fileHeader)) {
          currentChunk += fileHeader;
        }
        currentChunk += hunkContent;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk);
  }

  return chunks;
}