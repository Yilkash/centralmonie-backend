import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The identity provider's ID for this person, so that provider stays swappable.
  providerSubject: text('provider_subject').notNull().unique(),
  email: text('email'),
  walletAddress: text('wallet_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatRole = pgEnum('chat_role', ['user', 'assistant']);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    content: text('content').notNull(),
    // A card shown with the message. Plain IDs: these tables are declared further down.
    planId: uuid('plan_id'),
    contactId: uuid('contact_id'),
    // Written by the app rather than typed by the user: the model reads it, the chat does not show it.
    hidden: boolean('hidden').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('chat_messages_user_created_idx').on(table.userId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

export const contactStatus = pgEnum('contact_status', ['proposed', 'confirmed']);
export const destinationKind = pgEnum('destination_kind', ['phone', 'bank', 'wallet']);
export const paymentRoute = pgEnum('payment_route', ['airtime', 'data', 'bank', 'usdc']);
export const planStatus = pgEnum('plan_status', ['proposed', 'approved', 'rejected', 'expired']);
export const paymentStatus = pgEnum('payment_status', ['pending', 'completed', 'failed']);

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
});

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // One payment per approved item, so approving twice can never pay twice.
    planItemId: uuid('plan_item_id').notNull().unique().references(() => planItems.id),
    route: paymentRoute('route').notNull(),
    amountKobo: bigint('amount_kobo', { mode: 'number' }).notNull(),
    usdcMinor: bigint('usdc_minor', { mode: 'number' }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    providerReference: text('provider_reference'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('payments_user_created_idx').on(table.userId, table.createdAt)],
);

export type Contact = typeof contacts.$inferSelect;
export type ContactDestination = typeof contactDestinations.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanItem = typeof planItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
