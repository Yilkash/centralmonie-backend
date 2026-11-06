import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { getAddress, isAddress } from 'viem';
import { chainFromAddress, chainNamed, CHAIN_NAMES, isMoveAddress, USDC_CHAINS } from '../chain/usdc-chains';
import { DATABASE, Database } from '../database/database.module';
import { Contact, ContactDestination, contactDestinations, contacts } from '../database/schema';
import { BankLookup, PHONE_NETWORKS } from '../providers/providers';

export type NewDestination =
  | { kind: 'phone'; phone: string }
  | { kind: 'bank'; bankName: string; accountNumber: string }
  | { kind: 'wallet'; walletAddress: string; chain?: string | null };

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
        const address = destination.walletAddress.trim();
        const named = chainNamed(destination.chain);
        if (destination.chain?.trim() && !named) throw new ContactRefused(`I cannot send USDC to ${destination.chain.trim()} yet. I can send to ${CHAIN_NAMES}.`);
        const own = chainFromAddress(address);
        if (named && own && named.key !== own.key) throw new ContactRefused(`That is a ${own.name} address, not a ${named.name} one. Please check the address or the network.`);
        if (!named && isMoveAddress(address)) throw new ContactRefused('That looks like a Sui or Aptos address. Which network is it on?');
        const chain = named ?? own ?? USDC_CHAINS.base;
        if (isAddress(address, { strict: false }) && !isAddress(address)) throw new ContactRefused('That address has a mistake in it: its capital letters do not match its checksum. Please copy it again.');
        if (!chain.valid(address)) throw new ContactRefused(`That is not a valid ${chain.name} address. Please check it was copied in full. I can send to ${CHAIN_NAMES}.`);
        if (address.toLowerCase() === chain.usdc.toLowerCase() || address === chain.usdc) throw new ContactRefused(`That is the USDC token contract on ${chain.name}, not a wallet. Anything sent there is lost.`);
        const isEvm = isAddress(address);
        return { kind: 'wallet' as const, walletAddress: isEvm ? getAddress(address) : address, network: chain.key === 'base' ? null : chain.key };
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

  /** Only the name a person sees changes. Where the money goes stays exactly as it was approved. */
  async rename(userId: string, contactId: string, name: string): Promise<void> {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (clean.length < 1 || clean.length > 60) throw new ContactRefused('A name needs 1 to 60 characters.');
    const updated = await this.db
      .update(contacts)
      .set({ name: clean })
      .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId), eq(contacts.status, 'confirmed')))
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
