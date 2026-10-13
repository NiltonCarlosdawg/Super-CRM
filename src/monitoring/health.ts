import { prisma } from '../lib/prisma';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: CheckResult[];
  timestamp: Date;
}

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
}

export async function checkDatabase(): Promise<CheckResult> {
  try {
    await prisma.$executeRaw`SELECT 1`;
    return { name: 'database', status: 'pass', message: 'Conexão OK' };
  } catch (error) {
    return { name: 'database', status: 'fail', message: error.message };
  }
}

export async function checkRedis(): Promise<CheckResult> {
  try {
    const { execSync } = await import('child_process');
    execSync('redis-cli ping', { stdio: 'pipe' });
    return { name: 'redis', status: 'pass', message: 'PONG' };
  } catch (error) {
    return { name: 'redis', status: 'fail', message: error.message };
  }
}

export async function checkPostgres(): Promise<CheckResult> {
  try {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    const client = await pool.connect();
    await client.query('SELECT 1');
    await client.end();
    return { name: 'postgres', status: 'pass', message: 'Conexão OK' };
  } catch (error) {
    return { name: 'postgres', status: 'fail', message: error.message };
  }
}

export async function checkHealth(): Promise<HealthStatus> {
  const checks = await Promise.all([checkDatabase(), checkRedis(), checkPostgres()]);
  const allPass = checks.every(c => c.status === 'pass');
  
  const status = allPass ? 'healthy' : allPass && checks.some(c => c.status === 'warning') ? 'degraded' : 'unhealthy';

  return {
    status,
    checks,
    timestamp: new Date(),
  };
}

export default checkHealth;
