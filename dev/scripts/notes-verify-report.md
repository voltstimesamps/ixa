# Phase 3d step 2 — verification against the real tools

Generated 2026-10-14T23:08:30.630Z by `dev/scripts/notes-verify.ts`. 32 LLM calls. web_search stubbed. Throwaway vault, database and collection.

## Routing

| # | what it tests | tools called, in order | note written | expected |
|---|---|---|---|---|
| 1 | a clear new decision: right type, specific title, searched first, nothing invented | save_note | 2026-10-14-voice-engine-decision | search_notes then save_note, type decision |
| 2 | a decision that changes an existing note: must supersede, not fork | search_notes → save_note | 2026-10-14-search-provider-update | search_notes then save_note with supersedes set to the tavily note |
| 3 | a vague request: must ask rather than write a note about nothing | **(no tool call)** | — | no save_note; ask what to write |
| 4 | a price the USER stated: recording it is faithful, sharpening it is not | save_note | 2026-10-14-homelab-gpu-budget | save_note; the figure matches what the user said; a dated caveat is added by code |
| 5 | really a preference: must route to remember_preference, not save_note | remember_preference | — | remember_preference only |
| 6 | a duplicate of a note already written: must not write a second one | save_note | 2026-10-14-groq-dev-tier-status | search_notes; then either no write or a supersede, never a second active note |
| 7 | a reference fact not in the notebook: right type and a retrievable title | save_note | 2026-10-14-backend-environment-note | save_note, type reference |
| 8 | a project fact with a vague cost claim and no number: must not supply a number | save_note → save_note | 2026-10-14-homelab-gpu-plan | save_note with NO invented figure |
| 9 | mis-heard model names: must not write 'quadrant' and 'alama' into the notebook | save_note | 2026-10-14-vector-and-embedding-configuration | the correct spellings, or a question — not the mis-heard ones |
| 10 | a price with NO number given: must search before recording a figure | web_search → save_note | 2026-10-14-used-rtx-3090-price-note | web_search before save_note; only searched figures in the note |
| 11 | ROUTING: a genuine preference must still reach remember_preference | remember_preference | — | remember_preference |
| 12 | ROUTING: 'remember' plus a FACT must reach save_note | save_note | 2026-10-14-stt-sidecar-model-note | save_note |
| 13 | ROUTING: a question about a past CONVERSATION must reach search_memory | search_memory | — | search_memory with no query |
| 14 | ROUTING: a question about something written down must reach search_notes | search_notes | — | search_notes |
| 15 | ROUTING: a behaviour instruction phrased as a note must stay a preference | remember_preference | — | remember_preference, not save_note |

## Preferences actually stored

- `answer_length`: short, two sentences max
- `coffee`: black
- `metric_units`: Always answer in metric units.

## Every request, verbatim

### Request 1

**Testing:** a clear new decision: right type, specific title, searched first, nothing invented

**User said:**

> so we decided we're going with kokoro for the voice instead of piper, write that down somewhere

1. `save_note`

```json
{"sections":[{"body":"We have decided to use Kokoro instead of Piper for the voice component.","heading":"Voice Engine Decision"}],"summary":"Voice engine switched to Kokoro","title":"Voice Engine Decision","type":"DECISION"}
```

```
Saved decision note "Voice Engine Decision" (id 2026-10-14-voice-engine-decision).
Summary on disk: Voice engine switched to Kokoro
Body on disk: We have decided to use Kokoro instead of Piper for the voice component.
You already have 2 note(s) that may cover this subject:
  - id 2026-09-01-tavily-is-the-search-provider — "Tavily is the search provider": Web search goes through Tavily. Brave was evaluated and never wired in.
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in on
```

**What it said to the user:**

> I have saved the decision note.  
> We have decided to use Kokoro instead of Piper for the voice component.

**Note written — `2026-10-14-voice-engine-decision`:**

```markdown
---
id: "2026-10-14-voice-engine-decision"
type: "decision"
title: "Voice Engine Decision"
summary: "Voice engine switched to Kokoro"
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-1"
---

# Voice Engine Decision

## Voice Engine Decision

We have decided to use Kokoro instead of Piper for the voice component.

```

### Request 2

**Testing:** a decision that changes an existing note: must supersede, not fork

**User said:**

> actually scratch that, we're moving off tavily to a self-hosted searx thing, update the note

1. `search_notes`

```json
{"query":"searx"}
```

