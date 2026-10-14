import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'API Key required' });
  }
  
  // Validar API key (simples verificação neste exemplo)
  // Em produção, isso consultaria o banco de dados
  if (apiKey === 'test-key') {
    next();
  } else {
    return res.status(403).json({ error: 'Invalid API Key' });
  }
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    // Validar API key (simples verificação)
    req.user = { userId: '1', role: 'agent' };
  }
  next();
}
