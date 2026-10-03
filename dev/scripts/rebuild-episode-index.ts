// Rebuilds the Qdrant collection from scratch out of SQLite.
//
// SQLite is the source of truth, so this is always safe: it drops the
// collection, recreates it, and re-embeds every episode row. Use it after
// changing the embedding model, after a Qdrant data loss, or any time the
// index is suspect.
//
// Episodes deleted from SQLite (see forget-episode.ts) are gone from here too
// — the rebuild reads rows, so there is nothing for a deleted episode to come
// back from.
//
//   npx tsx dev/scripts/rebuild-episode-index.ts
//   IXA_DB_PATH=… QDRANT_COLLECTION=… npx tsx dev/scripts/rebuild-episode-index.ts
import { config } from "../../src/config"
import { openDatabase } from "../../src/memory/db"
import { EpisodeStore } from "../../src/memory/episodes"
import { OllamaEmbedder } from "../../src/memory/embeddings"
import { QdrantIndex } from "../../src/memory/qdrant"

async function main(): Promise<void> {
  const store = new EpisodeStore(openDatabase(config.data.dbPath))
  const embedder = new OllamaEmbedder()
  const index = new QdrantIndex()

  const episodes = store.all()
  console.log(`Database:   ${config.data.dbPath}`)
  console.log(`Collection: ${index.collectionName} @ ${config.qdrant.url}`)
  console.log(`Model:      ${embedder.model}`)
  console.log(`Episodes:   ${episodes.length}`)

  if (episodes.length === 0) {
    console.log("\nNothing to index. Recreating an empty collection anyway.")
  }

  // One probe embed, both to fail fast if Ollama is down and to size the
  // collection from the model actually in use rather than a hardcoded 768.
  const probe = await embedder.embed("probe", "query")
  console.log(`Vector size: ${probe.length}`)

  await index.recreate(probe.length)
  store.markAllNotIndexed()

  let indexed = 0
  for (const episode of episodes) {
    const vector = await embedder.embed(episode.summary, "document")
    await index.upsert([
      {
        id: episode.id,
        vector,
        payload: {
          episodeId: episode.id,
          sessionId: episode.sessionId,
          startedAt: episode.startedAt,
          endedAt: episode.endedAt,
          tags: episode.tags,
        },
      },
    ])
    store.markIndexed(episode.id, embedder.model)
    indexed++
    process.stdout.write(`\r  indexed ${indexed}/${episodes.length}`)
  }

  if (episodes.length > 0) process.stdout.write("\n")
  console.log(`\nRebuilt: ${indexed} episode(s) indexed, ${store.countNotIndexed()} still pending.`)
}

main().catch((err) => {
  console.error("rebuild failed:", err instanceof Error ? err.message : err)
  console.error("SQLite is untouched; fix the cause and run it again.")
  process.exit(1)
})
