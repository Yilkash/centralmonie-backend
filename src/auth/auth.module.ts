import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { UsersRepository } from '../users/users.repository';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [IdentityModule],
  providers: [AuthGuard, UsersRepository],
  exports: [AuthGuard, IdentityModule, UsersRepository],
})
export class AuthModule {}
