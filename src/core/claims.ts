// Finding a claim that an action happened, for the claim guard in Session.
//
// THE CASE. A live voice turn, `reasoning_effort: low`. The model called
// `shell_write touch MyFile.txt`, the user typed "no", the tool result said
// `Action declined by user.` in those four words, and the reply was
//
//   "I've created MyFile.txt."
//
// The file did not exist. Asked about it six turns later Ixa ran `ls`, got
// `No such file or directory`, and said "No, the file was not created. The
// last attempt was declined" — so nothing was wrong with her reading of the
// result. The lie was in the reply.
//
// WHY A GUARD AND NOT A SENTENCE IN THE PROMPT. The system prompt has carried
// "NEVER CLAIM AN ACTION YOU DID NOT TAKE", in capitals, since before this
// happened. It is the third paragraph the model reads. A prompt-only fix for
// this exact failure is already disproven, which is the same thing the price
// guard found out about prices.
//
// MEASURED, on a replay of that conversation's history with the user's actual
// next words ("Done, yeah." — a mis-transcription that reads as the user
// saying the thing is already finished):
//
//   reasoning_effort low      8 of 30 turns claimed the file was created
//   reasoning_effort medium   0 of 30
//   low, "Yes, go ahead."     0 of 10   — the ambiguous transcript is needed
//   low, fresh conversation   0 of 20   — the history is needed too
//
// So this is not a guard against a model that lies at random. It is a guard
// against one specific confusion — a pending action, and a user utterance
// that reads as asserting it is done — and the thing that makes a guard the
// right shape is that the confusion is invisible from inside the draft.

// ---------------------------------------------------------- the outcome
//
// What happened to the confirming tool call, in the vocabulary the tool log
// already uses: `declined`, `unanswered`, `cancelled` are the three
// confirmation outcomes, and `failed` is a call that ran and whose own
// `isFailure` calls the result a failure.
export type UnmetOutcome = "declined" | "unanswered" | "cancelled" | "failed"

// How each outcome is named TO THE MODEL, mid-sentence, in the correction.
// Separate from the user-facing sentences in session.ts on purpose: these
// explain the mechanism and those have to be sayable out loud.
const OUTCOME_PHRASE: Record<UnmetOutcome, string> = {
  declined: "the user declined the confirmation",
  unanswered: "the confirmation was never answered",
  cancelled: "the confirmation was cancelled when the asking client disconnected",
  failed: "the tool ran and reported a failure",
}

export function outcomePhrase(outcome: UnmetOutcome): string {
  return OUTCOME_PHRASE[outcome]
}

// ---------------------------------------------------------- the pattern
//
// NARROW ON PURPOSE, and narrow in a way the two conditions around it pay for.
// The guard only looks at this pattern once it already knows that a confirming
// tool call this turn was declined, unanswered, cancelled or failed AND that
// nothing in the turn succeeded. So the expensive false positive — a reply
// that truthfully says "I saved that note" on a turn where `save_note`
// worked — is impossible before the regex is reached, and the pattern does not
// have to carry that weight.
//
// What it still has to avoid is a reply that is honest IN A TURN WHERE NOTHING
// WORKED, which is a real shape: the measured runs produced "I didn't create
// the file", "I'm ready to create MyFile.txt when you give the go-ahead" and
// "I can't create the file without your confirmation" far more often than they
// produced the lie. None of those may be touched. That is why negation is
// handled by the verb forms rather than by a separate check: every denial in
// those runs reaches for an auxiliary ("didn't create", "can't create",
// "won't create", "haven't created"), and an auxiliary puts a word between the
// subject and the participle that none of these alternatives allows.

