import { ContactsService } from '../contacts/contacts.service';
import { PaymentRoute, ProposedItem } from './plan.types';
import { PlansService, PlanView } from './plans.service';

/** A payment to a saved recipient, or to someone new whose details come with it. */
export interface PaymentRequestItem {
  route: PaymentRoute;
  destinationId: string | null;
  amountNaira: number | null;
  amountUsdc: string | null;
  dataPlanId: string | null;
  newRecipient?: { name?: string | null; phone?: string | null; walletAddress?: string | null; walletChain?: string | null; bankName?: string | null; accountNumber?: string | null } | null;
}

export class RecipientMissing extends Error {}

/**
 * The one way payments are proposed, from the chat or the Send page. A new recipient is stored unconfirmed and
 * saved only when the plan is approved, so the single approval card is the user's check of both. If the plan is
 * refused, the unconfirmed recipients are removed again.
 */
export async function proposeWithRecipients(contacts: ContactsService, plans: PlansService, userId: string, items: PaymentRequestItem[]): Promise<PlanView> {
  const created: string[] = [];
  const resolved: ProposedItem[] = [];
  try {
    for (const item of items) {
      let destinationId = item.destinationId;
      const isNew = destinationId === null;
      if (isNew) {
        const fresh = item.newRecipient ?? {};
        const phone = item.route === 'airtime' || item.route === 'data' ? fresh.phone?.trim() || null : null;
        const walletAddress = item.route === 'usdc' ? fresh.walletAddress?.trim() || null : null;
        const bank = item.route === 'bank' && fresh.bankName && fresh.accountNumber ? { bankName: fresh.bankName, accountNumber: fresh.accountNumber.trim() } : null;
        if (!phone && !walletAddress && !bank) throw new RecipientMissing('That payment needs a saved recipient first.');
        const contact = await contacts.propose(
          userId,
          fresh.name?.trim() || phone || walletAddress || '',
          [],
          phone ? { kind: 'phone', phone } : walletAddress ? { kind: 'wallet', walletAddress, chain: fresh.walletChain ?? null } : { kind: 'bank', ...bank! },
        );
        created.push(contact.id);
        destinationId = contact.destinations[0]!.id;
      }
      resolved.push({ route: item.route, destinationId: destinationId!, amountNaira: item.amountNaira, amountUsdc: item.amountUsdc, dataPlanId: item.dataPlanId, newRecipient: isNew });
    }
    return await plans.propose(userId, resolved);
  } catch (error) {
    await Promise.all(created.map((id) => contacts.discard(userId, id).catch(() => undefined)));
    throw error;
  }
}
