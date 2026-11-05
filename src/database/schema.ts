import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The identity provider's ID for this person, so that provider stays swappable.
  providerSubject: text('provider_subject').notNull().unique(),
  email: text('email'),
  walletAddress: text('wallet_address'),
  // A salted scrypt hash. The PIN itself is never stored.
  pinHash: text('pin_hash'),
  pinFailures: integer('pin_failures').notNull().default(0),
  pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatRole = pgEnum('chat_role', ['user', 'assistant']);

/** One chat a user can return to. The agent only remembers what was said in the same one. */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversations_user_updated_idx').on(table.userId, table.updatedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    content: text('content').notNull(),
    // A card shown with the message. Plain IDs: these tables are declared further down.
    planId: uuid('plan_id'),
    contactId: uuid('contact_id'),
    scheduleGroupId: uuid('schedule_group_id'),
    cancelScheduleId: uuid('cancel_schedule_id'),
    depositId: uuid('deposit_id'),
    // The blockchain transaction a notice is about, so the chat can link to it.
    txHash: text('tx_hash'),
    // An automatic notice from the app, such as a scheduled payment going out. The AI did not write it.
    notice: boolean('notice').notNull().default(false),
    // Written by the app rather than typed by the user: the model reads it, the chat does not show it.
    hidden: boolean('hidden').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('chat_messages_user_created_idx').on(table.userId, table.createdAt), index('chat_messages_conversation_idx').on(table.conversationId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;

export const contactStatus = pgEnum('contact_status', ['proposed', 'confirmed']);
export const destinationKind = pgEnum('destination_kind', ['phone', 'bank', 'wallet']);
export const paymentRoute = pgEnum('payment_route', ['airtime', 'data', 'bank', 'usdc']);
export const planStatus = pgEnum('plan_status', ['proposed', 'approved', 'rejected', 'expired']);
// awaiting_signature -> funding -> funded -> paying -> completed
// Anything after funded that fails -> returning -> returned, or needs_support if it cannot return by itself.
export const paymentStatus = pgEnum('payment_status', [
  'pending', 'completed', 'failed', 'awaiting_signature', 'funding', 'funded', 'paying', 'returning', 'returned', 'needs_support',
]);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'`),
    status: contactStatus('status').notNull().default('proposed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('contacts_user_idx').on(table.userId)],
);

export const contactDestinations = pgTable('contact_destinations', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  kind: destinationKind('kind').notNull(),
  phone: text('phone'),
  network: text('network'),
  bankName: text('bank_name'),
  accountNumber: text('account_number'),
  // The name the bank gave, never one typed by the user or the AI.
  accountName: text('account_name'),
  walletAddress: text('wallet_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: planStatus('status').notNull().default('proposed'),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [index('plans_user_idx').on(table.userId)],
);

/** What gets approved. Recipient details are copied in, so later contact edits cannot change them. */
export const planItems = pgTable('plan_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  planId: uuid('plan_id').notNull().references(() => plans.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  route: paymentRoute('route').notNull(),
  recipientName: text('recipient_name').notNull(),
  recipientDetail: text('recipient_detail').notNull(),
  destination: jsonb('destination').notNull(),
  dataPlan: text('data_plan'),
  // Naira value in kobo; for a USDC payment this is its value when quoted.
  amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
  usdcMinor: bigint('usdc_minor', { mode: 'number' }).notNull(),
  // What the chain said about a wallet address when this was proposed. Null for other payments.
  addressCheck: text('address_check'),
  // For USDC to another chain: where it goes, and what the receiver should get, as quoted when proposed.
  delivery: jsonb('delivery').$type<{ chain: string; name: string; receiverMinor: number; seconds: number | null } | null>(),
});

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // One payment per approved item, so approving twice can never pay twice.
    planItemId: uuid('plan_item_id').unique().references(() => planItems.id),
    route: paymentRoute('route').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    usdcMinor: bigint('usdc_minor', { mode: 'number' }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    providerReference: text('provider_reference'),
    failureReason: text('failure_reason'),
    recipientName: text('recipient_name'),
    destination: jsonb('destination'),
    // Where the user's USDC goes first: the recipient for USDC, otherwise the collection or partner address.
    fundingAddress: text('funding_address'),
    // True when the money sits at our own collection address, so we can return it ourselves.
    /** For USDC to another chain: what really arrived. */
    deliveredMinor: bigint('delivered_minor', { mode: 'number' }),
    refundable: boolean('refundable').notNull().default(false),
    fundingTxHash: text('funding_tx_hash'),
    fundingFromBlock: bigint('funding_from_block', { mode: 'number' }),
    refundTxHash: text('refund_tx_hash'),
    // Set instead of plan_item_id for a scheduled payment. Unique, so a run can only ever pay once.
    scheduleRunId: uuid('schedule_run_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payments_user_created_idx').on(table.userId, table.createdAt)],
);