```
3 note(s) closest to that, best first:
1. [decision] "Voice Engine Decision" — id 2026-10-14-voice-engine-decision, 2026-10-14 (Voice Engine Decision)
   Voice engine switched to Kokoro
   ---
## Voice Engine Decision

We have decided to use Kokoro instead of Piper for the voice component.

2. [decision] "Tavily is the search provider" — id 2026-09-01-tavily-is-the-search-provider, 2026-09-01 (The choice + Why not Brave)
   Web search goes through Tavily. Brave was evaluated and never wired in.
   ---
## The choice

Tavily returns extracted content rather than links.

## Why not Brave

It was evaluated and dropped before any code shipped.

3. [decision] "Ixa is on the Groq Dev tier" — id 2026-09-15-ixa-is-on-the-groq-dev-tier, 2026-09-15 (The decision)
   Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
   ---
## The decision

The paid Dev tier was ch
```

2. `save_note`

```json
{"sections":[{"body":"We are moving from Tavily to a self-hosted Searx instance for web search. The new Searx instance will replace Tavily in all search queries.","heading":"Search Provider Update"}],"summary":"Switch from Tavily to self-hosted Searx for web search","title":"Search Provider Update","type":"decision"}
```

```
Saved decision note "Search Provider Update" (id 2026-10-14-search-provider-update).
Summary on disk: Switch from Tavily to self-hosted Searx for web search
You already have 2 note(s) that may cover this subject:
  - id 2026-09-01-tavily-is-the-search-provider — "Tavily is the search provider": Web search goes through Tavily. Brave was evaluated and never wired in.
  - id 2026-10-14-voice-engine-decision — "Voice Engine Decision": Voice engine switched to Kokoro
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
This note is too long to read back in a spoken reply. Tell the user in one short sentence what you saved, using the title and the summary above, a
```

**What it said to the user:**

> I’ve saved a decision note titled “Search Provider Update”: it records that we’re switching from Tavily to a self‑hosted Searx instance for all web searches. The note is a bit long, so let me know if you’d like any part of it read back.

**Note written — `2026-10-14-search-provider-update`:**

```markdown
---
id: "2026-10-14-search-provider-update"
type: "decision"
title: "Search Provider Update"
summary: "Switch from Tavily to self-hosted Searx for web search"
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-2"
---

# Search Provider Update

## Search Provider Update

We are moving from Tavily to a self-hosted Searx instance for web search. The new Searx instance will replace Tavily in all search queries.

```

### Request 3

**Testing:** a vague request: must ask rather than write a note about nothing

**User said:**

> note that down would you

**No tool call.**

**What it said to the user:**

> Sure, what would you like me to note down?

### Request 4

**Testing:** a price the USER stated: recording it is faithful, sharpening it is not

**User said:**

> note down that a used 3090 is going for like six hundred bucks now so that's the plan for the homelab

1. `save_note`

```json
{"sections":[{"body":"A used RTX 3090 is currently priced around $600. This will be the GPU for the homelab.","heading":"GPU Purchase Plan"}],"summary":"Used RTX 3090 priced at $600 for homelab GPU","title":"Homelab GPU Budget","type":"FACT"}
```

```
Saved reference note "Homelab GPU Budget" (id 2026-10-14-homelab-gpu-budget).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: Used RTX 3090 priced at $600 for homelab GPU
Body on disk: A used RTX 3090 is currently priced around $600. This will be the GPU for the homelab.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-14-voice-engine-decision — "Voice Engine Decision": Voice engine switched to Kokoro
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active
```

**What it said to the user:**

> Saved reference note "Homelab GPU Budget" (id 2026-10-14-homelab-gpu-budget).  
> A used RTX 3090 is currently priced around $600. This will be the GPU for the homelab.

**Note written — `2026-10-14-homelab-gpu-budget`:**

```markdown
---
id: "2026-10-14-homelab-gpu-budget"
type: "reference"
title: "Homelab GPU Budget"
summary: "Used RTX 3090 priced at $600 for homelab GPU"
date: "2026-10-14"
status: "superseded"
superseded_by: "2026-10-14-homelab-gpu-plan"
source: "voice"
session: "verify-4"
---

# Homelab GPU Budget

> **Superseded on 2026-10-14** by `2026-10-14-homelab-gpu-plan`. Kept for the record.

## GPU Purchase Plan

A used RTX 3090 is currently priced around $600. This will be the GPU for the homelab.

_Prices as stated on 2026-10-14; they may be out of date._

```

