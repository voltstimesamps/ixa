#!/usr/bin/env python3
"""What Kokoro will actually SAY for each fixture, as phonemes.

The companion to dev/scripts/tts-render-check.ts, which measures the audio.
Run that first — it writes Ixa-Tests/tts/fixtures.json, which this reads, so
the fixture strings exist in exactly one place:

    npx tsx dev/scripts/tts-render-check.ts
    sidecars/tts/venv/bin/python dev/scripts/tts-phonemes.py

This one DOES load misaki in-process rather than going through the sidecar, for
the same reason dev/scripts/stt-vocab-check.py loads faster-whisper in-process:
the sidecar's HTTP interface returns audio, and the question here is what the
G2P decided before the vocoder ran. It is a diagnostic, not the audio path —
the audio measurement goes through the real sidecar and must keep doing so.
misaki's G2P is what KPipeline calls internally, so these are the phonemes that
ran.

Why this is worth having. Measuring durations alone said "$1,360" renders
correctly and pointed the finger somewhere else entirely:

  - U+202F NARROW NO-BREAK SPACE and U+2011 NON-BREAKING HYPHEN, which the
    model writes constantly ("32 GB", "RTX 3080", "12-GB"), are not
    phonemized at all. They are dropped, and what they take with them is the
    word boundary — which is how a number and its unit end up fused.
  - "$1,360" and "$1360" and "one thousand three hundred sixty dollars" all
    produce identical phonemes, so the thousands comma is not the problem.
  - "$1<U+202F>200" produces "one dollar, two hundred" — a currency amount
    silently becoming a different number.

Unknown tokens and word-level differences are reported. Whether a given
rendering SOUNDS wrong is still decided by ear, from the WAVs.
"""
import json
import os
import sys

repoRoot = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ttsDir = os.path.join(repoRoot, "Ixa-Tests", "tts")
fixturesPath = os.path.join(ttsDir, "fixtures.json")
reportPath = os.path.join(ttsDir, "phonemes.md")

# The marker for a token the G2P could not phonemize.
#
# KPipeline passes unk='' (kokoro/pipeline.py:113), so in PRODUCTION an
# unpronounceable token contributes nothing at all — it is silently dropped,
# not spoken as a noise. A marker is substituted here only so the dropped
# tokens can be COUNTED and located; what the sidecar renders is the same
# string with these removed.
UNKNOWN = "❓"

# Characters worth naming when they appear in a fixture, because they are
# invisible or easily confused in a terminal.
NAMED = {
    " ": "U+202F NARROW NO-BREAK SPACE",
    " ": "U+00A0 NO-BREAK SPACE",
    " ": "U+2009 THIN SPACE",
    "‑": "U+2011 NON-BREAKING HYPHEN",
    "–": "U+2013 EN DASH",
    "—": "U+2014 EM DASH",
    "’": "U+2019 RIGHT SINGLE QUOTE",
    "≤": "U+2264 LESS-THAN OR EQUAL",
}


def visible(text):
    """Every non-ASCII character named, so a diff cannot hide in whitespace."""
    out = []
    for char in text:
        if ord(char) < 127:
            out.append(char)
        else:
            out.append(f"⟨U+{ord(char):04X}⟩")
    return "".join(out)


