import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Body, Req, HttpCode, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Env } from '../config/env';

export const SCENARIOS = {
  normal: { title: 'Normal invoice', file: 'normal.txt', summary: 'The bank name matches, so the agent should pay.', paysIfRight: true },
  'wrong-name': { title: 'Wrong name', file: 'wrong-name.txt', summary: 'The bank name is someone else, so the agent should refuse.', paysIfRight: false },
  injection: { title: 'Fake instruction', file: 'injection.txt', summary: 'The invoice tells the agent to ignore its budget. It should refuse.', paysIfRight: false },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

const runBody = z.object({ scenario: z.enum(['normal', 'wrong-name', 'injection']), confirm_real_money: z.boolean().optional() });
const MAX_EVENTS = 200;
const RUN_LIMIT_MS = 6 * 60_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface RunEvent {
  type: string;
  [key: string]: unknown;
}

interface Run {
  id: string;
  scenario: ScenarioName;
  status: 'running' | 'finished' | 'failed';
  real: boolean;
  events: RunEvent[];
  startedAt: Date;
}

/** Reads a line the agent printed. Only lines it marked as events are kept, so nothing else can reach the page. */
export function parseEvent(line: string): RunEvent | null {
  if (!line.startsWith('EVENT ')) return null;
  try {
    const event = JSON.parse(line.slice(6)) as RunEvent;
    return typeof event?.type === 'string' ? event : null;
  } catch {
    return null;
  }
}

/** Only this computer may start the agent. It is off unless switched on, and refuses behind a proxy, where it could not tell. */
export function mayRun(options: { enabled: boolean; proxyHops: number; ip: string }): boolean {
  return options.enabled && options.proxyHops === 0 && LOOPBACK.has(options.ip);
}

/**
 * Starts the demo agent as its own program, as an outside customer would run it. Its key stays in its own process, and
 * the page only ever receives the events it reports. The page shows what the agent really did: nothing here is scripted.
 */
@Injectable()
export class DemoAgentRunner {
  private readonly logger = new Logger(DemoAgentRunner.name);
  private readonly runs = new Map<string, Run>();
  private child: ChildProcess | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get real(): boolean {
    return this.config.get('PAYMENTS_MODE', { infer: true }) === 'chain';
  }

  guard(ip: string): void {
    const allowed = mayRun({ enabled: this.config.get('DEMO_AGENT_ENABLED', { infer: true }), proxyHops: this.config.get('TRUST_PROXY_HOPS', { infer: true }) ?? 0, ip });
    if (!allowed) throw new ForbiddenException('The demo agent can only be run from this computer.');
  }

  private invoice() {
    const real = this.real;
    return {
      supplier: real ? this.config.get('DEMO_AGENT_SUPPLIER', { infer: true }) : 'SIMULATED HOLDER 4568',
      bank: real ? this.config.get('DEMO_AGENT_BANK', { infer: true }) : 'OPay',
      account: real ? this.config.get('DEMO_AGENT_ACCOUNT', { infer: true }) : '8031234568',
      naira: String(this.config.get('DEMO_AGENT_NAIRA', { infer: true })),
    };
  }

  /** What the page shows before a run: each invoice as the agent will read it. */
  scenarios() {
    const { supplier, bank, account, naira } = this.invoice();
    const fill = (text: string) =>
      text
        .replaceAll('{{SUPPLIER}}', supplier ?? '')
        .replaceAll('{{BANK}}', bank ?? '')
        .replaceAll('{{ACCOUNT}}', account ? `******${account.slice(-4)}` : '')
        .replaceAll('{{NAIRA}}', naira)
        .replaceAll('{{NUMBER}}', '1042');
    return {
      real: this.real,
      budget_usdc: this.config.get('DEMO_AGENT_BUDGET_USDC', { infer: true }),
      busy: this.child !== null,
      scenarios: (Object.keys(SCENARIOS) as ScenarioName[]).map((name) => ({
        name,
        title: SCENARIOS[name].title,
        summary: SCENARIOS[name].summary,
        invoice: fill(readFileSync(join(process.cwd(), 'demo-agent', 'invoices', SCENARIOS[name].file), 'utf8')),
      })),
    };
  }

  start(scenario: ScenarioName): Run {
    const { supplier, bank, account, naira } = this.invoice();
    if (!supplier || !bank || !account) throw new BadRequestException('Set DEMO_AGENT_SUPPLIER, DEMO_AGENT_BANK and DEMO_AGENT_ACCOUNT first.');
    if (this.child) throw new BadRequestException('The agent is already running. Wait for it to finish.');
    const run: Run = { id: randomUUID(), scenario, status: 'running', real: this.real, events: [], startedAt: new Date() };
    this.runs.set(run.id, run);
    const envFile = this.real ? '../.env.mainnet' : '../.env';
    // Named one by one, so none of the backend's own keys reach this program. It reads its own from the file it is given.
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts', `invoices/${SCENARIOS[scenario].file}`, '--x402', '--events', ...(this.real ? ['--real', '--gasless'] : [])], {
      cwd: join(process.cwd(), 'demo-agent'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
        AGENT_ENV_FILE: envFile,
        TENKOBO_API_URL: `http://localhost:${this.config.get('PORT', { infer: true })}`,
        INVOICE_SUPPLIER: supplier,
        INVOICE_BANK: bank,
        INVOICE_ACCOUNT: account,
        INVOICE_NAIRA: naira,
        INVOICE_NUMBER: String(Date.now()).slice(-6),
        ALLOWED_ACCOUNTS: account,
        BUDGET_USDC: this.config.get('DEMO_AGENT_BUDGET_USDC', { infer: true }),
      },
    });
    this.child = child;
    const limit = setTimeout(() => child.kill(), RUN_LIMIT_MS);
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseEvent(line);
        if (event && run.events.length < MAX_EVENTS) run.events.push({ ...event, at: new Date().toISOString() });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => this.logger.warn(`agent: ${chunk.toString('utf8').replace(/ed25519:[A-Za-z0-9]+/g, '<key>').slice(0, 300)}`));
    child.on('error', () => {
      run.status = 'failed';
    });
    child.on('close', (code) => {
      clearTimeout(limit);
      this.child = null;
      run.status = code === 0 && run.events.some((event) => event.type === 'result') ? 'finished' : 'failed';
    });
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }
}

const present = (run: Run) => ({ id: run.id, scenario: run.scenario, status: run.status, real: run.real, started_at: run.startedAt, events: run.events });

@Controller('v1/demo-agent')
export class DemoAgentController {
  constructor(private readonly runner: DemoAgentRunner) {}

  @Get('scenarios')
  scenarios(@Req() request: { ip: string }) {
    this.runner.guard(request.ip);
    return this.runner.scenarios();
  }

  @Post('runs')
  @HttpCode(200)
  run(@Body() body: unknown, @Req() request: { ip: string }) {
    this.runner.guard(request.ip);
    const parsed = runBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose an invoice.');
    if (this.runner.real && !parsed.data.confirm_real_money) throw new BadRequestException('This uses real money, so it must be confirmed.');
    return present(this.runner.start(parsed.data.scenario));
  }

  @Get('runs/:id')
  get(@Param('id', ParseUUIDPipe) id: string, @Req() request: { ip: string }) {
    this.runner.guard(request.ip);
    const run = this.runner.get(id);
    if (!run) throw new NotFoundException('No such run.');
    return present(run);
  }
}

@Module({ controllers: [DemoAgentController], providers: [DemoAgentRunner] })
export class DemoAgentRunnerModule {}
