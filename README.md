# 10kobo backend

NestJS API on Fastify, with PostgreSQL and Drizzle. Project rules and decisions are in the parent
folder's `AGENTS.md`.

## Run it

```
cp .env.example .env      # then fill in the Privy values
npm install
npm run db:up             # PostgreSQL on port 54445
npm run db:migrate
npm run dev               # http://localhost:4010
```

## Check it

```
npm run typecheck
npm test
npm run test:e2e          # needs npm run db:up
```

## How outside services stay swappable

Each outside service sits behind one abstract class, and only its module names the real one.

| Abstract class | Used for | Current implementation |
| --- | --- | --- |
| `IdentityProvider` | who is calling | `PrivyIdentityProvider` |
| `ChatResponder` | the assistant's reply | `PlaceholderChatResponder` (no AI yet) |

To replace one, write a new class and change the `useClass` line in its module. Controllers, services
and the database stay as they are. The users table stores `provider_subject`, not a Privy-specific field.
