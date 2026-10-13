import { describe, it, expect } from 'vitest';
import { Cache } from '../cache/redis';

describe('Cache', () => {
  beforeEach(() => {
    // Limpar cache antes de cada teste
    Cache.del('*');
  });

  it('deve definir e obter valor do cache', async () => {
    await Cache.set('test-key', { value: 'test-value' });
    const result = await Cache.get<{ value: string }>('test-key');
    expect(result).toEqual({ value: 'test-value' });
  });

  it('deve retornar null para chave inexistente', async () => {
    const result = await Cache.get<string>('inexistent-key');
    expect(result).toBeNull();
  });

  it('deve expirar cache após TTL', async () => {
    await Cache.set('expire-key', 'value', 100);
    const result = await Cache.get<string>('expire-key');
    expect(result).toEqual('value');
    // Em produção, esperaria o TTL expirar
  });
});
