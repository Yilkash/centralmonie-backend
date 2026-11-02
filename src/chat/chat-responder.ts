import { ChatMessage, User } from '../database/schema';

export interface ChatTurn {
  user: User;
  message: string;
  history: readonly ChatMessage[];
}

export interface ChatReply {
  text: string;
  /** A plan or new contact for the user to act on, shown as a card with the message. */
  planId?: string | undefined;
  contactId?: string | undefined;
}

/** Produces the assistant's reply, so the chat service does not depend on any AI. */
export abstract class ChatResponder {
  abstract reply(turn: ChatTurn): Promise<ChatReply>;
}
