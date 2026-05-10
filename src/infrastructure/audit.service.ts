import type { PrismaClient } from '@prisma/client';

type ActorType = 'SuperAdmin' | 'ClientAdmin';

export class AuditService {
    constructor(private readonly db: PrismaClient) {}

    async log(args: {
        actorId: string;
        actorType: ActorType;
        action: string;
        orgId?: string;
        targetType?: string;
        targetId?: string;
        before?: string;
        after?: string;
        ipAddress?: string;
    }): Promise<void> {
        await this.db.auditLog.create({
            data: {
                actorId: args.actorId,
                actorType: args.actorType,
                action: args.action,
                orgId: args.orgId,
                targetType: args.targetType,
                targetId: args.targetId,
                beforeValue: args.before,
                afterValue: args.after,
                ipAddress: args.ipAddress,
            },
        });
    }
}
