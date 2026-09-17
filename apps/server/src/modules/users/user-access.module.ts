import { Module } from "@nestjs/common";
import { UserAccessService } from "./user-access.service";

@Module({
  providers: [UserAccessService],
  exports: [UserAccessService]
})
export class UserAccessModule {}
