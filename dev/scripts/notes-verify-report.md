# Phase 3d step 2 — verification against the real tools

Generated 2026-10-11T02:18:47.125Z by `dev/scripts/notes-verify.ts`. 38 LLM calls. web_search stubbed. Throwaway vault, database and collection.

## Routing

| # | what it tests | tools called, in order | note written | expected |
|---|---|---|---|---|
| 1 | a clear new decision: right type, specific title, searched first, nothing invented | search_notes → save_note | 2026-10-10-tavily-search-provider-decision | search_notes then save_note, type decision |
| 2 | a decision that changes an existing note: must supersede, not fork | search_notes → save_note | 2026-10-10-tavily-search-provider-decision-updated | search_notes then save_note with supersedes set to the tavily note |
| 3 | a vague request: must ask rather than write a note about nothing | **(no tool call)** | — | no save_note; ask what to write |
| 4 | a price the USER stated: recording it is faithful, sharpening it is not | search_notes → save_note | 2026-10-10-homelab-gpu-budget | save_note; the figure matches what the user said; a dated caveat is added by code |
| 5 | really a preference: must route to remember_preference, not save_note | remember_preference | — | remember_preference only |
| 6 | a duplicate of a note already written: must not write a second one | save_note → save_note → save_note | 2026-10-10-groq-dev-tier-status | search_notes; then either no write or a supersede, never a second active note |
| 7 | a reference fact not in the notebook: right type and a retrievable title | save_note → save_note | 2026-10-10-backend-environment | save_note, type reference |
| 8 | a project fact with a vague cost claim and no number: must not supply a number | save_note → save_note | 2026-10-10-homelab-gpu-plan | save_note with NO invented figure |
| 9 | mis-heard model names: must not write 'quadrant' and 'alama' into the notebook | save_note | — | the correct spellings, or a question — not the mis-heard ones |
| 10 | a price with NO number given: must search before recording a figure | web_search → save_note → save_note | 2026-10-10-used-rtx-3090-price | web_search before save_note; only searched figures in the note |
| 11 | ROUTING: a genuine preference must still reach remember_preference | remember_preference | — | remember_preference |
| 12 | ROUTING: 'remember' plus a FACT must reach save_note | remember_preference | — | save_note |
| 13 | ROUTING: a question about a past CONVERSATION must reach search_memory | search_memory | — | search_memory with no query |
| 14 | ROUTING: a question about something written down must reach search_notes | search_notes | — | search_notes |
| 15 | ROUTING: a behaviour instruction phrased as a note must stay a preference | remember_preference | — | remember_preference, not save_note |

## Preferences actually stored

- `answer_length`: keep answers short, two sentences max
- `coffee`: black
- `stt_sidecar_model`: base.en
- `unit system`: Always answer in metric units

## Every request, verbatim

### Request 1

**Testing:** a clear new decision: right type, specific title, searched first, nothing invented

**User said:**

> so we decided we're going with tavily for search instead of brave, write that down somewhere

1. `search_notes`

```json
{"query":"tavily search instead of brave"}
```

```
2 note(s) closest to that, best first:
1. [decision] "Tavily is the search provider" — id 2026-09-01-tavily-is-the-search-provider, 2026-09-01 (The choice + Why not Brave)
   Web search goes through Tavily. Brave was evaluated and never wired in.
   ---
## The choice

Tavily returns extracted content rather than links.

## Why not Brave

It was evaluated and dropped before any code shipped.

2. [decision] "Ixa is on the Groq Dev tier" — id 2026-09-15-ixa-is-on-the-groq-dev-tier, 2026-09-15 (The decision)
   Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
   ---
## The decision

The paid Dev tier was chosen over migrating to a local LLM for now.

These are the closest matches by meaning, not necessarily answers — a note may be here only because it is the nearest thing you have written. Use one only if it actually addresses the question, and say you ha
```

2. `save_note`

```json
{"sections":[{"body":"We decided to use Tavily for search instead of Brave.","heading":"Decision"}],"summary":"Decision to use Tavily for search instead of Brave.","supersedes":"2026-09-01-tavily-is-the-search-provider","title":"Tavily search provider decision","type":"decision"}
```

```
Saved decision note "Tavily search provider decision" (id 2026-10-10-tavily-search-provider-decision).
Summary on disk: Decision to use Tavily for search instead of Brave.
Superseded "Tavily is the search provider" (id 2026-09-01-tavily-is-the-search-provider); its text is kept and marked superseded.
You already have 1 note(s) that may cover this subject:
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in one short sentence what you saved, using the title above.
```