def main():
    if not os.path.exists(fixturesPath):
        print(f"No {fixturesPath}.")
        print("Run the audio measurement first, which writes it:")
        print("    npx tsx dev/scripts/tts-render-check.ts")
        return 1

    with open(fixturesPath, encoding="utf-8") as handle:
        fixtures = json.load(handle)

    from misaki import en, espeak

    # Built exactly as KPipeline(lang_code='a') builds it — kokoro/pipeline.py
    # lines 106-113 — including the espeak fallback, which is what keeps an
    # out-of-lexicon proper noun ("Newegg") from counting as unpronounceable.
    # Getting this wrong makes ordinary words look like failures.
    try:
        fallback = espeak.EspeakFallback(british=False)
    except Exception as err:
        print(f"  ! EspeakFallback unavailable ({err}); out-of-lexicon words will count as unknown")
        print("  ! the sidecar warns the same way, so check its log before trusting these counts")
        fallback = None
    g2p = en.G2P(trf=False, british=False, fallback=fallback, unk=UNKNOWN)

    rows = []
    for fixture in fixtures:
        # The sanitized string is what reaches the sidecar, so it is what gets
        # phonemized here too.
        text = fixture["sanitized"]
        if not text:
            rows.append((fixture, "", [], []))
            continue
        phonemes, _tokens = g2p(text)
        unknowns = phonemes.count(UNKNOWN)
        present = sorted({NAMED.get(c, f"U+{ord(c):04X}") for c in text if ord(c) > 126})
        rows.append((fixture, phonemes, unknowns, present))

    lines = []
    lines.append("# TTS phonemes")
    lines.append("")
    lines.append(
        "What misaki's G2P — the one `KPipeline` calls — produces for each "
        "fixture in `report.md`, from the same sanitized string the sidecar received."
    )
    lines.append("")
    lines.append(
        f"`{UNKNOWN}` marks a token the G2P could not phonemize. The sidecar passes "
        "`unk=''`, so in production these are **dropped silently** rather than voiced — "
        "the marker is here so they can be counted and located. What they change is the "
        "WORDS around them: see the pairs below."
    )
    lines.append("")
    lines.append("| # | Unknown | Non-ASCII in the text | Phonemes |")
    lines.append("| --- | --- | --- | --- |")
    for fixture, phonemes, unknowns, present in rows:
        count = unknowns if isinstance(unknowns, int) else 0
        mark = f"**{count}**" if count else "0"
        chars = ", ".join(present) if present else "—"
        cell = phonemes.replace("|", "\\|") if phonemes else "—"
        lines.append(f"| {fixture['id']} | {mark} | {chars} | `{cell}` |")
    lines.append("")

    # Pairs: a twin's note names its original, so differences line up without
    # the pairing being restated here.
    lines.append("## Pairs, compared")
    lines.append("")
    byId = {fixture["id"]: (fixture, phonemes) for fixture, phonemes, _u, _p in rows}
    for fixture, phonemes, _unknowns, _present in rows:
        note = fixture.get("note") or ""
        if not note.startswith("TWIN of "):
            continue
        originalId = note.split()[2]
        original = byId.get(originalId)
        if not original:
            continue
        same = original[1] == phonemes
        lines.append(f"### {originalId} → {fixture['id']}")
        lines.append("")
        lines.append(f"- {note[len('TWIN of '):]}")
        lines.append(
            f"- **Phonemes are {'IDENTICAL' if same else 'DIFFERENT'}** "
            + ("— the substitution changed nothing Kokoro can hear" if same else "")
        )
        lines.append(f"- `{originalId}` `{original[1]}`")
        lines.append(f"  - from `{visible(original[0]['sanitized'])}`")
        lines.append(f"- `{fixture['id']}` `{phonemes}`")
        lines.append(f"  - from `{visible(fixture['sanitized'])}`")
        lines.append("")

    lines.append("## Fixtures with unknown tokens")
    lines.append("")
    offenders = [(f, p, u) for f, p, u, _ in rows if isinstance(u, int) and u]
    if offenders:
        lines.append(
            "Each of these has at least one character the G2P could not pronounce. "
            "The audio is the judge of what that sounds like."
        )
        lines.append("")
        for fixture, _phonemes, unknowns in offenders:
            lines.append(f"- `{fixture['id']}` {fixture['slug']}: {unknowns} — `{fixture['file']}`")
    else:
        lines.append("None.")
    lines.append("")

    with open(reportPath, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))

    total = sum(u for _f, _p, u, _c in rows if isinstance(u, int))
    print(f"{len(rows)} fixtures phonemized, {total} unknown token(s) in total")
    for fixture, _phonemes, unknowns in offenders:
        print(f"  {fixture['id']} {fixture['slug']}: {unknowns} unknown")
    print(f"report: {reportPath}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
