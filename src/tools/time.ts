import type { Tool } from "./registry"

export const timeTool: Tool = {
  name: "get_time",
  // The description carries an OBLIGATION, not just a capability. "Returns the
  // current local time." is five declarative words that leave calling it
  // optional, and SYSTEM_PROMPT's "for a purely conversational message with no
  // action required, just answer" reads as permission to skip it — which is
  // what happened: asked the time at 9:01 PM, Ixa answered "eight forty-three
  // in the evening" off a get_time result from eighteen minutes earlier and
  // never made the call. In another run it reached for web_search instead and
  // answered with a UTC time off a web page.
  description:
    "Returns the current local time, on the machine you are running on. Call it EVERY time the " +
    "user asks what time it is — including when you have already answered that this " +
    "conversation, because the answer has changed since. A time further up this conversation is " +
    "a record of an earlier moment, not the time now. Never use a web search for the time, and " +
    "never work it out yourself.",
  inputSchema: { type: "object", properties: {} },
  requiresConfirmation: false,
  // The result SAYS WHAT IT IS AND THAT IT GOES OFF.
  //
  // It used to be a bare "8:43:48 PM". A bare scalar is indistinguishable from
  // every other time in the window — from a time in an example, and from the
  // same tool's result twenty messages back — so the model had nothing to
  // prefer the fresh one on. The note travels WITH the value into history,
  // which is the point: the turn that misreads this string is a later turn
  // re-reading it, and that is exactly when the warning is in front of it.
  // MINUTES, NOT SECONDS. toLocaleTimeString() returned "8:43:48 PM", and in a
  // sixty-ask baseline twelve replies read the seconds back out — "the clock
  // reads twelve oh eight and forty-one seconds", "if you need the exact
  // second, it's nineteen" — against a rule that says never to say them. The
  // tool was handing over a value the answer is forbidden to speak. Nothing in
  // Ixa needs second precision from a spoken clock, so it is not supplied; the
  // rule against saying seconds stays exactly as it was.
  execute: async () =>
    `current local time: ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ` +
    `(a snapshot, taken just now and already going out of date — if you are reading this on a ` +
    `later turn it is NOT the time any more; call get_time again)`,
}
