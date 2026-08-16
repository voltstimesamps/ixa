import { config } from "../config"

type Priority = "min" | "low" | "default" | "high" | "urgent"

const DEFAULT_NTFY_URL = "http://localhost:2586"

export async function notify(
  title: string,
  message: string,
  priority: Priority = "default"
): Promise<void> {
  const url = `${config.ntfy.url}/${config.ntfy.topic}`
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: title,
        Priority: priority,
        "Content-Type": "text/plain",
      },
      body: message,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }
  } catch (err) {
    const isDefaultUrl =
      !config.ntfy.url || config.ntfy.url === DEFAULT_NTFY_URL
    if (isDefaultUrl) {
      console.warn(`Ntfy not reachable — notification dropped: ${title}`)
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Ntfy notification failed: ${msg}`)
  }
}
