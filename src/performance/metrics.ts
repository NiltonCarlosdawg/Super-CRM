import { prisma } from '../lib/prisma';

export interface PerformanceMetrics {
  totalRequests: number;
  averageResponseTime: number;
  errorRate: number;
  requestsByEndpoint: Record<string, number>;
  requestsPerMinute: number;
}

export async function getMetrics(): Promise<PerformanceMetrics> {
  const totalRequests = await prisma.message.count();
  
  const errorCount = await prisma.message.count({
    where: { status: 'failed' },
  });
  
  const errorRate = totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;
  
  return {
    totalRequests,
    averageResponseTime: 0, // Placeholder
    errorRate,
    requestsByEndpoint: {}, // Placeholder
    requestsPerMinute: 0, // Placeholder
  };
}

export function logPerformance(operation: string, duration: number): void {
  console.log(`Performance [${operation}]: ${duration}ms`);
}
