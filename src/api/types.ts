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
}
