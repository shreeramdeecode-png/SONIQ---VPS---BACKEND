import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function todayLogPath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = join(process.cwd(), 'logs', date);
    mkdirSync(dir, { recursive: true });
    return join(dir, 'app.log');
}

export function getLoggerOptions() {
    return {
        level: process.env['LOG_LEVEL'] ?? 'info',
        transport: {
            target: 'pino/file',
            options: { destination: todayLogPath() },
        },
    };
}
