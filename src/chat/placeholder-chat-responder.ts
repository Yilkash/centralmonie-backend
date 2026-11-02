import { Injectable } from '@nestjs/common';
import { ChatReply, ChatResponder } from './chat-responder';

@Injectable()
export class PlaceholderChatResponder extends ChatResponder {
  async reply(): Promise<ChatReply> {
    return { text: 'Message received. The assistant is not connected yet, so nothing has been done.' };
  }
}
