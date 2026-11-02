import { Injectable } from '@nestjs/common';
import { ChatResponder } from './chat-responder';

@Injectable()
export class PlaceholderChatResponder extends ChatResponder {
  async reply(): Promise<string> {
    return 'Message received. The assistant is not connected yet, so nothing has been done.';
  }
}
