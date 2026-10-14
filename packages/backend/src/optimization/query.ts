import { prisma } from '../lib/prisma';

export function optimizeSearchQuery(filters: any): any {
  return filters;
}

export const queryCache = new Map<string, any>();

export function getCachedQuery(key: string): any {
  return queryCache.get(key);
}

export function setCachedQuery(key: string, value: any): void {
  queryCache.set(key, value);
}

export function clearExpiredCache(): void {
  const now = Date.now();
  for (const [key, value] of queryCache.entries()) {
    if (typeof value === 'object' && value?.timestamp) {
      const age = now - (value.timestamp as number);
      if (age > 300000) {
        queryCache.delete(key);
      }
    }
  }
}
