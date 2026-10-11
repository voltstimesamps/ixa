import { test } from "node:test"
import assert from "node:assert/strict"
import { chunkSections, chunkHash, proxyTokens, CHARS_PER_TOKEN } from "../src/memory/note-chunks"
import {
  buildId,
  buildPath,
  parseNote,
  parseSections,
  renderNote,
  slugify,
  stampSuperseded,
  type NoteMeta,
  type NoteSection,
} from "../src/memory/notes-markdown"

// Chunking and the file format. Pure functions, so these are the cheap tests
// — and the shape they check was chosen by measurement in the step-1 spike,
// not by taste: heading-based, merge under the floor, split over the ceiling,
// and NO metadata glued into the embedded text (the prefixed variant lost a
// top-1 and won nothing that mattered).

const LIMITS = { minTokens: 150, maxTokens: 400 }

// Prose of a known length, in whole paragraphs, so a test can ask for "a
// section of about N proxy tokens" without counting characters by hand.
function paragraph(tokens: number): string {
  const word = "alpha "
  return word.repeat(Math.round((tokens * CHARS_PER_TOKEN) / word.length)).trim()
}

function section(heading: string, tokens: number): NoteSection {
  return { heading, body: paragraph(tokens) }
}

// --------------------------------------------------------------- the floor

test("sections under the floor merge forward until the group clears it", () => {
  const chunks = chunkSections(
    [section("Tiny", 20), section("Also tiny", 20), section("Big", 200)],
    LIMITS
  )
  assert.equal(chunks.length, 1, "240 proxy tokens is one group, over the floor and under the ceiling")
  assert.equal(chunks[0]!.headingPath, "Tiny + Also tiny + Big")
  for (const heading of ["## Tiny", "## Also tiny", "## Big"]) {
    assert.ok(chunks[0]!.text.includes(heading), `${heading} is in the merged chunk`)
  }
})