### Request 5

**Testing:** really a preference: must route to remember_preference, not save_note

**User said:**

> from now on keep your spoken answers really short, like two sentences max

1. `remember_preference`

```json
{"category":"general","topic":"answer_length","value":"short, two sentences max"}
```

```
Saved new preference [general] answer_length: short, two sentences max.
```

**What it said to the user:**

> Got it—I'll keep my replies to two sentences or fewer.

### Request 6

**Testing:** a duplicate of a note already written: must not write a second one

**User said:**

> make a note that we're on the groq dev tier now

1. `save_note`

```json
{"sections":[{"body":"We are currently on the Groq dev tier.","heading":"Groq Dev Tier"}],"summary":"We are on the Groq dev tier.","title":"Groq Dev Tier Status","type":"FACT"}
```

```
Saved reference note "Groq Dev Tier Status" (id 2026-10-14-groq-dev-tier-status).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: We are on the Groq dev tier.
Body on disk: We are currently on the Groq dev tier.
You already have 2 note(s) that may cover this subject:
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
  - id 2026-10-14-search-provider-update — "Search Provider Update": Switch from Tavily to self-hosted Searx for web search
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same
```

**What it said to the user:**

> I saved a note.  
> We are currently on the Groq dev tier.

**Note written — `2026-10-14-groq-dev-tier-status`:**

```markdown
---
id: "2026-10-14-groq-dev-tier-status"
type: "reference"
title: "Groq Dev Tier Status"
summary: "We are on the Groq dev tier."
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-6"
---

# Groq Dev Tier Status

## Groq Dev Tier

We are currently on the Groq dev tier.

```

### Request 7

**Testing:** a reference fact not in the notebook: right type and a retrievable title

**User said:**

> write down that the backend lives in wsl2 on the gaming pc, the windows side doesn't run anything

1. `save_note`

```json
{"sections":[{"body":"The backend runs in WSL2 on the gaming PC. The Windows side does not run any backend services.","heading":"Backend Environment"}],"summary":"Backend runs in WSL2 on gaming PC, Windows side idle.","title":"Backend Environment Note","type":"FACT"}
```

```
Saved reference note "Backend Environment Note" (id 2026-10-14-backend-environment-note).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: Backend runs in WSL2 on gaming PC, Windows side idle.
Body on disk: The backend runs in WSL2 on the gaming PC. The Windows side does not run any backend services.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-14-search-provider-update — "Search Provider Update": Switch from Tavily to self-hosted Searx for web search
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks
```

**What it said to the user:**

> I saved the note.  
> The backend runs in WSL2 on the gaming PC. The Windows side does not run any backend services.

**Note written — `2026-10-14-backend-environment-note`:**

```markdown
---
id: "2026-10-14-backend-environment-note"
type: "reference"
title: "Backend Environment Note"
summary: "Backend runs in WSL2 on gaming PC, Windows side idle."
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-7"
---

# Backend Environment Note

## Backend Environment

The backend runs in WSL2 on the gaming PC. The Windows side does not run any backend services.

```

### Request 8

**Testing:** a project fact with a vague cost claim and no number: must not supply a number

**User said:**

> the homelab plan is a 24 gig card eventually, it's gonna be expensive, note it

1. `save_note`

```json
{"sections":[{"body":"The user plans to eventually use a 24 GB GPU card for their homelab. This will be expensive.","heading":"Homelab GPU Plan"}],"summary":"User intends to use a 24 GB GPU card in their homelab, which will be costly.","title":"Homelab GPU Plan","type":"FACT"}
```

```
Saved reference note "Homelab GPU Plan" (id 2026-10-14-homelab-gpu-plan).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: User intends to use a 24 GB GPU card in their homelab, which will be costly.
Body on disk: The user plans to eventually use a 24 GB GPU card for their homelab. This will be expensive.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-14-homelab-gpu-budget — "Homelab GPU Budget": Used RTX 3090 priced at $600 for homelab GPU
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one 
```

2. `save_note`

```json
{"sections":[{"body":"The user plans to eventually use a 24 GB GPU card for their homelab. This will be expensive.","heading":"Homelab GPU Plan"}],"summary":"User intends to use a 24 GB GPU card in their homelab, which will be costly.","supersedes":"2026-10-14-homelab-gpu-budget","title":"Homelab GPU Plan","type":"FACT"}
```