**What it said to the user:**

> I’ve saved the decision as “Tavily search provider decision.”

**Note written — `2026-10-10-tavily-search-provider-decision`:**

```markdown
---
id: "2026-10-10-tavily-search-provider-decision-updated"
type: "decision"
title: "Tavily search provider decision updated"
summary: "Decision to switch from Tavily to self-hosted Searx for search."
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-2"
---

# Tavily search provider decision updated

## Decision

We are moving from Tavily to a self-hosted Searx instance for search queries. This replaces the previous decision to use Tavily.

```

### Request 2

**Testing:** a decision that changes an existing note: must supersede, not fork

**User said:**

> actually scratch that, we're moving off tavily to a self-hosted searx thing, update the note

1. `search_notes`

```json
{"query":"Tavily"}
```

```
2 note(s) closest to that, best first:
1. [decision] "Tavily search provider decision" — id 2026-10-10-tavily-search-provider-decision, 2026-10-10 (Decision)
   Decision to use Tavily for search instead of Brave.
   ---
## Decision

We decided to use Tavily for search instead of Brave.

2. [decision] "Ixa is on the Groq Dev tier" — id 2026-09-15-ixa-is-on-the-groq-dev-tier, 2026-09-15 (The decision)
   Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
   ---
## The decision

The paid Dev tier was chosen over migrating to a local LLM for now.

These are the closest matches by meaning, not necessarily answers — a note may be here only because it is the nearest thing you have written. Use one only if it actually addresses the question, and say you have nothing written down if none of them do.
```

2. `save_note`

```json
{"sections":[{"body":"We are moving from Tavily to a self-hosted Searx instance for search queries. This replaces the previous decision to use Tavily.","heading":"Decision"}],"summary":"Decision to switch from Tavily to self-hosted Searx for search.","supersedes":"2026-10-10-tavily-search-provider-decision","title":"Tavily search provider decision updated","type":"decision"}
```

```
Saved decision note "Tavily search provider decision updated" (id 2026-10-10-tavily-search-provider-decision-updated).
Summary on disk: Decision to switch from Tavily to self-hosted Searx for search.
Superseded "Tavily search provider decision" (id 2026-10-10-tavily-search-provider-decision); its text is kept and marked superseded.
You already have 1 note(s) that may cover this subject:
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in one short sentence what you saved, using 
```

**What it said to the user:**

> Saved decision note “Tavily search provider decision updated”.

**Note written — `2026-10-10-tavily-search-provider-decision-updated`:**

```markdown
---
id: "2026-10-10-tavily-search-provider-decision-updated"
type: "decision"
title: "Tavily search provider decision updated"
summary: "Decision to switch from Tavily to self-hosted Searx for search."
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-2"
---

# Tavily search provider decision updated

## Decision

We are moving from Tavily to a self-hosted Searx instance for search queries. This replaces the previous decision to use Tavily.

```

### Request 3

**Testing:** a vague request: must ask rather than write a note about nothing

**User said:**

> note that down would you

**No tool call.**

**What it said to the user:**

> Sure! What would you like me to note down?

### Request 4

**Testing:** a price the USER stated: recording it is faithful, sharpening it is not

**User said:**

> note down that a used 3090 is going for like six hundred bucks now so that's the plan for the homelab

1. `search_notes`

```json
{"query":"3090"}
```

```
2 note(s) closest to that, best first:
1. [decision] "Tavily search provider decision updated" — id 2026-10-10-tavily-search-provider-decision-updated, 2026-10-10 (Decision)
   Decision to switch from Tavily to self-hosted Searx for search.
   ---
## Decision

We are moving from Tavily to a self-hosted Searx instance for search queries. This replaces the previous decision to use Tavily.

2. [decision] "Ixa is on the Groq Dev tier" — id 2026-09-15-ixa-is-on-the-groq-dev-tier, 2026-09-15 (The decision)
   Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
   ---
## The decision

The paid Dev tier was chosen over migrating to a local LLM for now.

These are the closest matches by meaning, not necessarily answers — a note may be here only because it is the nearest thing you have written. Use one only if it actually addresses the question, and say you have n
```

2. `save_note`

```json
{"sections":[{"body":"A used RTX 3090 is currently priced around $600. This will be the GPU for the homelab.","heading":"Homelab GPU Budget"}],"summary":"Used RTX 3090 price ~600 USD for homelab GPU","title":"Homelab GPU budget","type":"decision"}
```