export const scheduleStatus = pgEnum('schedule_status', [
  'proposed', 'awaiting_signature', 'active', 'completed', 'cancelled', 'failed', 'rejected', 'expired',
]);
export const scheduleRunStatus = pgEnum('schedule_run_status', ['started', 'succeeded', 'failed']);

/** A payment for later, once or repeating. Recipient details are copied in, as with plan items. */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // Schedules proposed together are approved together, on one card and with one signature.
    groupId: uuid('group_id').notNull(),
    status: scheduleStatus('status').notNull().default('proposed'),
    timing: jsonb('timing').notNull(),
    route: paymentRoute('route').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientDetail: text('recipient_detail').notNull(),
    // What the chain said about a wallet address when this was proposed. Null for other payments.
    addressCheck: text('address_check'),
    destination: jsonb('destination').notNull(),
    dataPlan: text('data_plan'),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    // The amount for a USDC payment. Naira payments are priced in USDC on the day they run.
    fixedUsdcMinor: bigint('fixed_usdc_minor', { mode: 'number' }),
    // The moment this payment belongs to, which stays put through retries.
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    runsLeft: integer('runs_left'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    // The latest payment that went out, for the receipt on the card.
    lastTxHash: text('last_tx_hash'),
    lastPaidAt: timestamp('last_paid_at', { withTimezone: true }),
    remindedFor: timestamp('reminded_for', { withTimezone: true }),
    permission: jsonb('permission'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    index('schedules_user_idx').on(table.userId),
    index('schedules_group_idx').on(table.groupId),
    index('schedules_due_idx').on(table.status, table.nextRunAt),
  ],
);

/** One attempt. The unique pair stops one due moment from running twice, even after a crash. */
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').notNull().references(() => schedules.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: scheduleRunStatus('status').notNull().default('started'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('schedule_runs_due_idx').on(table.scheduleId, table.dueAt)],
);

