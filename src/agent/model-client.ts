import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';

export interface ModelRequest {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export type ModelResponse = Pick<Anthropic.Message, 'content' | 'stop_reason' | 'usage'>;

/** The one place that knows which AI model is in use. */
export abstract class ModelClient {
  abstract create(request: ModelRequest): Promise<ModelResponse>;
}

@Injectable()
export class ClaudeModelClient extends ModelClient {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private client: Anthropic | undefined;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.model = config.get('AGENT_MODEL', { infer: true });
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    // Created on first use, so the app still starts without a key.
    this.client ??= new Anthropic({ apiKey: this.apiKey ?? null });
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'medium' },
      system: request.system,
      tools: request.tools,
      messages: request.messages,
    });
    return response;
  }
}
