import { config } from "../config"

// Qdrant, over its REST API with plain fetch — four calls do not justify a
// client library, and every other service in Ixa (Tavily, Ntfy, both sidecars)
// is reached the same way.
//
// A collection here is an INDEX, never a source of truth. Point ids are the
// SQLite row ids they came from, so there is no id mapping to keep in sync,
// and payloads hold only what filtering needs: the text is read back from
// SQLite (episodes) or from the markdown file (notes). If the two ever
// disagree, the source wins and the collection can be rebuilt.
//
// ONE CLIENT, TWO COLLECTIONS. Phase 3d adds a notes collection beside the
// episode one, and the differences between them are all parameters rather
// than a second client: the payload shape, which fields are indexed, whether
// a search filters on anything, and whether a search has a score floor at
// all. Everything the episode path passes is the default, so its requests go
// out byte-identical to before.

// Whatever a collection wants to filter on. Deliberately not a union of the
// two known shapes: the index does not care what is in a payload, and typing
// it as one would mean editing this file for every new collection.
export type Payload = Record<string, unknown>

// The episode payload, kept here because the comment above is about it.
// A TYPE ALIAS, not an interface, deliberately: an interface has no index
// signature and so is not assignable to Payload, which would make this
// documentation fail to compile the moment anyone used it.
export type EpisodePayload = {
  episodeId: number
  sessionId: string
  startedAt: number
  endedAt: number
  tags: string[]
}

export interface VectorPoint {
  id: number
  vector: number[]
  payload: Payload
}

export interface SearchHit {
  id: number
  score: number
  // Present only when the search asked for it. Episodes never do: they
  // resolve every hit against SQLite anyway, so a payload would be a second
  // copy of facts that are already authoritative somewhere else.
  payload?: Payload
}

// A raw Qdrant filter condition, e.g. { key: "status", match: { value: "active" } }.
// Passed through untouched — wrapping Qdrant's filter language in a typed
// builder would be a second language to learn for no gain at four call sites.
export type FilterClause = Record<string, unknown>

export interface SearchOptions {
  limit: number
  // OPTIONAL, AND UNDEFINED MEANS NO THRESHOLD — not a default floor.
  // Measured over 19 questions against 24 notes with this embedder: text that
  // genuinely answered the question scored as low as 0.586 while text from an
  // unrelated note reached 0.755. The bands overlap completely, so the notes
  // path ranks and filters instead of thresholding, and must not silently
  // inherit the episode threshold by omitting this field.
  minScore?: number
  // Inclusive epoch-ms bounds on the episode's end time.
  from?: number
  to?: number
  // Extra conditions, ANDed with the date range if both are given.
  filter?: FilterClause[]
  withPayload?: boolean
  signal?: AbortSignal
}

// A payload field to index server side, so a filtered search narrows in Qdrant
// rather than over-fetching and filtering here.
export interface PayloadIndex {
  field: string
  schema: "integer" | "keyword"
}

// What search_memory's optional date range needs, and the default so that the
// episode collection is still created exactly as it was.
export const EPISODE_PAYLOAD_INDEXES: PayloadIndex[] = [
  { field: "endedAt", schema: "integer" },
]

export interface VectorIndex {
  ensureCollection(vectorSize: number, signal?: AbortSignal): Promise<void>
  upsert(points: VectorPoint[], signal?: AbortSignal): Promise<void>
  search(vector: number[], options: SearchOptions): Promise<SearchHit[]>
  deletePoints(ids: number[], signal?: AbortSignal): Promise<void>
  recreate(vectorSize: number, signal?: AbortSignal): Promise<void>
  health(signal?: AbortSignal): Promise<boolean>
}

export class QdrantIndex implements VectorIndex {
  private readonly url: string
  private readonly collection: string
  private readonly payloadIndexes: PayloadIndex[]
  // Checked once per process: creating a collection that exists is harmless
  // but costs a round trip on every write. Per-instance, so the episode and
  // notes collections each get their own one check.
  private ensured = false