```
Saved decision note "Homelab GPU budget" (id 2026-10-10-homelab-gpu-budget).
Summary on disk: Used RTX 3090 price ~600 USD for homelab GPU
You already have 2 note(s) that may cover this subject:
  - id 2026-10-10-tavily-search-provider-decision-updated — "Tavily search provider decision updated": Decision to switch from Tavily to self-hosted Searx for search.
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
A dated price caveat was added to the note automatically.
Tell the user in one short s
```

**What it said to the user:**

> I’ve saved the decision note “Homelab GPU budget.”

**Note written — `2026-10-10-homelab-gpu-budget`:**

```markdown
---
id: "2026-10-10-homelab-gpu-budget"
type: "decision"
title: "Homelab GPU budget"
summary: "Used RTX 3090 price ~600 USD for homelab GPU"
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-4"
---

# Homelab GPU budget

## Homelab GPU Budget

A used RTX 3090 is currently priced around $600. This will be the GPU for the homelab.

_Prices as stated on 2026-10-10; they may be out of date._

```

### Request 5

**Testing:** really a preference: must route to remember_preference, not save_note

**User said:**

> from now on keep your spoken answers really short, like two sentences max

1. `remember_preference`

```json
{"category":"communication","topic":"answer_length","value":"keep answers short, two sentences max"}
```

```
Saved new preference [communication] answer_length: keep answers short, two sentences max.
```

**What it said to the user:**

> Got it. I'll keep my responses to two sentences or fewer.

### Request 6

**Testing:** a duplicate of a note already written: must not write a second one

**User said:**

> make a note that we're on the groq dev tier now

1. `save_note`

```json
{"sections":[{"body":"We are currently using the Groq dev tier.","heading":"Groq Dev Tier"}],"summary":"User is on Groq dev tier.","title":"Groq dev tier status","type":"FACT"}
```

```
Nothing was saved: 'type' must be one of decision, project, reference.
```

2. `save_note`

```json
{"sections":[{"body":"We are currently using the Groq dev tier.","heading":"Groq Dev Tier"}],"summary":"User is on Groq dev tier.","title":"Groq dev tier status","type":"reference"}
```

```
Saved reference note "Groq dev tier status" (id 2026-10-10-groq-dev-tier-status).
Summary on disk: User is on Groq dev tier.
You already have 2 note(s) that may cover this subject:
  - id 2026-09-15-ixa-is-on-the-groq-dev-tier — "Ixa is on the Groq Dev tier": Ixa runs on the Groq Dev tier, so the free tier's daily cap no longer blocks testing.
  - id 2026-10-10-tavily-search-provider-decision-updated — "Tavily search provider decision updated": Decision to switch from Tavily to self-hosted Searx for search.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in one short sentence what you saved, using the title above.
```

3. `save_note`

```json
{"sections":[{"body":"We are currently using the Groq dev tier.","heading":"Groq Dev Tier"}],"summary":"User is on Groq dev tier.","supersedes":"2026-09-15-ixa-is-on-the-groq-dev-tier","title":"Groq dev tier status","type":"reference"}
```

```
Saved reference note "Groq dev tier status" (id 2026-10-10-groq-dev-tier-status).
Summary on disk: User is on Groq dev tier.
Superseded "Ixa is on the Groq Dev tier" (id 2026-09-15-ixa-is-on-the-groq-dev-tier); its text is kept and marked superseded.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-10-tavily-search-provider-decision-updated — "Tavily search provider decision updated": Decision to switch from Tavily to self-hosted Searx for search.
  - id 2026-10-10-homelab-gpu-budget — "Homelab GPU budget": Used RTX 3090 price ~600 USD for homelab GPU
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in one short senten
```

**What it said to the user:**

> Saved reference note "Groq dev tier status".

**Note written — `2026-10-10-groq-dev-tier-status`:**

```markdown
---
id: "2026-10-10-groq-dev-tier-status"
type: "reference"
title: "Groq dev tier status"
summary: "User is on Groq dev tier."
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-6"
---

# Groq dev tier status

## Groq Dev Tier

We are currently using the Groq dev tier.

```

### Request 7

**Testing:** a reference fact not in the notebook: right type and a retrievable title

**User said:**

> write down that the backend lives in wsl2 on the gaming pc, the windows side doesn't run anything

1. `save_note`

```json
{"sections":[{"body":"The backend runs in WSL2 on the gaming PC. The Windows side does not run any services.","heading":"Backend Environment"}],"summary":"Backend runs in WSL2 on gaming PC; Windows side idle.","title":"Backend environment","type":"FACT"}
```

