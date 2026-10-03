import { config } from "../config"

// Embeddings via Ollama.
//
// nomic-embed-text is trained for asymmetric retrieval and expects a task
// prefix: a short question is a "search_query", a stored summary is a
// "search_document". Measured on sample episodes, the prefixes lift related
// scores to 0.65-0.74 while unrelated ones stay around 0.54. Embedding a
// document as a query (or vice versa) silently degrades that separation, so
// the kind is a required argument rather than an option.

export type EmbeddingKind = "query" | "document"

const PREFIX: Record<EmbeddingKind, string> = {
  query: "search_query: ",
  document: "search_document: ",
}

export interface Embedder {
  readonly model: string
  embed(text: string, kind: EmbeddingKind, signal?: AbortSignal): Promise<number[]>
}

export class OllamaEmbedder implements Embedder {
  readonly model: string
  private readonly url: string
  private readonly keepAlive: string

  constructor(options: { url?: string; model?: string; keepAlive?: string } = {}) {
    this.url = options.url ?? config.ollama.url
    this.model = options.model ?? config.ollama.embedModel
    this.keepAlive = options.keepAlive ?? config.ollama.embedKeepAlive
  }

  async embed(text: string, kind: EmbeddingKind, signal?: AbortSignal): Promise<number[]> {
    const response = await fetch(`${this.url}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt: `${PREFIX[kind]}${text}`,
        keep_alive: this.keepAlive,
      }),
      signal,
    })

    if (!response.ok) {
      throw new Error(`Ollama embeddings returned ${response.status}`)
    }

    const body = (await response.json()) as { embedding?: unknown }
    if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
      throw new Error("Ollama returned no embedding")
    }
    return body.embedding as number[]
  }

  // Pays the model's load cost (~0.5s) off the critical path at startup, so
  // the first real turn sees a warm ~40ms embed instead of a skipped recall.
  async warmUp(signal?: AbortSignal): Promise<void> {
    await this.embed("warm up", "query", signal)
  }
}
