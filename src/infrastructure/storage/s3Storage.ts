import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

export class S3Storage {
    constructor(
        private readonly s3: S3Client,
        private readonly bucket: string,
    ) {}

    async upload(stream: Readable | Buffer, key: string, contentType = 'image/jpeg'): Promise<string> {
        await this.s3.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: stream,
            ContentType: contentType,
        }));
        return key;
    }

    async generateSignedUrl(key: string, expirySeconds: number): Promise<string> {
        return getSignedUrl(
            this.s3,
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
            { expiresIn: expirySeconds },
        );
    }

    async delete(key: string): Promise<void> {
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
}
