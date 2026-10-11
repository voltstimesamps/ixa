// Rebuilds the notes Qdrant collection from the SQLite chunk rows.
//
// THE CHEAP HALF, deliberately. For notes the MARKDOWN FILE is the source of
// truth and both SQLite and Qdrant are derived, so there are two possible
// rebuilds:
//
//   vault -> SQLite   the reconcile scan. NOT this script: it is a later step
//                     (and the thing that would notice a hand-edit).
//   SQLite -> Qdrant  this script. Drops the collection, recreates it with the
//                     status payload index, and re-embeds every chunk row.
//
// So this is the one to run after changing the embedding model, after a Qdrant
// data loss, or when a search returns something the vault does not say — which
// includes the one case the notebook logs loudly: a note marked superseded in
// SQLite whose vectors still carry status "active".
//
//   npx tsx dev/scripts/rebuild-note-index.ts
//   IXA_DB_PATH=… IXA_NOTES_COLLECTION=… npx tsx dev/scripts/rebuild-note-index.ts
import { config } from "../../src/config"
import { openDatabase } from "../../src/memory/db"
import { NoteStore } from "../../src/memory/notes"
import { OllamaEmbedder } from "../../src/memory/embeddings"
import { QdrantIndex } from "../../src/memory/qdrant"

async function main(): Promise<void> {
  const store = new NoteStore(openDatabase(config.data.dbPath))
  const embedder = new OllamaEmbedder()
  const index = new QdrantIndex({
    collection: config.notes.collection,
    payloadIndexes: [{ field: "status", schema: "keyword" }],
  })

  const notes = store.all()
  console.log(`Database:   ${config.data.dbPath}`)
  console.log(`Vault:      ${config.notes.vaultPath}`)
  console.log(`Collection: ${index.collectionName} @ ${config.qdrant.url}`)
  console.log(`Model:      ${embedder.model}`)
  console.log(`Notes:      ${notes.length} (${store.countActive()} active)`)
  console.log(`Chunks:     ${store.countChunks()}`)

  if (store.countChunks() === 0) {
    console.log("\nNothing to index. Recreating an empty collection anyway.")
  }

  // One probe embed: fails fast if Ollama is down, and sizes the collection
  // from the model actually in use rather than a hardcoded 768.
  const probe = await embedder.embed("probe", "query")
  console.log(`Vector size: ${probe.length}`)

  await index.recreate(probe.length)
  store.markAllNotIndexed()

  let indexed = 0
  const total = store.countChunks()
  for (const note of notes) {
    for (const chunk of store.chunksFor(note.id)) {
      const vector = await embedder.embed(chunk.text, "document")
      await index.upsert([
        {
          id: chunk.id,
          vector,
          payload: {
            noteId: note.id,
            title: note.title,
            headingPath: chunk.headingPath,
            type: note.type,
            // The whole reason a stale payload matters: this is what the
            // active-only filter reads.
            status: note.status,
            date: note.date,
          },
        },
      ])
      store.markChunkIndexed(chunk.id, embedder.model)
      indexed++
      process.stdout.write(`\r  indexed ${indexed}/${total}`)
    }
  }

  if (total > 0) process.stdout.write("\n")
  console.log(
    `\nRebuilt: ${indexed} chunk(s) indexed, ${store.countNotIndexedChunks()} still pending.`
  )
}

main().catch((err) => {
  console.error("rebuild failed:", err instanceof Error ? err.message : err)
  console.error("The vault and SQLite are untouched; fix the cause and run it again.")
  process.exit(1)
})
