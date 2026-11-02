import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { User } from '../database/schema';
import {
  IdentityProvider,
  IdentityUnavailableError,
  InvalidIdentityError,
} from '../identity/identity-provider';
import { UsersRepository } from '../users/users.repository';

export interface AuthenticatedRequest {
  headers: { authorization?: string };
  user: User;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityProvider,
    private readonly users: UsersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Sign in to continue');

    try {
      request.user = await this.users.upsert(await this.identity.verify(token));
      return true;
    } catch (error) {
      if (error instanceof InvalidIdentityError) throw new UnauthorizedException('Sign in to continue');
      if (error instanceof IdentityUnavailableError) {
        throw new ServiceUnavailableException('Sign-in is temporarily unavailable');
      }
      throw error;
    }
  }
}
