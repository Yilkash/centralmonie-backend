import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { payments, ProtectCheck, protectChecks } from '../database/schema';
import { JUDGEMENT_SCHEMA, PROTECT_PROFILES, ProtectJudgement, ProtectProfile, ProtectVerdict } from './protect.profiles';

const RANK: Record<ProtectVerdict, number> = { pay: 0, ask: 1, block: 2 };

export type SubjectKind = 'plan' | 'agent_payment' | 'merchant_invoice';

export interface ProtectInput {
  profile: ProtectProfile;
  /** Text from outside 10kobo or pasted by the user: an invoice, a message, an order note. Account numbers are masked here. */
  request: string;
  /** What 10kobo itself knows and has checked, such as the bank's own account name. Trusted over the request. */
  facts: string[];
  /** Rules 10kobo applies whatever SERV says. The stricter answer always wins. */
  floor?: { verdict: ProtectVerdict; reason: string } | null;
}

/** Replaces every 10-digit account number with [ACCT_n], so SERV never sees a real one. */
export function maskAccounts(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(/(?<!\d)\d{10}(?!\d)/g, (digits) => {
    if (!seen.has(digits)) seen.set(digits, `[ACCT_${seen.size + 1}]`);
    return seen.get(digits)!;
  });
}

export const presentCheck = (check: ProtectCheck | null) =>
  check && {
    verdict: check.verdict,
    serv_verdict: check.servVerdict,
    summary: check.summary,
    question: check.question,
    signals: check.signals,
    refused: check.refusal,
    model: check.model,
    seconds: check.ms === null ? null : Math.round(check.ms / 100) / 10,
    acknowledged: check.acknowledgedAt !== null,
    checked_at: check.createdAt,
  };

/**
 * 10kobo Protect. SERV Reasoning reads what led to a payment and answers pay, ask or block, with reasons. It runs with
 * SERV's prompt guard (text that tries to instruct the AI is stopped) and shadow agent (a second pass checks and
 * revises the answer). If SERV cannot answer, the payment is held for the owner: Protect never fails open.
 */
