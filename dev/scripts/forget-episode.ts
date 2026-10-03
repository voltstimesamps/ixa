// Deletes one episode, for good, from both SQLite and Qdrant.
//
// This is the user removing their own data, so unlike a forgotten preference
// there is no soft-delete tier: the summary text is gone. SQLite goes first
// because it is the source of truth — the moment the row is deleted the
// episode is unreachable, since recall and search_memory both resolve Qdrant
// hits back to SQLite rows and drop (and clean up) any that no longer exist.
// A rebuild reads rows too, so nothing can resurrect it.
//
//   npx tsx dev/scripts/forget-episode.ts 12 --dry-run
//   npx tsx dev/scripts/forget-episode.ts 12
import { config } from "../../src/config"
import { openDatabase } from "../../src/memory/db"
import { EpisodeStore } from "../../src/memory/episodes"
import { QdrantIndex } from "../../src/memory/qdrant"

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const idArg = args.find((arg) => !arg.startsWith("--"))
  const id = Number(idArg)

  if (!idArg || !Number.isInteger(id) || id <= 0) {
    console.error("usage: npx tsx dev/scripts/forget-episode.ts <episode-id> [--dry-run]")
    process.exit(2)
  }

  const store = new EpisodeStore(openDatabase(config.data.dbPath))
  const episode = store.byId(id)

  if (!episode) {
    console.error(`No episode #${id} in ${config.data.dbPath}.`)
    process.exit(1)
  }

  const ended = new Date(episode.endedAt).toLocaleString("en-GB")
  console.log(`Episode #${episode.id}`)
  console.log(`  session: ${episode.sessionId}`)
  console.log(`  ended:   ${ended}`)
  console.log(`  tags:    ${episode.tags.join(", ") || "(none)"}`)
  console.log(`  indexed: ${episode.indexedAt ? `yes (${episode.embeddingModel})` : "no"}`)
  console.log(`  summary: ${episode.summary}`)

  if (dryRun) {
    console.log("\n--dry-run: nothing deleted.")
    return
  }

  store.delete(episode.id)
  console.log(`\nDeleted episode #${episode.id} from SQLite.`)

  const index = new QdrantIndex()
  try {
    await index.deletePoints([episode.id])
    console.log(`Deleted vector ${episode.id} from "${index.collectionName}".`)
  } catch (err) {
    console.warn(`Could not reach Qdrant: ${err instanceof Error ? err.message : String(err)}`)
    console.warn(
      "The episode is already unreachable — recall resolves hits against SQLite and drops " +
        "(and deletes) vectors with no row. The stale vector will also disappear on the next " +
        "rebuild: npx tsx dev/scripts/rebuild-episode-index.ts"
    )
  }
}

main().catch((err) => {
  console.error("forget-episode failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
