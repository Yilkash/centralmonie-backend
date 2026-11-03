import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Schedule, User } from '../database/schema';
import { formatNaira, formatUsdc } from '../money/money';
import { PinService } from '../pin/pin.service';
import { PlanRefused } from '../plans/plan-refused';
import { pinIn } from '../plans/plans.controller';
import { ScheduleGroupView, SchedulesService, whenOf } from './schedules.service';

const activateBody = z.object({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

export const presentSchedule = (schedule: Schedule) => ({
  id: schedule.id,
  group_id: schedule.groupId,
  status: schedule.status,
  route: schedule.route,
  recipient_name: schedule.recipientName,
  recipient_detail: schedule.recipientDetail,
  data_plan: schedule.dataPlan,
  amount: schedule.fixedUsdcMinor !== null ? formatUsdc(schedule.fixedUsdcMinor) : formatNaira(schedule.amountKobo),
  when: whenOf(schedule),
  next_run_at: schedule.nextRunAt,
  last_error: schedule.lastError,
});

export const presentGroup = (group: ScheduleGroupView) => ({
  group_id: group.groupId,
  status: group.status,
  items: group.items.map(presentSchedule),
  calls: group.calls,
});

const refusals = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PlanRefused) throw new UnprocessableEntityException(error.message);
    throw error;
  }
};

@Controller('v1/schedules')
@UseGuards(AuthGuard)
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly pins: PinService,
  ) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return { schedules: (await this.schedules.list(user.id)).map(presentSchedule) };
  }

  @Post('groups/:id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    await this.pins.check(user, pinIn(body));
    return refusals(async () => presentGroup(await this.schedules.approve(user, id)));
  }

  @Post('groups/:id/activate')
  @HttpCode(200)
  activate(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = activateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException('A transaction hash is required');
    return refusals(async () => presentGroup(await this.schedules.activate(user.id, id, parsed.data.tx_hash)));
  }

  @Post('groups/:id/abandon')
  @HttpCode(200)
  async abandon(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentGroup(await this.schedules.abandon(user.id, id));
  }

  @Post('groups/:id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return presentGroup(await this.schedules.reject(user.id, id));
  }

  /** Stops it at once. The returned calls also remove the permission from the wallet. */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const { schedule, calls } = await this.schedules.cancel(user.id, id);
    return { ...presentSchedule(schedule), calls };
  }
}
