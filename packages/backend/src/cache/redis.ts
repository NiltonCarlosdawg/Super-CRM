import { redis } from '../lib/redis';

export class Cache {
  /** Obter valor do cache */
  static async get<T>(key: string): Promise<T | null> {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  }

  /** Definir valor do cache */
  static async set(key: string, value: T, ttl?: number): Promise<void> {
    if (ttl) {
      await redis.set(key, JSON.stringify(value), 'EX', ttl);
    } else {
      await redis.set(key, JSON.stringify(value));
    }
  }

  /** Excluir valor do cache */
  static async del(key: string): Promise<void> {
    await redis.del(key);
  }

  /** Verificar se chave existe */
  static async exists(key: string): Promise<boolean> {
    return (await redis.exists(key)) > 0;
  }
}
