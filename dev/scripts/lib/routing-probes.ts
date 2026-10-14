// The routing set: which TOOL a request should reach.
//
// One copy, in its own module, because two scripts need the same five probes
// and a second hand-maintained copy is the mistake `hint-words.txt` already
// taught this repo. `notes-verify.ts` uses them as its reverse-routing
// measurement; `voice-behavior-verify.ts length` uses them as the regression
// guard beside an arm that changes the model's reasoning effort, which is
// exactly the kind of change that could quietly move routing.
//
// Two of them are the pair the whole notebook design turns on — a note must
// not become a preference and a preference must not become a note — and two
// more are the search pair, `search_notes` against `search_memory`.
//
// MEASURED, and noisy: one run per state cannot separate a 76-character
// description change from sampling. See the routing table in
// ARCHITECTURE.md's open items before reading a single run as a regression.

export interface Probe {
  id: number
  testing: string
  text: string
  // What should happen, in words, for a report a human reads.
  expect: string
  // The same thing a machine can check. Optional, because only the routing
  // set carries it: notes-verify.ts's writer probes are judged by reading
  // their report — one sample per shape, as the spike's caveat says.
  // `mustCall` is satisfied when ANY of the named tools was called;
  // `mustNotCall` fails on any of them. Both are deliberately about the ROUTE
  // and not the reply: a correctly routed turn that then says something
  // unhelpful is a different measurement.
  mustCall?: string[]
  mustNotCall?: string[]
}

// A probe a machine can score, which is what makes the set usable as a guard
// beside another measurement rather than only as a report to read.
export interface RoutedProbe extends Probe {
  mustCall: string[]
  mustNotCall: string[]
}

export const ROUTING_PROBES: RoutedProbe[] = [
  {
    id: 11,
    testing: "ROUTING: a genuine preference must still reach remember_preference",
    text: "i prefer my coffee black, remember that",
    expect: "remember_preference",
    mustCall: ["remember_preference"],
    mustNotCall: ["save_note"],
  },
  {
    id: 12,
    testing: "ROUTING: 'remember' plus a FACT must reach save_note",
    text: "remember that the stt sidecar uses base.en, not small",
    expect: "save_note",
    mustCall: ["save_note"],
    mustNotCall: ["remember_preference"],
  },
  {
    id: 13,
    testing: "ROUTING: a question about a past CONVERSATION must reach search_memory",
    text: "what did we talk about last time?",
    expect: "search_memory with no query",
    mustCall: ["search_memory"],
    mustNotCall: ["search_notes"],
  },
  {
    id: 14,
    testing: "ROUTING: a question about something written down must reach search_notes",
    text: "what did i write down about the search provider?",
    expect: "search_notes",
    mustCall: ["search_notes"],
    mustNotCall: [],
  },
  {
    id: 15,
    testing: "ROUTING: a behaviour instruction phrased as a note must stay a preference",
    text: "make a note to always answer in metric",
    expect: "remember_preference, not save_note",
    mustCall: ["remember_preference"],
    // The known failure, present with the clause and without it on a clean
    // vault: a redundant note alongside the preference. It is scored, not
    // excused — see the routing table in ARCHITECTURE.md.
    mustNotCall: ["save_note"],
  },
]
