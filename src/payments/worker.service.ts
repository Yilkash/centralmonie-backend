import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env';

export interface WorkerJob {
  name: string;
  run(): Promise<unknown>;
}

/**
 * One timer for all background jobs. No AI runs here. A job that is still running is skipped rather
 * than started again, and one job failing does not stop the others.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly jobs: WorkerJob[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly config: ConfigService<Env, true>) {}

  register(job: WorkerJob): void {
    this.jobs.push(job);
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.tick(), this.config.get('WORKER_INTERVAL_MS', { infer: true }));
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.jobs) {
        await job.run().catch((error: Error) => this.logger.error(`${job.name} failed: ${error.name}`));
      }
    } finally {
      this.running = false;
    }
  }
}
