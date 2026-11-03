import { Module } from '@nestjs/common';
import { AdminController, AdminGuard, SponsorshipController } from './admin.controller';

@Module({ controllers: [AdminController, SponsorshipController], providers: [AdminGuard] })
export class AdminModule {}
