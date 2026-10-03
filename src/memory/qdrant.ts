import { config } from "../config"

// Qdrant, over its REST API with plain fetch — four calls do not justify a
// client library, and every other service in Ixa (Tavily, Ntfy, both sidecars)
// is reached the same way.
//
// This collection is an INDEX, never a source of truth. Point ids are the
// SQLite episode ids, so there is no id mapping to keep in sync, and payloads
// hold only what filtering needs: summaries are read back from SQLite. If the
// two ever disagree, SQLite wins and the collection can be rebuilt.

export interface VectorPoint {
  id: number
  vector: number[]
  payload: {
    episodeId: number
    sessionId: string
    startedAt: number
    endedAt: number
    tags: string[]
  }
}

export interface SearchHit {
  id: number
  score: number
}

export interface SearchOptions {
  limit: number
  minScore: number
  // Inclusive epoch-ms bounds on the episode's end time.
  from?: number
  to?: number
  signal?: AbortSignal
}

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
  // Checked once per process: creating a collection that exists is harmless
  // but costs a round trip on every write.
  private ensured = false

  constructor(options: { url?: string; collection?: string } = {}) {
    this.url = options.url ?? config.qdrant.url
    this.collection = options.collection ?? config.qdrant.collection
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
    // Indexed so search_memory's optional date range filters server side
    // rather than over-fetching and filtering here.
    await this.request(
      "PUT",
      `/collections/${this.collection}/index?wait=true`,
      { field_name: "endedAt", field_schema: "integer" },
      signal
    )
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
      score_threshold: options.minScore,
      with_payload: false,
    }
    if (Object.keys(range).length > 0) {
      body.filter = { must: [{ key: "endedAt", range }] }
    }

    const result = (await this.request(
      "POST",
      `/collections/${this.collection}/points/search`,
      body,
      options.signal
    )) as { result?: Array<{ id: number | string; score: number }> }

    return (result.result ?? []).map((hit) => ({ id: Number(hit.id), score: hit.score }))
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
