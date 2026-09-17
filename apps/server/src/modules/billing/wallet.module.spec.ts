import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Global, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../common/prisma.service";
import { RateLimitService } from "../../common/rate-limit.service";
import { ModelsModule } from "../models/models.module";
import { ModelsService } from "../models/models.service";
import { UserAccessService } from "../users/user-access.service";
import { UsersModule } from "../users/users.module";
import { UsersService } from "../users/users.service";
import { WalletService } from "./wallet.service";

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useValue: {
        user: {
          findUnique: async ({ where }: { where: { id: string } }) => where.id === "missing"
            ? null
            : { id: where.id, role: where.id === "admin" ? UserRole.ADMIN : UserRole.USER }
        },
        modelProviderConfig: { findMany: async () => [] }
      }
    },
    { provide: RateLimitService, useValue: {} }
  ],
  exports: [PrismaService, RateLimitService]
})
class StubInfrastructureModule {}

@Module({ imports: [StubInfrastructureModule, ModelsModule, UsersModule] })
class WalletDependencyFixtureModule {}

test("models and users resolve their wallet and access dependencies without external infrastructure", async (t) => {
  const context = await NestFactory.createApplicationContext(WalletDependencyFixtureModule, { logger: false, abortOnError: false });
  t.after(() => context.close());
  assert.ok(context.get(WalletService) instanceof WalletService);
  const models = context.get(ModelsService);
  const users = context.get(UsersService);
  const access = context.get(UserAccessService);

  assert.deepEqual(await models.availableProviders("user"), []);
  assert.deepEqual(await models.adminProviders("admin"), []);
  await assert.rejects(models.adminProviders("user"), /Admin permission required/);
  await assert.rejects(models.availableProviders("missing"), /User not found/);
  assert.equal((await users.ensureUser("user")).id, "user");
  await assert.rejects(users.assertAdmin("user"), /Admin permission required/);
  await assert.rejects(access.ensureUser("missing"), /User not found/);
});
