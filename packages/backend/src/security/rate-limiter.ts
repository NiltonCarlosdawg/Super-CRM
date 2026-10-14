import type { Request, Response, NextFunction } from 'express';

export function rateLimiter(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Simples rate limiter em memória
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // Em produção, usaria Redis para persistência
    let requests = rateLimiter.requests || {};
    requests[ip] = (requests[ip] || 0) + 1;
    
    if (requests[ip] > maxRequests) {
      return res.status(429).json({ error: 'Limite de requests excedido' });
    }
    
    next();
  };
  
  // Limpar expired requests periodicamente (simplificado)
  setInterval(() => {
    const now = Date.now();
    const keys = Object.keys(rateLimiter.requests || {});
    for (const key of keys) {
      if (rateLimiter.requests![key] < maxRequests) {
        delete rateLimiter.requests![key];
      }
    }
  }, windowMs);
}