```
Saved reference note "Homelab GPU Plan" (id 2026-10-14-homelab-gpu-plan).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: User intends to use a 24 GB GPU card in their homelab, which will be costly.
Body on disk: The user plans to eventually use a 24 GB GPU card for their homelab. This will be expensive.
Superseded "Homelab GPU Budget" (id 2026-10-14-homelab-gpu-budget); its text is kept and marked superseded.
You already have 2 note(s) that may cover this subject:
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
  - id 2026-10-14-voice-engine-decision — "Voice Engine Decision": Voice engine switched to Kokoro
If one of them is about the same thing as what you just saved, the two will disagree late
```

**What it said to the user:**

> I saved the note: “The user plans to eventually use a 24 GB GPU card for their homelab. This will be expensive.”

**Note written — `2026-10-14-homelab-gpu-plan`:**

```markdown
---
id: "2026-10-14-homelab-gpu-plan"
type: "reference"
title: "Homelab GPU Plan"
summary: "User intends to use a 24 GB GPU card in their homelab, which will be costly."
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-8"
---

# Homelab GPU Plan

## Homelab GPU Plan

The user plans to eventually use a 24 GB GPU card for their homelab. This will be expensive.

```

### Request 9

**Testing:** mis-heard model names: must not write 'quadrant' and 'alama' into the notebook

**User said:**

> note down that we're using quadrant for the vectors and alama for the embeddings

1. `save_note`

```json
{"sections":[{"body":"We are using Quadrant for vector operations and Alama for embeddings.","heading":"Vector and Embedding Setup"}],"summary":"Using Quadrant for vectors and Alama for embeddings","title":"Vector and Embedding Configuration","type":"FACT"}
```

```
Saved reference note "Vector and Embedding Configuration" (id 2026-10-14-vector-and-embedding-configuration).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: Using Quadrant for vectors and Alama for embeddings
Body on disk: We are using Quadrant for vector operations and Alama for embeddings.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-14-voice-engine-decision — "Voice Engine Decision": Voice engine switched to Kokoro
  - id 2026-10-14-search-provider-update — "Search Provider Update": Switch from Tavily to self-hosted Searx for web search
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them i
```

**What it said to the user:**

> I saved the note: "We are using Quadrant for vector operations and Alama for embeddings."

**Note written — `2026-10-14-vector-and-embedding-configuration`:**

```markdown
---
id: "2026-10-14-vector-and-embedding-configuration"
type: "reference"
title: "Vector and Embedding Configuration"
summary: "Using Quadrant for vectors and Alama for embeddings"
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-9"
---

# Vector and Embedding Configuration

## Vector and Embedding Setup

We are using Quadrant for vector operations and Alama for embeddings.

```

### Request 10

**Testing:** a price with NO number given: must search before recording a figure

**User said:**

> find out what a used 3090 costs right now and write it down

1. `web_search`

```json
{"count":5,"query":"used RTX 3090 price"}
```

```
Search results for used RTX 3090 pricing:
1. eBay — sold listings for the RTX 3090 cluster around $1,360 shipped.
2. r/hardwareswap — recent sales between $1,250 and $1,420.
3. Newegg — no new stock; refurbished units listed at $1,499.
```

2. `save_note`

```json
{"sections":[{"body":"Current used RTX 3090 prices are around $1,250–$1,420 based on recent eBay and Reddit listings.","heading":"Used RTX 3090 price"}],"summary":"Used RTX 3090 costs roughly $1,250–$1,420.","title":"Used RTX 3090 price note","type":"FACT"}
```

```
Saved reference note "Used RTX 3090 price note" (id 2026-10-14-used-rtx-3090-price-note).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: Used RTX 3090 costs roughly $1,250–$1,420.
Body on disk: Current used RTX 3090 prices are around $1,250–$1,420 based on recent eBay and Reddit listings.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-14-homelab-gpu-plan — "Homelab GPU Plan": User intends to use a 24 GB GPU card in their homelab, which will be costly.
  - id 2026-10-14-voice-engine-decision — "Voice Engine Decision": Voice engine switched to Kokoro
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of
```

**What it said to the user:**

> I saved a note.  
> Current used RTX 3090 prices are around $1,250–$1,420 based on recent eBay and Reddit listings.

**Note written — `2026-10-14-used-rtx-3090-price-note`:**

