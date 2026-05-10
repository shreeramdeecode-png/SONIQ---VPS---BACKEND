import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

export class LocalFileStorage {
    constructor(private readonly basePath: string) {}

    async upload(stream: Readable | Buffer, key: string, _contentType = 'image/jpeg'): Promise<string> {
        const fullPath = join(this.basePath, key.split('/').join(sep));
        await mkdir(dirname(fullPath), { recursive: true });

        if (Buffer.isBuffer(stream)) {
            await writeFile(fullPath, stream);
        } else {
            await pipeline(stream, createWriteStream(fullPath));
        }

        return key;
    }

    async generateSignedUrl(key: string, _expirySeconds: number): Promise<string> {
        return `/screenshots/${key.split(sep).join('/')}`;
    }

    async delete(key: string): Promise<void> {
        const fullPath = join(this.basePath, key.split('/').join(sep));
        if (existsSync(fullPath)) await unlink(fullPath);
    }
}