  constructor(
    options: { url?: string; collection?: string; payloadIndexes?: PayloadIndex[] } = {}
  ) {
    this.url = options.url ?? config.qdrant.url
    this.collection = options.collection ?? config.qdrant.collection
    this.payloadIndexes = options.payloadIndexes ?? EPISODE_PAYLOAD_INDEXES
  }

  get collectionName(): string {
    return this.collection
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`Qdrant ${method} ${path} returned ${response.status}: ${detail.slice(0, 200)}`)
    }
    return response.json()
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/healthz`, { signal })
      return response.ok
    } catch {
      return false
    }
  }

  async ensureCollection(vectorSize: number, signal?: AbortSignal): Promise<void> {
    if (this.ensured) return

    const exists = await fetch(`${this.url}/collections/${this.collection}`, { signal })
      .then((r) => r.ok)
      .catch(() => false)

    if (!exists) {
      await this.createCollection(vectorSize, signal)
    }
    this.ensured = true
  }

  private async createCollection(vectorSize: number, signal?: AbortSignal): Promise<void> {
    await this.request(
      "PUT",
      `/collections/${this.collection}`,
      { vectors: { size: vectorSize, distance: "Cosine" } },
      signal
    )
    // Indexed so a filtered search narrows server side rather than
    // over-fetching and filtering here: `endedAt` for search_memory's date
    // range, `status` for the notes path's active-only filter.
    for (const index of this.payloadIndexes) {
      await this.request(
        "PUT",
        `/collections/${this.collection}/index?wait=true`,
        { field_name: index.field, field_schema: index.schema },
        signal
      )
    }
    console.log(`qdrant: created collection "${this.collection}" (${vectorSize}d, cosine)`)
  }

  // Drops and recreates the collection. Only the rebuild script calls this:
  // everything needed to repopulate it lives in SQLite.
  async recreate(vectorSize: number, signal?: AbortSignal): Promise<void> {
    await fetch(`${this.url}/collections/${this.collection}`, { method: "DELETE", signal }).catch(
      () => undefined
    )
    this.ensured = false
    await this.createCollection(vectorSize, signal)
    this.ensured = true
  }

  async upsert(points: VectorPoint[], signal?: AbortSignal): Promise<void> {
    if (points.length === 0) return
    await this.ensureCollection(points[0]!.vector.length, signal)
    await this.request(
      "PUT",
      `/collections/${this.collection}/points?wait=true`,
      {
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        })),
      },
      signal
    )
  }

  async search(vector: number[], options: SearchOptions): Promise<SearchHit[]> {
    const range: Record<string, number> = {}
    if (options.from !== undefined) range.gte = options.from
    if (options.to !== undefined) range.lte = options.to

    const body: Record<string, unknown> = {
      vector,
      limit: options.limit,
      with_payload: options.withPayload ?? false,
    }
    // Omitted rather than sent as null: a collection searched with no floor
    // (the notes path) must not have one applied on its behalf.
    if (options.minScore !== undefined) body.score_threshold = options.minScore

    const must: FilterClause[] = []
    if (Object.keys(range).length > 0) must.push({ key: "endedAt", range })
    if (options.filter) must.push(...options.filter)
    if (must.length > 0) body.filter = { must }

    const result = (await this.request(
      "POST",
      `/collections/${this.collection}/points/search`,
      body,
      options.signal
    )) as { result?: Array<{ id: number | string; score: number; payload?: Payload }> }

    return (result.result ?? []).map((hit) => ({
      id: Number(hit.id),
      score: hit.score,
      ...(hit.payload ? { payload: hit.payload } : {}),
    }))
  }

  async deletePoints(ids: number[], signal?: AbortSignal): Promise<void> {
    if (ids.length === 0) return
    await this.request(
      "POST",
      `/collections/${this.collection}/points/delete?wait=true`,
      { points: ids },
      signal
    )
  }
}
