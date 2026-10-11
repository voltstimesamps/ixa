import { createHash } from "crypto"
import { config } from "../config"
import type { NoteSection } from "./notes-markdown"

// Chunking a note for retrieval. Pure: no network, no state, no file IO.
//
// HEADING-BASED, AND THE SHAPE WAS MEASURED RATHER THAN ASSUMED. The step-1
// spike (dev/scripts/notes-spike-*, branch phase-3d-spike) compared fixed
// 300-token windows, heading-based chunks, and heading-based chunks with a
// "title > heading | type | date" prefix glued on before embedding, over 24
// notes and 19 questions. The three landed within one or two questions of each
// other. What decided it:
//
//   - The prefix LOST a top-1 (12/19 against 13/19) while buying the best
//     cross-note margin. So the metadata is kept and the gluing is not: title,
//     heading path, type, status and date go in the Qdrant payload, where they
//     can be filtered on, and only the chunk text is embedded.
//   - Small-to-big (match a chunk, return its parent section) gained NOTHING
//     and is not implemented. With the merge rule below the chunks already ARE
//     sections for 18 of 19 questions, so there is no parent to expand into.
//
// TOKENS ARE A PROXY: chars / 4. There is no tokenizer in package.json, and
// the context budget is already counted in characters by decision — "a
// tokenizer would be a dependency and a per-turn cost for an approximation
// that is good enough" (core/context-window.ts). The same reasoning applies to
// a chunk ceiling, which is a retrieval heuristic, not an API limit.

export const CHARS_PER_TOKEN = 4

export function proxyTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

export interface NoteChunk {
  ordinal: number
  // The section(s) this chunk covers, for display and for the payload.
  headingPath: string
  text: string
  hash: string
}

// Content hash, which is what makes a re-save cheap: a note rewritten with one
// section changed re-embeds one chunk. Over the TEXT only — the ordinal is
// deliberately excluded, so a section that merely moved is recognised as
// unchanged and keeps its vector.
export function chunkHash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function sectionText(section: NoteSection): string {
  return `## ${section.heading}\n\n${section.body.trim()}`
}

// A section under the floor merges forward into the next one, chaining until
// the group is big enough; a trailing runt merges backward into the previous
// group. One-line sections are the common case in Ixa's own notes and they
// retrieve badly alone: there is not enough text in "Status: active" to match
// a question against.
function groupSections(sections: NoteSection[], minTokens: number): NoteSection[][] {
  const groups: NoteSection[][] = []
  let pending: NoteSection[] = []

  for (const section of sections) {
    pending.push(section)
    if (proxyTokens(pending.map(sectionText).join("\n\n")) >= minTokens) {
      groups.push(pending)
      pending = []
    }
  }

  if (pending.length > 0) {
    if (groups.length > 0) groups[groups.length - 1]!.push(...pending)
    else groups.push(pending)
  }
  return groups
}

// A group over the ceiling splits on paragraph boundaries, greedily. Every
// part after the first REOPENS WITH THE HEADING LINE: the heading belongs to
// the section, and a chunker that dropped it from part 2 would be measuring a
// strawman. A single paragraph over the ceiling is left whole — there is no
// boundary inside it, and cutting mid-sentence to hit a number trades a
// readable chunk for a tidy histogram.
function splitGroup(groupText: string, heading: string, maxTokens: number): string[] {
  if (proxyTokens(groupText) <= maxTokens) return [groupText]

  const ceiling = maxTokens * CHARS_PER_TOKEN
  const parts: string[] = []
  let buffer = ""

  for (const paragraph of groupText.split("\n\n")) {
    if (buffer && buffer.length + 2 + paragraph.length > ceiling) {
      parts.push(buffer)
      buffer = paragraph
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    }
  }
  if (buffer) parts.push(buffer)

  const headingLine = `## ${heading}`

  // A heading line is itself a paragraph, so a section whose body is ONE
  // paragraph over the ceiling splits into ["## Heading", "<the body>"] — and
  // a chunk containing nothing but a heading is index pollution: it matches
  // the heading's words and has no answer in it. Parts with no content are
  // dropped, and the heading is then re-attached to every part that is left,
  // the FIRST one included, so nothing loses its heading either.
  const withContent = parts.filter((part) => part.replace(/^##\s+.*$/gm, "").trim().length > 0)
  if (withContent.length === 0) return [groupText]

  return withContent.map((part) =>
    part.startsWith(headingLine) ? part : `${headingLine}\n\n${part}`
  )
}

export interface ChunkLimits {
  minTokens: number
  maxTokens: number
}

export function chunkSections(
  sections: NoteSection[],
  limits: ChunkLimits = config.notes
): NoteChunk[] {
  const chunks: NoteChunk[] = []

  for (const group of groupSections(sections, limits.minTokens)) {
    const headingPath = group.map((s) => s.heading).join(" + ")
    const groupText = group.map(sectionText).join("\n\n")
    for (const text of splitGroup(groupText, group[0]!.heading, limits.maxTokens)) {
      chunks.push({
        ordinal: chunks.length,
        headingPath,
        text,
        hash: chunkHash(text),
      })
    }
  }

  return chunks
}
