import { createClient } from 'redis';

let client: ReturnType<typeof createClient>;

export class Cache {
  static async init() {
    client = createClient();
    await client.connect();
  }

  static async get<T>(key: string): Promise<T | null> {
    if (!client) await Cache.init();
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  }

  static async set(key: string, value: T, ttl?: number): Promise<void> {
    if (!client) await Cache.init();
    if (ttl) {
      await client.set(key, JSON.stringify(value), 'EX', ttl);
    } else {
      await client.set(key, JSON.stringify(value));
    }
  }

  static async del(key: string): Promise<void> {
    if (!client) await Cache.init();
    await client.del(key);
  }

  static async exists(key: string): Promise<boolean> {
    if (!client) await Cache.init();
    return (await client.exists(key)) > 0;
  }
}