// The completed-action verbs, as past tense or past participle. Every one of
// them, said in the first person, asserts a side effect that either happened
// or did not — which is what makes a wrong one a lie rather than a hedge.
// Deliberately no "tried", "started", "attempted": those claim nothing.
// Two of them carry an idiom that claims nothing, so the idiom is excluded by
// name rather than the verb being dropped: "I ran the command" is the exact
// shape of the shell_write lie, and "I ran into a problem" is the honest reply
// on the very same turn. Same for "I made a mistake" against "I made the
// directory". Both exclusions are held by tests.
const DONE_VERBS =
  String.raw`created|made(?!\s+(?:a\s+mistake|an\s+error|sure|certain))|added|saved|wrote|written|` +
  String.raw`deleted|removed|cleared|updated|renamed|moved|copied|sent|installed|` +
  String.raw`ran(?!\s+(?:into|out|low|short|up))|touched|forgot|forgotten|remembered|reset`

// "I created", "I've created", "I have created", and with "just" or "already"
// in between. The subject and the verb are adjacent apart from those two
// words, so "I did not create", "I haven't created", "I can't create" and
// "I never created" cannot match: each one puts an auxiliary or a negator
// where a verb has to be.
// The leading \b matters more than it looks: without it, case-insensitive `I`
// would match the "i" inside a word, and "Hi created" is not English but
// "Multi created" could be.
const FIRST_PERSON = String.raw`\bI(?:['’]ve|\s+have)?(?:\s+(?:just|already))?\s+(?:${DONE_VERBS})`

// "it has been created", "that's been deleted". Same adjacency: "has not been
// created" fails because "not" sits where "been" must.
const PASSIVE = String.raw`(?:has|have|['’]s|['’]ve)\s+been\s+(?:${DONE_VERBS})`

// The bare assertion, which carries no verb at all. Anchored to the start of
// the reply or of a sentence inside it, because that is the difference between
// "Done." and "let me know when you're done": only one of them is Ixa
// reporting on herself. "All set" is in because it was the one non-verb phrase
// the measured runs produced that asserts completion.
const BARE_DONE = String.raw`(?:^|[.!?]\s+|\n\s*)(?:all\s+)?done\b|\bthat['’]s\s+done\b|\ball\s+set\b`

const COMPLETION_CLAIM = new RegExp(
  `${FIRST_PERSON}|${PASSIVE}|${BARE_DONE}`,
  "i"
)

// The phrase that made this a claim, or null. Returned rather than a boolean
// because both the log line and the correction quote it back: a correction
// that says "your draft claimed the action happened" is arguing with the
// model about what it meant, and one that says 'your draft said "I\'ve created
// MyFile.txt"' is not.
export function findCompletionClaim(text: string): string | null {
  const match = COMPLETION_CLAIM.exec(text)
  if (!match) return null
  return match[0].trim()
}

// ---------------------------------------------------------- the correction
//
// Set for exactly one retry, never written to history — the same contract as
// priceCorrectionPrompt, and for the same reason: the user never heard the
// draft this is answering, so history saying Ixa said it would be the drift
// the turn-failure record exists to prevent.
//
// It forbids re-running the action as well as re-claiming it. The alternative
// was measured: `reasoning_effort: medium` avoids the false claim partly by
// asking again, and on the same 30 replay turns it put a median of 2 and a
// maximum of SEVEN confirmation prompts in front of the user for one `touch`.
// A reply is owed here, not another prompt — and on a voice turn the user
// cannot answer a prompt by voice at all.
export function claimCorrectionPrompt(
  claim: string,
  outcome: UnmetOutcome,
  toolName: string
): string {
  return (
    `STOP. Your draft reply said "${claim}", which tells the user the action happened. It did ` +
    `NOT happen: ${toolName} was not carried out because ${outcomePhrase(outcome)}, and no tool ` +
    `call succeeded in this turn. Telling the user you did something you did not do is worse ` +
    `than telling them you could not do it. Write the reply again and say plainly that it did ` +
    `not happen and why. Do NOT call a tool, do not run the action now, and do not ask them to ` +
    `confirm it again — they can raise it themselves if they still want it.`
  )
}
