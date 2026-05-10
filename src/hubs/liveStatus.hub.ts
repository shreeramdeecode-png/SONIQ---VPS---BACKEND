import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

export interface EmployeeActivePayload {
    employeeId: string;
    status: string;
    timestamp: string;
}

export function setupLiveStatusHub(httpServer: unknown, clientSecret: string): Server {
    const io = new Server(httpServer as any, {
        cors: { origin: '*' },
        path: '/socket.io',
    });

    io.use((socket, next) => {
        const token =
            (socket.handshake.auth['token'] as string | undefined) ??
            (socket.handshake.headers.authorization as string | undefined)?.slice(7);

        if (!token) return next(new Error('Unauthorized'));

        try {
            const payload = jwt.verify(token, clientSecret) as { org_id?: string };
            socket.data['orgId'] = payload.org_id;
            next();
        } catch {
            next(new Error('Unauthorized'));
        }
    });

    io.on('connection', async (socket) => {
        const orgId = socket.data['orgId'] as string | undefined;
        if (orgId) {
            await socket.join(`org_${orgId}`);
        }
        // Socket.io removes from rooms automatically on disconnect
    });

    return io;
}

export function broadcastEmployeeActive(
    io: Server,
    orgId: string,
    payload: EmployeeActivePayload,
): void {
    io.to(`org_${orgId}`).emit('EmployeeActive', payload);
}
