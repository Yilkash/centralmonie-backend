import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainModule } from './chain/chain.module';
import { ChatModule } from './chat/chat.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WalletModule } from './wallet/wallet.module';
import { validateEnv } from './config/env';
import { ContactsModule } from './contacts/contacts.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { PlansModule } from './plans/plans.module';
import { AdminModule } from './ops/admin.module';
import { OpsModule } from './ops/ops.module';
import { PinModule } from './pin/pin.module';
import { SchedulesModule } from './schedules/schedules.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // Tests must never read a developer's .env, or they could reach real services with real keys.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, ignoreEnvFile: process.env.NODE_ENV === 'test' }),
    DatabaseModule,
    ChainModule,
    NotificationsModule,
    WalletModule,
    UsersModule,
    ChatModule,
    ContactsModule,
    PlansModule,
    OpsModule,
    PinModule,
    AdminModule,
    SchedulesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
