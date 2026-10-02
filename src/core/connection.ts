import type { WsMessage } from "../api/types"
import type { Confirmer } from "./confirmation"

// A client attached to a session. Sessions outlive connections, so a session
// may have several of these at once, or none at all.
//
// `origin` is NOT here on purpose: a single WebSocket carries both typed text
// and transcribed speech, so MessageOrigin is a property of the turn, not of
// the connection (see SessionManager.submitTurn).
export interface Connection {
  readonly id: string

  // Where a confirmation prompt for a turn from this connection goes. Owned by
  // the connection so a prompt is never routed to a client that didn't ask.
  readonly confirmer: Confirmer

  // False once the underlying transport has gone away. Checked before every
  // send so a closed socket costs nothing instead of raising per-chunk errors.
  readonly isOpen: boolean

  send(msg: WsMessage): void
  sendBinary(chunk: Buffer): void
}