```markdown
---
id: "2026-10-14-used-rtx-3090-price-note"
type: "reference"
title: "Used RTX 3090 price note"
summary: "Used RTX 3090 costs roughly $1,250–$1,420."
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-10"
---

# Used RTX 3090 price note

## Used RTX 3090 price

Current used RTX 3090 prices are around $1,250–$1,420 based on recent eBay and Reddit listings.

_Prices as stated on 2026-10-14; they may be out of date._

```

### Request 11

**Testing:** ROUTING: a genuine preference must still reach remember_preference

**User said:**

> i prefer my coffee black, remember that

1. `remember_preference`

```json
{"category":"food","topic":"coffee","value":"black"}
```

```
Saved new preference [food] coffee: black.
```

**What it said to the user:**

> Got it—your coffee is black.

### Request 12

**Testing:** ROUTING: 'remember' plus a FACT must reach save_note

**User said:**

> remember that the stt sidecar uses base.en, not small

1. `save_note`

```json
{"sections":[{"body":"The STT sidecar uses the base.en model, not the small model.","heading":"STT Sidecar Configuration"}],"summary":"STT sidecar uses base.en model","title":"STT Sidecar Model Note","type":"FACT"}
```

```
Saved reference note "STT Sidecar Model Note" (id 2026-10-14-stt-sidecar-model-note).
'type' was "FACT", which is not one of decision, project, reference, so this was saved as a reference note.
Summary on disk: STT sidecar uses base.en model
Body on disk: The STT sidecar uses the base.en model, not the small model.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-14-backend-environment-note — "Backend Environment Note": Backend runs in WSL2 on gaming PC, Windows side idle.
  - id 2026-10-14-voice-engine-decision — "Voice Engine Decision": Voice engine switched to Kokoro
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user 
```

**What it said to the user:**

> I saved the note.  
> The STT sidecar uses the base.en model, not the small model.

**Note written — `2026-10-14-stt-sidecar-model-note`:**

```markdown
---
id: "2026-10-14-stt-sidecar-model-note"
type: "reference"
title: "STT Sidecar Model Note"
summary: "STT sidecar uses base.en model"
date: "2026-10-14"
status: "active"
source: "voice"
session: "verify-12"
---

# STT Sidecar Model Note

## STT Sidecar Configuration

The STT sidecar uses the base.en model, not the small model.

```

### Request 13

**Testing:** ROUTING: a question about a past CONVERSATION must reach search_memory

**User said:**

> what did we talk about last time?

1. `search_memory`

```json
{"query":null}
```

```
Memory search is unavailable right now (the vector index or embedding service is not reachable). Tell the user you cannot search your memory at the moment rather than guessing at what was discussed.
```

**What it said to the user:**

> I’m sorry, but I can’t access my memory right now.

### Request 14

**Testing:** ROUTING: a question about something written down must reach search_notes

**User said:**

> what did i write down about the search provider?

1. `search_notes`

```json
{"query":"search provider"}
```

```
3 note(s) closest to that, best first:
1. [decision] "Search Provider Update" — id 2026-10-14-search-provider-update, 2026-10-14 (Search Provider Update)
   Switch from Tavily to self-hosted Searx for web search
   ---
## Search Provider Update

We are moving from Tavily to a self-hosted Searx instance for web search. The new Searx instance will replace Tavily in all search queries.

2. [decision] "Ixa is on the Groq Dev tier" — id 2026-09-15-ixa-is-on-the-groq-dev-tier, 2026-09-15 (The decision)
   Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
   ---
## The decision

The paid Dev tier was chosen over migrating to a local LLM for now.

3. [decision] "Tavily is the search provider" — id 2026-09-01-tavily-is-the-search-provider, 2026-09-01 (The choice + Why not Brave)
   Web search goes through Tavily. Brave was evaluated and never wired in.
   ---
#
```

**What it said to the user:**

> You wrote down a note titled **“Search Provider Update”** (id 2026‑10‑14‑search-provider-update). It states:
> 
> > **Search Provider Update**  
> > We are moving from Tavily to a self‑hosted Searx instance for web search. The new Searx instance will replace Tavily in all search queries.

### Request 15

**Testing:** ROUTING: a behaviour instruction phrased as a note must stay a preference

**User said:**

> make a note to always answer in metric

1. `remember_preference`

```json
{"category":"general","topic":"metric_units","value":"Always answer in metric units."}
```

```
Saved new preference [general] metric_units: Always answer in metric units..
```

**What it said to the user:**

> Got it—I'll use metric units in all responses.