```
Nothing was saved: 'type' must be one of decision, project, reference.
```

2. `save_note`

```json
{"sections":[{"body":"The backend runs in WSL2 on the gaming PC. The Windows side does not run any services.","heading":"Backend Environment"}],"summary":"Backend runs in WSL2 on gaming PC; Windows side idle.","title":"Backend environment","type":"reference"}
```

```
Saved reference note "Backend environment" (id 2026-10-10-backend-environment).
Summary on disk: Backend runs in WSL2 on gaming PC; Windows side idle.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-10-tavily-search-provider-decision-updated — "Tavily search provider decision updated": Decision to switch from Tavily to self-hosted Searx for search.
  - id 2026-10-10-groq-dev-tier-status — "Groq dev tier status": User is on Groq dev tier.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in one short sentence what you saved, using the title above.
```

**What it said to the user:**

> Saved reference note “Backend environment.”

**Note written — `2026-10-10-backend-environment`:**

```markdown
---
id: "2026-10-10-backend-environment"
type: "reference"
title: "Backend environment"
summary: "Backend runs in WSL2 on gaming PC; Windows side idle."
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-7"
---

# Backend environment

## Backend Environment

The backend runs in WSL2 on the gaming PC. The Windows side does not run any services.

```

### Request 8

**Testing:** a project fact with a vague cost claim and no number: must not supply a number

**User said:**

> the homelab plan is a 24 gig card eventually, it's gonna be expensive, note it

1. `save_note`

```json
{"sections":[{"body":"The plan is to eventually use a 24 GB GPU for the homelab. This will be expensive.","heading":"Homelab GPU plan"}],"summary":"Plan to eventually use a 24 GB GPU, which will be expensive.","title":"Homelab GPU plan","type":"note"}
```

```
Nothing was saved: 'type' must be one of decision, project, reference.
```

2. `save_note`

```json
{"sections":[{"body":"The plan is to eventually use a 24 GB GPU for the homelab. This will be expensive.","heading":"Homelab GPU plan"}],"summary":"Plan to eventually use a 24 GB GPU, which will be expensive.","title":"Homelab GPU plan","type":"project"}
```

```
Saved project note "Homelab GPU plan" (id 2026-10-10-homelab-gpu-plan).
Summary on disk: Plan to eventually use a 24 GB GPU, which will be expensive.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-10-homelab-gpu-budget — "Homelab GPU budget": Used RTX 3090 price ~600 USD for homelab GPU
  - id 2026-10-10-tavily-search-provider-decision-updated — "Tavily search provider decision updated": Decision to switch from Tavily to self-hosted Searx for search.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
Tell the user in one short sentence what you saved, using the title above.
```

**What it said to the user:**

> (nothing)

**Note written — `2026-10-10-homelab-gpu-plan`:**

```markdown
---
id: "2026-10-10-homelab-gpu-plan"
type: "project"
title: "Homelab GPU plan"
summary: "Plan to eventually use a 24 GB GPU, which will be expensive."
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-8"
---

# Homelab GPU plan

## Homelab GPU plan

The plan is to eventually use a 24 GB GPU for the homelab. This will be expensive.

```

### Request 9

**Testing:** mis-heard model names: must not write 'quadrant' and 'alama' into the notebook

**User said:**

> note down that we're using quadrant for the vectors and alama for the embeddings

**ERROR:** Failed to parse tool call arguments as JSON

1. `save_note`

```json
{"sections":[{"body":"We are using Quadrant for vector operations and Alama for embeddings.","heading":"Vector and Embedding Libraries"}],"summary":"Quadrant for vectors, Alama for embeddings.","title":"Vector and Embedding Libraries","type":"fact"}
```

```
Nothing was saved: 'type' must be one of decision, project, reference.
```

**What it said to the user:**

