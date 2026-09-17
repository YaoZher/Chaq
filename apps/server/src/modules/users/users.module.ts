import { Module } from "@nestjs/common";
import { WalletModule } from "../billing/wallet.module";
import { UserAccessModule } from "./user-access.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [WalletModule, UserAccessModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService]
})
export class UsersModule {}