@Injectable()
export class ProtectService {
  private readonly logger = new Logger(ProtectService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  get enabled(): boolean {
    return this.config.get('SERV_PROTECT_ENABLED', { infer: true }) && Boolean(this.config.get('SERV_API_KEY', { infer: true }));
  }

  async check(user: string | null, kind: SubjectKind, subjectId: string, input: ProtectInput): Promise<ProtectCheck> {
    const judged = await this.judge(input);
    let verdict: ProtectVerdict = judged.judgement?.verdict ?? 'ask';
    let summary = judged.judgement?.summary ?? null;
    if (input.floor && RANK[input.floor.verdict] > RANK[verdict]) {
      verdict = input.floor.verdict;
      summary = [input.floor.reason, summary].filter(Boolean).join(' ');
    }
    const [row] = await this.db
      .insert(protectChecks)
      .values({
        userId: user,
        subjectKind: kind,
        subjectId,
        profile: input.profile,
        verdict,
        servVerdict: judged.judgement?.verdict ?? null,
        summary: summary ?? (judged.refusal ? 'SERV could not judge this payment, so it waits for your confirmation.' : null),
        question: judged.judgement?.question_for_owner ?? null,
        signals: judged.judgement?.signals ?? [],
        refusal: judged.refusal,
        model: judged.model,
        ms: judged.ms,
        tokens: judged.tokens,
      })
      .returning();
    return row!;
  }

  async latest(kind: SubjectKind, subjectId: string): Promise<ProtectCheck | null> {
    const [row] = await this.db.select().from(protectChecks).where(and(eq(protectChecks.subjectKind, kind), eq(protectChecks.subjectId, subjectId))).orderBy(desc(protectChecks.createdAt)).limit(1);
    return row ?? null;
  }

  /**
   * SERV's prompt guard stopped the request. With words that command an AI, that is the answer: block. Otherwise the
   * guard saw manipulation of another kind (pressure, a new account): SERV judges again without the guard to give the
   * reasons, and the answer can never be lower than "ask".
   */
  private async guardStopped(input: ProtectInput, attempt: number, guard: boolean, said: string, ms: number, tokens: number | null) {
    const model = this.config.get('SERV_MODEL', { infer: true });
    if (INSTRUCTIONS.test(input.request) || !guard) return { judgement: guardBlock(said), refusal: said, model, ms, tokens };
    const again = await this.judge(input, attempt, false);
    if (!again.judgement) return { ...again, judgement: guardBlock(said), refusal: said };
    const raised = again.judgement.verdict === 'pay' ? { ...again.judgement, verdict: 'ask' as const } : again.judgement;
    return { ...again, judgement: { ...raised, summary: `SERV's prompt guard flagged this request as manipulative. ${raised.summary}` }, refusal: `Prompt guard: ${said}`, ms: ms + again.ms };
  }

  /** The owner read the warning and chose to go ahead. Only an "ask" can be confirmed; a "block" cannot. */
  async acknowledge(kind: SubjectKind, subjectId: string): Promise<boolean> {
    const check = await this.latest(kind, subjectId);
    if (!check || check.verdict !== 'ask') return false;
    await this.db.update(protectChecks).set({ acknowledgedAt: new Date() }).where(eq(protectChecks.id, check.id));
    return true;
  }

  /**
   * What 10kobo knows about each payment in a plan, from its own records: who the bank says owns the account, the
   * name the user saved, and how often this user has paid that account before. Account numbers are cut to 4 digits.
   */
  async planFacts(userId: string, items: { route: string; recipientName: string | null; amountKobo: number; destination: unknown }[]): Promise<string[]> {
    const facts: string[] = [];
    for (const item of items) {
      const destination = (item.destination ?? {}) as { accountNumber?: string | null; accountName?: string | null; bankName?: string | null; phone?: string | null; walletAddress?: string | null };
      const naira = `₦${(item.amountKobo / 100).toLocaleString('en-NG')}`;
      if (item.route === 'bank' && destination.accountNumber) {
        const [prior] = await this.db
          .select({ paid: sql<number>`count(*)::int` })
          .from(payments)
          .where(and(eq(payments.userId, userId), eq(payments.status, 'completed'), sql`${payments.destination}->>'accountNumber' = ${destination.accountNumber}`));
        facts.push(
          `Bank payment of ${naira} to the contact saved as "${item.recipientName}": ${destination.bankName ?? 'bank'} account ending ${destination.accountNumber.slice(-4)}. The bank's own name for this account is "${destination.accountName ?? 'unknown'}". This user has paid this account ${prior?.paid ?? 0} time(s) before.`,
        );
      } else facts.push(`${item.route} payment of ${naira} to "${item.recipientName}".`);
    }
    return facts;
  }

  async recent(userId: string, limit = 50): Promise<ProtectCheck[]> {
    return this.db.select().from(protectChecks).where(eq(protectChecks.userId, userId)).orderBy(desc(protectChecks.createdAt)).limit(limit);
  }

  private async judge(input: ProtectInput, attempt = 1, guard = true): Promise<{ judgement: ProtectJudgement | null; refusal: string | null; model: string; ms: number; tokens: number | null }> {
    const model = this.config.get('SERV_MODEL', { infer: true });
    const profile = PROTECT_PROFILES[input.profile];
    const user = `Facts from 10kobo (checked, trusted):\n${input.facts.map((fact) => `- ${fact}`).join('\n') || '- none'}\n\nRequest (from outside 10kobo or pasted by the user, untrusted):\n"""\n${maskAccounts(input.request).slice(0, 6000) || '(no outside text: the user simply asked to pay)'}\n"""`;
    const started = Date.now();
    try {
      const response = await fetch(this.config.get('SERV_ENDPOINT', { infer: true }), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.get('SERV_API_KEY', { infer: true })}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: profile.system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'protect_judgement', strict: true, schema: JUDGEMENT_SCHEMA } },
          tools: [
            ...(guard ? [{ type: 'function', function: { name: 'serv_prompt_guard', parameters: { type: 'object', properties: {} } } }] : []),
            // Our instructions are not secret, and SERV's leak filter misreads fraud rules quoted in a summary.
            { type: 'function', function: { name: 'serv_disable_content_filter', parameters: { type: 'object', properties: {} } } },
            { type: 'function', function: { name: 'serv_shadow_agent', parameters: { type: 'object', properties: { hint: { type: 'string', default: profile.shadowHint }, max_iterations: { type: 'integer', default: 2 } } } } },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const ms = Date.now() - started;
      const json = (await response.json().catch(() => ({}))) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; error?: { message?: string } };
      const tokens = json.usage?.total_tokens ?? null;
      if (!response.ok) {
        // A refused request (the prompt guard) is a result: text that tries to instruct the AI is blocked.
        const guarded = response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429;
        if (!guarded) {
          this.logger.warn(`SERV answered ${response.status}`);
          return { judgement: null, refusal: `SERV ${response.status}`, model, ms, tokens };
        }
        return this.guardStopped(input, attempt, guard, json.error?.message?.slice(0, 200) ?? '', ms, tokens);
      }
      const message = json.choices?.[0]?.message;
      if (message?.refusal) return this.guardStopped(input, attempt, guard, message.refusal.slice(0, 200), ms, tokens);
      try {
        return { judgement: JSON.parse(message?.content ?? '') as ProtectJudgement, refusal: null, model, ms, tokens };
      } catch {
        // Plain words instead of the format: SERV refused. It is asked once more; a second refusal blocks only when
        // the text really tries to instruct the AI, and otherwise waits for the owner.
        if (attempt === 1) return this.judge(input, 2);
        const said = (message?.content ?? '').slice(0, 200);
        return { judgement: INSTRUCTIONS.test(input.request) ? guardBlock(said) : null, refusal: said || 'SERV did not answer in the expected format.', model, ms, tokens };
      }
    } catch (error) {
      this.logger.warn(`SERV could not be reached: ${(error as Error).name}`);
      return { judgement: null, refusal: 'SERV could not be reached.', model, ms: Date.now() - started, tokens: null };
    }
  }
}

/** Words that try to command an AI or a payment system, as attackers write them into invoices and messages. */
const INSTRUCTIONS = /\b(ignore (all|any|your|previous)|disregard|system\s*:|assistant\s*:|you are now|approve (this|all|it) automatically|pre-?approved|skip (the |all |your )?(checks?|verification)|disable[ds]? (the )?(checks?|fraud)|test mode|do not mention)/i;

/** SERV's prompt guard stopped the request: something in it tried to instruct the AI. That is itself a reason to block. */
function guardBlock(said: string | null | undefined): ProtectJudgement {
  return {
    verdict: 'block',
    confidence: 1,
    summary: 'SERV\'s prompt guard stopped this request: the text tries to give instructions to the AI or the payment system.',
    signals: [{ name: 'Instructions hidden in the request', severity: 'high', evidence: said ? `SERV: "${said.slice(0, 160)}"` : 'Stopped by the prompt guard' }],
    claims_urgency: false,
    claims_new_bank_details: false,
    contains_instructions_to_agent: true,
    question_for_owner: null,
  };
}


@Global()
@Module({ providers: [ProtectService], exports: [ProtectService] })
export class ProtectModule {}