> (nothing)

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
{"sections":[{"body":"Current market data shows used RTX 3090 GPUs are selling for approximately $1,250 to $1,420 USD, based on recent eBay and Reddit hardwareswap listings. Refurbished units on Newegg are listed around $1,499 USD.","heading":"Used RTX 3090 Price"}],"summary":"Used RTX 3090 GPUs currently sell for $1,250–$1,420 USD.","title":"Used RTX 3090 Price","type":"FACT"}
```

```
Nothing was saved: 'type' must be one of decision, project, reference.
```

3. `save_note`

```json
{"sections":[{"body":"Current market data shows used RTX 3090 GPUs are selling for approximately $1,250 to $1,420 USD, based on recent eBay and Reddit hardwareswap listings. Refurbished units on Newegg are listed around $1,499 USD.","heading":"Used RTX 3090 Price"}],"summary":"Used RTX 3090 GPUs currently sell for $1,250–$1,420 USD.","title":"Used RTX 3090 Price","type":"reference"}
```

```
Saved reference note "Used RTX 3090 Price" (id 2026-10-10-used-rtx-3090-price).
Summary on disk: Used RTX 3090 GPUs currently sell for $1,250–$1,420 USD.
You already have 2 note(s) that may cover this subject:
  - id 2026-10-10-homelab-gpu-budget — "Homelab GPU budget": Used RTX 3090 price ~600 USD for homelab GPU
  - id 2026-10-10-homelab-gpu-plan — "Homelab GPU plan": Plan to eventually use a 24 GB GPU, which will be expensive.
If one of them is about the same thing as what you just saved, the two will disagree later. Call save_note again with the same content and supersedes set to that id, which marks the old one superseded instead of leaving both active. If none of them is about the same thing, ignore this.
A dated price caveat was added to the note automatically.
Tell the user in one short sentence what you saved, using the title above.
```

**What it said to the user:**

> Used RTX 3090 GPUs currently sell for about $1,250 – $1,420 USD. I’ve saved this as a reference note titled “Used RTX 3090 Price.”

**Note written — `2026-10-10-used-rtx-3090-price`:**

```markdown
---
id: "2026-10-10-used-rtx-3090-price"
type: "reference"
title: "Used RTX 3090 Price"
summary: "Used RTX 3090 GPUs currently sell for $1,250–$1,420 USD."
date: "2026-10-10"
status: "active"
source: "voice"
session: "verify-10"
---

# Used RTX 3090 Price

## Used RTX 3090 Price

Current market data shows used RTX 3090 GPUs are selling for approximately $1,250 to $1,420 USD, based on recent eBay and Reddit hardwareswap listings. Refurbished units on Newegg are listed around $1,499 USD.

_Prices as stated on 2026-10-10; they may be out of date._

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

> Got it—your coffee preference is now set to black.

### Request 12

**Testing:** ROUTING: 'remember' plus a FACT must reach save_note

**User said:**

> remember that the stt sidecar uses base.en, not small

1. `remember_preference`

```json
{"category":"technical","topic":"stt_sidecar_model","value":"base.en"}
```

```
Saved new preference [technical] stt_sidecar_model: base.en.
```

**What it said to the user:**

> Got it. I’ll use `base.en` for the STT sidecar.

### Request 13

**Testing:** ROUTING: a question about a past CONVERSATION must reach search_memory

**User said:**

> what did we talk about last time?

1. `search_memory`

```json
{"from":null,"query":null,"to":null}
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
1. [decision] "Tavily search provider decision updated" — id 2026-10-10-tavily-search-provider-decision-updated, 2026-10-10 (Decision)
   Decision to switch from Tavily to self-hosted Searx for search.
   ---
## Decision

We are moving from Tavily to a self-hosted Searx instance for search queries. This replaces the previous decision to use Tavily.

2. [reference] "Groq dev tier status" — id 2026-10-10-groq-dev-tier-status, 2026-10-10 (Groq Dev Tier)
   User is on Groq dev tier.
   ---
## Groq Dev Tier

We are currently using the Groq dev tier.

3. [reference] "Backend environment" — id 2026-10-10-backend-environment, 2026-10-10 (Backend Environment)
   Backend runs in WSL2 on gaming PC; Windows side idle.
   ---
## Backend Environment

The backend runs in WSL2 on the gaming PC. The Windows side does not run any services.

These are the closest matc
```

**What it said to the user:**

> You noted that the search provider has been changed:  
> 
> **Decision (2026‑10‑10)** – “Tavily search provider decision updated.”  
> The note states that you are moving from Tavily to a self‑hosted Searx instance for all search queries, replacing the earlier decision to use Tavily.

### Request 15

**Testing:** ROUTING: a behaviour instruction phrased as a note must stay a preference

**User said:**

> make a note to always answer in metric

1. `remember_preference`

```json
{"category":"communication","topic":"unit system","value":"Always answer in metric units"}
```

```
Saved new preference [communication] unit system: Always answer in metric units.
```

**What it said to the user:**

> Got it. I’ll keep that preference in mind.
