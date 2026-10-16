type SearchHit = { chunkId: string; score: number }

/** Keep exact numeric/identifier lookups lexical and discard weak semantic noise. */
export function selectRelevantSearchHits<T extends SearchHit>(
  query: string,
  keywordHits: T[],
  rerankedHits: T[],
  topK: number,
): T[] {
  const exactLookup = /[\p{N}]/u.test(query) && /^[\p{L}\p{N}_-]+$/u.test(query.trim())
  if (exactLookup) return keywordHits.slice(0, topK)
  const lexicalIds = new Set(keywordHits.map((hit) => hit.chunkId))
  return rerankedHits
    .filter((hit) => lexicalIds.has(hit.chunkId) || hit.score >= 0.396)
    .slice(0, topK)
}
