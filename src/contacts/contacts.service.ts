import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';
import { DATABASE, Database } from '../database/database.module';
import { Contact, ContactDestination, contactDestinations, contacts } from '../database/schema';
import { BankLookup, PHONE_NETWORKS } from '../providers/providers';

export type NewDestination =
  | { kind: 'phone'; phone: string }
  | { kind: 'bank'; bankName: string; accountNumber: string }
  | { kind: 'wallet'; walletAddress: string };

export interface ContactWithDestinations extends Contact {
  destinations: ContactDestination[];
}

/** A request that cannot be met as asked. The message is safe to show or give to the agent. */
export class ContactRefused extends Error {}

const normalisePhone = (raw: string): string | null => {
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+?234/, '0');
  return /^0\d{10}$/.test(digits) ? digits : null;
};

@Injectable()
export class ContactsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly banks: BankLookup,
  ) {}

  /** Checks the destination, then stores it unconfirmed. Plans can only use it once the user confirms. */
  async propose(userId: string, name: string, aliases: string[], destination: NewDestination): Promise<ContactWithDestinations> {
    const details = await this.checked(destination);
    return this.db.transaction(async (tx) => {
      // With no name given, a bank account goes by the name the bank holds for it.
      const [contact] = await tx.insert(contacts).values({ userId, name: name.trim() || details.accountName || '', aliases }).returning();
      const [saved] = await tx.insert(contactDestinations).values({ contactId: contact!.id, ...details }).returning();
      return { ...contact!, destinations: [saved!] };
    });
  }

  private async checked(destination: NewDestination) {
    switch (destination.kind) {
      case 'phone': {
        const phone = normalisePhone(destination.phone);
        if (!phone) throw new ContactRefused('That is not a valid Nigerian phone number.');
        const network = PHONE_NETWORKS[phone.slice(0, 4)];
        if (!network) throw new ContactRefused('I could not tell the network for that phone number.');
        return { kind: 'phone' as const, phone, network };
      }
      case 'bank': {
        if (!/^\d{10}$/.test(destination.accountNumber)) throw new ContactRefused('A bank account number has 10 digits.');
        const accountName = await this.banks.accountName(destination.bankName, destination.accountNumber).catch(() => {
          throw new ContactRefused('I could not check that account with the bank just now. Please try again in a moment.');
        });
        if (!accountName) throw new ContactRefused('I could not find that account. Please check the number and bank.');
        return { kind: 'bank' as const, bankName: destination.bankName, accountNumber: destination.accountNumber, accountName };
      }
      case 'wallet': {
        if (isAddress(destination.walletAddress, { strict: false }) && !isAddress(destination.walletAddress)) {
          throw new ContactRefused('That address has a mistake in it: its capital letters do not match its checksum. Please copy it again.');
        }
        if (!isAddress(destination.walletAddress)) {
          throw new ContactRefused('That is not a valid Base wallet address. It should start with 0x and have 42 characters. Addresses from networks such as Solana or Tron cannot be used.');
        }
        return { kind: 'wallet' as const, walletAddress: getAddress(destination.walletAddress) };
      }
    }
  }

  async confirm(userId: string, contactId: string): Promise<void> {
    const updated = await this.db
      .update(contacts)
      .set({ status: 'confirmed' })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
      .returning({ id: contacts.id });
    if (updated.length === 0) throw new NotFoundException('Contact not found');
  }

  async discard(userId: string, contactId: string): Promise<void> {
    const deleted = await this.db
      .delete(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId), eq(contacts.status, 'proposed')))
      .returning({ id: contacts.id });
    if (deleted.length === 0) throw new NotFoundException('Contact not found');
  }

  async get(userId: string, contactId: string): Promise<ContactWithDestinations | null> {
    const [contact] = await this.withDestinations(
      await this.db.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.userId, userId))),
    );
    return contact ?? null;
  }

  async listConfirmed(userId: string): Promise<ContactWithDestinations[]> {
    return this.withDestinations(
      await this.db.select().from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.status, 'confirmed'))).limit(200),
    );
  }

  /** A destination the user owns through a confirmed contact, and nothing else. */
  async usableDestination(userId: string, destinationId: string): Promise<{ contact: Contact; destination: ContactDestination } | null> {
    const [row] = await this.db
      .select({ contact: contacts, destination: contactDestinations })
      .from(contactDestinations)
      .innerJoin(contacts, eq(contactDestinations.contactId, contacts.id))
      .where(and(eq(contactDestinations.id, destinationId), eq(contacts.userId, userId), eq(contacts.status, 'confirmed')));
    return row ?? null;
  }

  /** A phone, wallet or bank account the user gave just now for a plan, which approving that plan will save. */
  async newDestination(userId: string, destinationId: string, kind: 'phone' | 'wallet' | 'bank'): Promise<{ contact: Contact; destination: ContactDestination } | null> {
    const [row] = await this.db
      .select({ contact: contacts, destination: contactDestinations })
      .from(contactDestinations)
      .innerJoin(contacts, eq(contactDestinations.contactId, contacts.id))
      .where(and(eq(contactDestinations.id, destinationId), eq(contacts.userId, userId), eq(contacts.status, 'proposed'), eq(contactDestinations.kind, kind)));
    return row ?? null;
  }

  private async withDestinations(rows: Contact[]): Promise<ContactWithDestinations[]> {
    if (rows.length === 0) return [];
    const destinations = await this.db
      .select()
      .from(contactDestinations)
      .where(inArray(contactDestinations.contactId, rows.map((row) => row.id)));
    return rows.map((row) => ({ ...row, destinations: destinations.filter((d) => d.contactId === row.id) }));
  }
}

export function describeDestination(destination: ContactDestination): string {
  switch (destination.kind) {
    case 'phone':
      return `${destination.phone} (${destination.network})`;
    case 'bank':
      return `${destination.accountName}, ${destination.bankName} ****${destination.accountNumber?.slice(-4)}`;
    case 'wallet':
      return `${destination.walletAddress?.slice(0, 6)}…${destination.walletAddress?.slice(-4)}`;
  }
}
