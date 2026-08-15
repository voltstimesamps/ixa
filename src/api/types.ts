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
  | "sessionStart"
  | "sessionEnd"

export interface WsMessage {
  type: MessageType
  content?: string
  requestId?: string
}
