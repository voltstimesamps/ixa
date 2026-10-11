export type MessageType =
  | "user"
  | "assistant"
  | "confirm"
  | "confirmReply"
  | "error"
  | "chunk"
  | "audioInputEnd"
  | "audioOutputEnd"
  | "audioStart"
  // Terminates one turn: sent once the reply is fully out, whether it had
  // audio or not. Clients that only track audio can ignore it.
  | "replyEnd"
  | "sessionStart"
  | "sessionEnd"

export interface WsMessage {
  type: MessageType
  content?: string
  requestId?: string
  // ADDITIVE AND OPTIONAL, set only on `confirm`: how long the backend will
  // wait for the answer, so a client can show the time remaining and decline
  // locally instead of letting the user type into an expired prompt. A client
  // that does not read it behaves exactly as before — the browser `/test`
  // page ignores it today — and the backend's own timer remains the
  // authority, so nothing depends on the client honouring it.
  timeoutMs?: number
}
