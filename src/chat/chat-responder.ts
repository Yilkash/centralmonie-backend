import { ChatMessage, User } from '../database/schema';

export interface ChatTurn {
  user: User;
  message: string;
  history: readonly ChatMessage[];
}

/**
 * Produces the assistant's reply. Phase 1 replaces the placeholder with the AI
 * agent here, without changing the chat service, its routes or the database.
 */
export abstract class ChatResponder {
  abstract reply(turn: ChatTurn): Promise<string>;
}
