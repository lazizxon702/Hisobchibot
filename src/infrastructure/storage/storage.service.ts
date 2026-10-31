import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';

export interface UploadResult {
  storagePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client | null = null;
  private readonly bucket: string;
  private readonly driver: 's3' | 'local';
  private readonly localDir: string;

  constructor() {
    this.driver = (process.env.STORAGE_DRIVER as 's3' | 'local') || 'local';
    this.bucket = process.env.S3_BUCKET || 'hisobchi-private';
    this.localDir = process.env.LOCAL_STORAGE_DIR || './uploads';

    if (this.driver === 's3') {
      const endpoint = process.env.S3_ENDPOINT || 'localhost';
      const port = process.env.S3_PORT || '9000';
      const useSSL = process.env.S3_USE_SSL === 'true';
      const protocol = useSSL ? 'https' : 'http';

      this.s3Client = new S3Client({
        endpoint: `${protocol}://${endpoint}:${port}`,
        region: process.env.S3_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
          secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
        },
        forcePathStyle: true,
      });
      this.logger.log(`Storage configured for S3 (${protocol}://${endpoint}:${port}, bucket: ${this.bucket})`);
    } else {
      if (!fs.existsSync(this.localDir)) {
        fs.mkdirSync(this.localDir, { recursive: true });
      }
      this.logger.log(`Storage configured for local directory: ${this.localDir}`);
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    folder: string = 'general',
  ): Promise<UploadResult> {
    const cleanFileName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const storagePath = `${folder}/${cleanFileName}`;

    if (this.driver === 's3' && this.s3Client) {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storagePath,
          Body: buffer,
          ContentType: mimeType,
        }),
      );
    } else {
      const targetFolder = path.join(this.localDir, folder);
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true });
      }
      const fullPath = path.join(this.localDir, storagePath);
      await fs.promises.writeFile(fullPath, buffer);
    }

    return {
      storagePath,
      fileName,
      mimeType,
      fileSize: buffer.length,
    };
  }

  async getFileBuffer(storagePath: string): Promise<Buffer> {
    if (this.driver === 's3' && this.s3Client) {
      const res = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: storagePath,
        }),
      );
      const stream = res.Body as any;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks);
    } else {
      const fullPath = path.join(this.localDir, storagePath);
      return await fs.promises.readFile(fullPath);
    }
  }

  async getSignedDownloadUrl(storagePath: string, expiresInSeconds: number = 300): Promise<string> {
    if (this.driver === 's3' && this.s3Client) {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: storagePath,
      });
      return await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
    } else {
      // For local development, return local file endpoint URI
      return `/api/attachments/download?path=${encodeURIComponent(storagePath)}`;
    }
  }
}
