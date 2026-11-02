export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  walletAddress: string | null;
}

/** The token is missing, forged or expired. The caller should sign in again. */
export class InvalidIdentityError extends Error {}

/** The provider could not be reached. Nothing is known about the token. */
export class IdentityUnavailableError extends Error {}

/**
 * Who is calling. The rest of the app depends on this, never on a provider,
 * so replacing Privy means writing one new class.
 */
export abstract class IdentityProvider {
  abstract verify(token: string): Promise<VerifiedIdentity>;
}