/** A funding transaction can back one plan only, so the same transaction can never buy twice. */
export const fundingTransactions = pgTable(
  'funding_transactions',
  {
    txHash: text('tx_hash').notNull(),
    wallet: text('wallet').notNull(),
    ownerId: uuid('owner_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.txHash, table.wallet] })],
);

/** USDC that arrived in a user's wallet, recorded once and announced in their chat. */
export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    fromAddress: text('from_address').notNull(),
    usdcMinor: bigint('usdc_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('deposits_tx_log_idx').on(table.txHash, table.logIndex), index('deposits_user_idx').on(table.userId)],
);

export const nairaDepositStatus = pgEnum('naira_deposit_status', ['waiting', 'processing', 'completed', 'failed', 'expired', 'cancelled']);

/** Naira a user is paying in to get USDC. The id is the reference the partner knows it by. */
export const nairaDeposits = pgTable(
  'naira_deposits',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    usdcMinor: bigint('usdc_minor', { mode: 'number' }).notNull(),
    rate: text('rate').notNull(),
    bankName: text('bank_name'),
    accountNumber: text('account_number').notNull(),
    accountName: text('account_name'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: nairaDepositStatus('status').notNull().default('waiting'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** The user says they have made the transfer. Only for showing progress: the partner decides what arrived. */
    userSentAt: timestamp('user_sent_at', { withTimezone: true }),
  },
  (table) => [
    index('naira_deposits_user_idx').on(table.userId, table.createdAt),
    uniqueIndex('naira_deposits_one_waiting_idx').on(table.userId).where(sql`${table.status} = 'waiting'`),
  ],
);

/** A pause switch for a route or the scheduler. No row means not paused. */
export const opSwitches = pgTable('op_switches', {
  name: text('name').primaryKey(),
  paused: boolean('paused').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Who or what did each sensitive thing, including what the AI proposed. Never updated or deleted by the app. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subject: text('subject'),
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_created_idx').on(table.createdAt)],
);

/** How far a chain watcher has read. */
export const chainCursors = pgTable('chain_cursors', {
  name: text('name').primaryKey(),
  block: bigint('block', { mode: 'number' }).notNull(),
});

export type Schedule = typeof schedules.$inferSelect;
export type ScheduleRun = typeof scheduleRuns.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type ContactDestination = typeof contactDestinations.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanItem = typeof planItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type NairaDeposit = typeof nairaDeposits.$inferSelect;

/** A customer's AI agent. Only the hash of its key is kept, so the key is shown once, when it is made. */
export const agentKeys = pgTable('agent_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  dailyLimitKobo: bigint('daily_limit_kobo', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * One naira payment asked for by an agent. Its id is also the partner's reference, so asking the
 * partner twice gives the same payment. The USDC never passes through a wallet of ours.
 */
export const agentPayments = pgTable(
  'agent_payments',
  {
    id: uuid('id').primaryKey(),
    keyId: uuid('key_id').notNull().references(() => agentKeys.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('quoted'),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    usdcMinor: bigint('usdc_minor', { mode: 'number' }).notNull(),
    payInMinor: bigint('pay_in_minor', { mode: 'number' }).notNull(),
    bankName: text('bank_name').notNull(),
    accountNumber: text('account_number').notNull(),
    accountName: text('account_name').notNull(),
    payFrom: text('pay_from').notNull(),
    payToken: text('pay_token').notNull().default('USDC'),
    /** Set when USDC goes straight to this NEAR account or Base address, with no bank payout. */
    deliverTo: text('deliver_to'),
    /** For a payer paying naira by bank transfer: the partner's temporary account to pay into. */
    nairaAccount: jsonb('naira_account').$type<{ bankName: string | null; accountNumber: string; accountName: string | null; amountKobo: number; rate: string }>(),
    refundTo: text('refund_to').notNull(),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }).notNull(),
    payoutAddress: text('payout_address'),
    payoutKobo: bigint('payout_kobo', { mode: 'number' }),
    depositAddress: text('deposit_address'),
    depositDeadline: timestamp('deposit_deadline', { withTimezone: true }),
    transactions: jsonb('transactions').$type<string[]>().notNull().default([]),
    failureReason: text('failure_reason'),
    // What a keyless agent told us about itself. Unverified: a record for follow-up, never a safety check.
    payerName: text('payer_name'),
    payerEmail: text('payer_email'),
    purpose: text('purpose'),
    clientIp: text('client_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** When our relayer sent this payment's transfer. It pays once per payment, so it cannot be drained by repeats. */
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
    /** When limits start counting this payment. A quote reserves nothing, so its own date must not decide the day. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (table) => [index('agent_payments_key_idx').on(table.keyId, table.createdAt), index('agent_payments_status_idx').on(table.status)],
);

export type AgentKey = typeof agentKeys.$inferSelect;
export type AgentPayment = typeof agentPayments.$inferSelect;

/** A link someone can pay from any chain, with naira going to the bank account of the user who made it. */
export const payLinks = pgTable(
  'pay_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    bankName: text('bank_name').notNull(),
    accountNumber: text('account_number').notNull(),
    accountName: text('account_name').notNull(),
    note: text('note'),
    /** Invoice details, shown to the payer. They change nothing about the money. */
    dueDate: text('due_date'),
    lineItems: jsonb('line_items').$type<{ description: string; amountNaira: number }[]>(),
    /** Set when the receiver wants USDC on this NEAR account instead of naira in a bank. */
    nearAccount: text('near_account'),
    /** Set when the receiver wants USDC on this Base address instead of naira in a bank. */
    usdcAddress: text('usdc_address'),
    /** Set when the user cancels it. A cancelled link can never be paid. */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Set when a shop made it through the merchant API, with the shop's own order reference. */
    merchantKeyId: uuid('merchant_key_id').references(() => merchantKeys.id, { onDelete: 'set null' }),
    reference: text('reference'),
    /** Where the payer goes back to once paid. Only a website the shop registered. */
    returnUrl: text('return_url'),
    paymentId: uuid('payment_id').references(() => agentPayments.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pay_links_user_idx').on(table.userId, table.createdAt),
    uniqueIndex('pay_links_merchant_reference_idx').on(table.merchantKeyId, table.reference),
  ],
);

export type PayLink = typeof payLinks.$inferSelect;

/**
 * A shop's secret key for making checkout invoices from its own server. It belongs to a 10kobo user, and the payout is
 * fixed on the key, so a leaked key can make invoices but can never change where the money goes.
 */
export const merchantKeys = pgTable('merchant_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Shown to payers, such as the shop's name. */
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  payoutBankName: text('payout_bank_name'),
  payoutAccountNumber: text('payout_account_number'),
  payoutToWallet: boolean('payout_to_wallet').notNull().default(false),
  /** USDC on Base to this address, or on NEAR to this account, instead of naira to a bank. */
  payoutUsdcAddress: text('payout_usdc_address'),
  payoutNearAccount: text('payout_near_account'),
  /** Websites a payer may be sent back to, such as https://shop.example. */
  returnOrigins: jsonb('return_origins').$type<string[]>().notNull().default([]),
  webhookUrl: text('webhook_url'),
  /** Signs paid notices so the shop can tell they came from us. It cannot move money. */
  webhookSecret: text('webhook_secret'),
  invoicesPerDay: integer('invoices_per_day').notNull().default(200),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export type MerchantKey = typeof merchantKeys.$inferSelect;

/** One notice to a shop's server. Each invoice gets at most one notice of each kind, and each is retried until it lands. */
export const merchantEvents = pgTable(
  'merchant_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: uuid('key_id').notNull().references(() => merchantKeys.id, { onDelete: 'cascade' }),
    linkId: uuid('link_id').notNull().references(() => payLinks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('merchant_events_link_type_idx').on(table.linkId, table.type), index('merchant_events_due_idx').on(table.deliveredAt, table.nextAttemptAt)],
);
