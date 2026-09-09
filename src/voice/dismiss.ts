// Detected against the STT transcript of a voice turn to close a wake-word
// conversation without an LLM round trip — dismissing shouldn't cost a
// generated reply, just a fixed acknowledgment.
const DISMISS_PHRASES = [
  "goodbye ixa",
  "bye ixa",
  "stop listening",
  "go to sleep",
  "that's all ixa",
  "that's all for now",
]

export const DISMISS_ACKNOWLEDGMENT = "Goodbye."

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
}

const NORMALIZED_DISMISS_PHRASES = DISMISS_PHRASES.map(normalize)

export function isDismissPhrase(text: string): boolean {
  const normalized = normalize(text)
  return NORMALIZED_DISMISS_PHRASES.some(
    (phrase) => normalized === phrase || normalized.includes(phrase),
  )
}
