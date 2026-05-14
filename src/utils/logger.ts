import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function todayLogPath(): string {
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(process.cwd(), 'logs', date);
    mkdirSync(dir, { recursive: true });
    return join(dir, 'app.log');
}

export function getLoggerOptions() {
    const level = process.env['LOG_LEVEL'] ?? 'info';
    const isProduction = process.env['NODE_ENV'] === 'production';

    return {
        level,
        transport: isProduction
            ? undefined  // stdout by default in production (Render captures this)
            : { target: 'pino/file', options: { destination: todayLogPath() } },
    };
}