test("a one-line section does not become a chunk of its own", () => {
  // These retrieve badly alone: there is not enough text in "Status: active"
  // to match a question against.
  const chunks = chunkSections(
    [
      { heading: "Status", body: "Active." },
      { heading: "The decision", body: paragraph(300) },
    ],
    LIMITS
  )
  assert.equal(chunks.length, 1)
  assert.match(chunks[0]!.text, /## Status/)
})

test("a trailing runt merges backward rather than standing alone", () => {
  const chunks = chunkSections([section("Big", 200), section("Runt", 10)], LIMITS)
  assert.equal(chunks.length, 1)
  assert.match(chunks[0]!.text, /## Runt/, "the runt is carried by the previous group")
})

test("a single section over the floor stands on its own", () => {
  const chunks = chunkSections([section("One", 200), section("Two", 200)], LIMITS)
  assert.equal(chunks.length, 2)
  assert.deepEqual(
    chunks.map((c) => c.headingPath),
    ["One", "Two"]
  )
})

// ------------------------------------------------------------- the ceiling

test("a section over the ceiling splits on paragraph boundaries", () => {
  const body = [paragraph(200), paragraph(200), paragraph(200)].join("\n\n")
  const chunks = chunkSections([{ heading: "Long", body }], LIMITS)

  assert.ok(chunks.length > 1, "it splits")
  for (const chunk of chunks) {
    assert.ok(
      proxyTokens(chunk.text) <= LIMITS.maxTokens + 50,
      `each part is near the ceiling, got ${proxyTokens(chunk.text)}`
    )
  }
  // Paragraphs are never cut: every part is made of whole ones.
  const rejoined = chunks.map((c) => c.text.replace(/^## Long\n\n/, "")).join("\n\n")
  assert.equal(rejoined.includes(paragraph(200)), true)
})

test("every split part reopens with the heading line", () => {
  const body = [paragraph(200), paragraph(200), paragraph(200)].join("\n\n")
  const chunks = chunkSections([{ heading: "Long", body }], LIMITS)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.match(
      chunk.text,
      /^## Long\n/,
      "a heading-based chunker that dropped the heading from part 2 would be a strawman"
    )
  }
})

test("one paragraph over the ceiling is left whole, not cut mid-sentence", () => {
  const huge = paragraph(900)
  const chunks = chunkSections([{ heading: "Monolith", body: huge }], LIMITS)
  assert.equal(chunks.length, 1)
  assert.ok(proxyTokens(chunks[0]!.text) > LIMITS.maxTokens)
  assert.ok(chunks[0]!.text.includes(huge), "the paragraph survives intact")
})

// ---------------------------------------------------------------- hashing

test("the hash is over the text and not the position", () => {
  const first = chunkSections([section("A", 200), section("B", 200)], LIMITS)
  // Same two sections, opposite order: both hashes should already be known.
  const second = chunkSections([section("B", 200), section("A", 200)], LIMITS)

  assert.deepEqual(
    second.map((c) => c.hash).sort(),
    first.map((c) => c.hash).sort(),
    "a section that merely moved keeps its hash, so it keeps its vector"
  )
  assert.notEqual(second[0]!.ordinal, first[0]!.ordinal === 0 ? 1 : 0)
})

test("a changed body changes only that chunk's hash", () => {
  const before = chunkSections([section("A", 200), section("B", 200)], LIMITS)
  const after = chunkSections(
    [section("A", 200), { heading: "B", body: `${paragraph(200)} and one more clause.` }],
    LIMITS
  )
  assert.equal(after[0]!.hash, before[0]!.hash)
  assert.notEqual(after[1]!.hash, before[1]!.hash)
})

test("the hash is stable across calls", () => {
  assert.equal(chunkHash("the same text"), chunkHash("the same text"))
  assert.notEqual(chunkHash("the same text"), chunkHash("the same text "))
})

// --------------------------------------------------------- ids and paths

test("a slug comes from the title and is bounded", () => {
  assert.equal(slugify("Tavily replaced Brave for search"), "tavily-replaced-brave-for-search")
  assert.equal(slugify("  Mixed CASE, punctuation!  "), "mixed-case-punctuation")
  assert.equal(slugify("café"), "cafe")
  assert.ok(slugify("x".repeat(200)).length <= 60)
  assert.equal(slugify("???"), "note", "a note with an unslugglable title still gets a path")
})

test("the id carries the date, and the path is the id — the vault is flat", () => {
  const id = buildId("2026-10-10", "Tavily replaced Brave")
  assert.equal(id, "2026-10-10-tavily-replaced-brave")
  // No type anywhere in the path, for any type: the type is frontmatter.
  assert.equal(buildPath(id), `${id}.md`)
  assert.ok(!buildPath(id).includes("/"), "no subdirectory, now or by accident later")
})

// ------------------------------------------------------------ the format

const META: NoteMeta = {
  id: "2026-10-10-a-note",
  type: "decision",
  title: 'A title with: a colon, a "quote" and a #hash',
  summary: "One sentence that stands in for the facts.",
  date: "2026-10-10",
  status: "active",
  source: "voice",
  sessionId: "abc123",
}

test("frontmatter round-trips, punctuation and all", () => {
  const sections: NoteSection[] = [
    { heading: "What changed", body: "Line one.\n\nLine two: with a colon." },
    { heading: "Why", body: "Because." },
  ]
  const parsed = parseNote(renderNote(META, sections))
  assert.ok(parsed)
  assert.deepEqual(parsed.meta, META)
  assert.deepEqual(parsed.sections, sections)
})

test("a file that is not one of Ixa's notes is skipped, not guessed at", () => {
  assert.equal(parseNote("# Just a markdown file\n\nwith no frontmatter"), null)
  assert.equal(parseNote("---\nid: \"x\"\n"), null, "unterminated frontmatter")
  assert.equal(parseNote('---\nid: "x"\ntype: "poem"\n---\n'), null, "unknown type")
})

test("anything before the first heading belongs to no section", () => {
  const sections = parseSections("\n# Title\n\npreamble\n\n## Real\n\nbody\n")
  assert.deepEqual(sections, [{ heading: "Real", body: "body" }])
})

test("superseding stamps a status and a pointer and touches nothing else", () => {
  const sections: NoteSection[] = [
    { heading: "The decision", body: "Three paragraphs of reasoning." },
    { heading: "Why not the alternative", body: "Because of the measured cost." },
  ]
  const original = renderNote(META, sections)
  const stamped = stampSuperseded(original, "2026-11-01-the-replacement", "2026-11-01")
  assert.ok(stamped)

  const parsed = parseNote(stamped)
  assert.ok(parsed)
  assert.equal(parsed.meta.status, "superseded")
  assert.equal(parsed.meta.supersededBy, "2026-11-01-the-replacement")
  assert.deepEqual(
    parsed.sections,
    sections,
    "the body is the thing worth keeping: asked to supersede, the model rewrote three sections into one line"
  )
  assert.match(stamped, /> \*\*Superseded on 2026-11-01\*\*/, "a reader in Obsidian sees it too")
})
