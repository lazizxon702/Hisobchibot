import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isConnected = false;

  async onModuleInit() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.client = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 1000)),
        lazyConnect: true,
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('Redis connected successfully');
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.logger.warn(`Redis connection error: ${err.message}`);
      });

      await this.client.connect().catch((err) => {
        this.logger.warn(`Redis initial connect failed: ${err.message}. Running in fallback mode.`);
      });
    } catch (e) {
      this.logger.warn(`Redis setup failed: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }

  async acquireLock(key: string, ttlSeconds: number = 10): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      return true; // Fallback to allowing if Redis is unavailable
    }
    try {
      const lockKey = `lock:${key}`;
      const res = await this.client.set(lockKey, 'locked', 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (e) {
      this.logger.warn(`Error acquiring lock for key ${key}: ${(e as Error).message}`);
      return true;
    }
  }

  async releaseLock(key: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.del(`lock:${key}`);
    } catch (e) {
      this.logger.warn(`Error releasing lock for key ${key}: ${(e as Error).message}`);
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client || !this.isConnected) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch (e) {
      this.logger.warn(`Error setting key ${key}: ${(e as Error).message}`);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.del(key);
    } catch (e) {
      this.logger.warn(`Error deleting key ${key}: ${(e as Error).message}`);
    }
  }

  isHealthy(): boolean {
    return this.isConnected;
  }
}
