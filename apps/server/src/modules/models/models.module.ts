import { Module } from "@nestjs/common";
import { WalletModule } from "../billing/wallet.module";
import { UserAccessModule } from "../users/user-access.module";
import { ModelsController } from "./models.controller";
import { ModelsService } from "./models.service";

@Module({
  imports: [WalletModule, UserAccessModule],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService]
})
export class ModelsModule {}
