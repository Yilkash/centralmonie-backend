import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('chat_messages_user_created_idx').on(table.userId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
