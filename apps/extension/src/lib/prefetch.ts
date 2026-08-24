export const SUBTITLE_BATCH_SIZE = 24;
export const PREFETCH_BATCH_COUNT = 3;

export interface SubtitleChunk {
  start: number;
  end: number;
}

export function alignedSubtitleChunks(
  cueCount: number,
  cueIndex: number,
  batchSize = SUBTITLE_BATCH_SIZE,
  batchCount = PREFETCH_BATCH_COUNT,
): SubtitleChunk[] {
  if (cueCount <= 0 || cueIndex < 0 || cueIndex >= cueCount) return [];
  const anchor = Math.floor(cueIndex / batchSize) * batchSize;
  const chunks: SubtitleChunk[] = [];
  for (let index = 0; index < batchCount; index += 1) {
    const start = anchor + index * batchSize;
    if (start >= cueCount) break;
    chunks.push({ start, end: Math.min(start + batchSize, cueCount) });
  }
  return chunks;
}
