import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { User, UserRole } from "@prisma/client";
import { PrismaService } from "../../common/prisma.service";

@Injectable()
export class UserAccessService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async ensureUser(userId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found.");
    return user;
  }

  async assertAdmin(userId: string): Promise<void> {
    const user = await this.ensureUser(userId);
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException("Admin permission required.");
    }
  }
}
