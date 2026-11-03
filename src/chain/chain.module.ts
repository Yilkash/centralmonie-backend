import { Global, Module } from '@nestjs/common';
import { Chain, ViemChain } from './chain.service';

@Global()
@Module({ providers: [{ provide: Chain, useClass: ViemChain }], exports: [Chain] })
export class ChainModule {}
