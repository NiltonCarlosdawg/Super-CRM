// Fase 1, Task 13: mock HTTP efémero FIEL a docs/wa-akg-audit.md §A (+ errata).
// Um caminho por endpoint usado pelo port, com o envelope de resposta real da
// auditoria, auth `x-api-key` (A1), 401 de chave errada, 400 de validação,
// JSON malformado (`malformed`) e rota lenta (`slow` > sendTimeoutMs).
// Fixture `/fixtures/foto.jpg` serve o download de mídia do adaptador (não é
// endpoint da auditoria — é suporte de teste).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface StartMockWaAkgOptions {
  /** Todos os /api respondem 401 mesmo com a chave certa (chave rodada/certa errada). */
  failAuth?: boolean;
  /** Todos os /api respondem 200 com corpo que NÃO é o envelope documentado. */
  malformed?: boolean;
  /** O envio de texto demora mais que qualquer sendTimeoutMs do teste. */
  slow?: boolean;
}

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockWaAkg {
  baseUrl: string;
  received: MockRequest[];
  close(): Promise<void>;
}

const SLOW_DELAY_MS = 250;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 0 ? text : undefined;
  }
}

export function startMockWaAkg(opts: StartMockWaAkgOptions = {}): Promise<MockWaAkg> {
  const received: MockRequest[] = [];
  let sendCount = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const rawPath = req.url ?? '/';
      const method = req.method ?? 'GET';
      const raw = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      received.push({ method, path: rawPath, headers, body: parseJson(raw) });

      // fixture de mídia: fora do /api, sem auth (o adaptador nunca envia a
      // chave do WA-AKG para o host da mediaUrl)
      if (method === 'GET' && rawPath === '/fixtures/foto.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '3' });
        res.end(Buffer.from([1, 2, 3]));
        return;
      }

      // auth A1: x-api-key exacta
      if (opts.failAuth === true || headers['x-api-key'] !== 'test-key') {
        sendJson(res, 401, { status: false, message: 'Unauthorized', error: 'Unauthorized' });
        return;
      }

      if (opts.malformed === true) {
        sendJson(res, 200, { foo: 'isto nao e o envelope documentado' });
        return;
      }

      const json = (status: number, body: unknown, delayMs = 0): void => {
        if (delayMs > 0) setTimeout(() => sendJson(res, status, body), delayMs);
        else sendJson(res, status, body);
      };

      // ---- sessões -------------------------------------------------------
      if (method === 'POST' && rawPath === '/api/sessions') {
        const parsed = parseJson(raw) as { name?: string } | undefined;
        if (parsed?.name === undefined || parsed.name.length === 0) {
          json(400, { status: false, message: 'name required', error: 'name required' });
          return;
        }
        json(200, {
          status: true,
          message: 'Session created successfully',
          data: { sessionId: 'mock-created-1', name: parsed.name, status: 'STOPPED' },
        });
        return;
      }
      if (method === 'GET' && rawPath === '/api/sessions') {
        json(200, { status: true, message: 'Sessions retrieved successfully', data: [] });
        return;
      }
      if (method === 'GET' && rawPath.endsWith('/qr')) {
        json(200, { success: true, qr: 'QR-MOCK', base64: 'data:image/png;base64,QQ==' });
        return;
      }
      if (method === 'POST' && rawPath.endsWith('/logout')) {
        json(200, { status: true, message: 'Session loggedOuted successfully' });
        return;
      }
      if (method === 'GET' && /^\/api\/sessions\/[^/]+$/.test(rawPath)) {
        const sid = decodeURIComponent(rawPath.slice('/api/sessions/'.length));
        if (sid === 'inexistente') {
          json(404, { status: false, message: 'Session not found', error: 'Session not found' });
          return;
        }
        json(200, { status: true, message: 'Session details retrieved', data: { sessionId: sid, status: 'CONNECTED', qr: null } });
        return;
      }

      // ---- mensagens -----------------------------------------------------
      if (method === 'POST' && rawPath.endsWith('/send')) {
        const parsed = parseJson(raw) as { message?: string } | undefined;
        if (typeof parsed?.message !== 'string' || parsed.message.length === 0) {
          json(400, { status: false, message: 'message required', error: 'message required' });
          return;
        }
        sendCount += 1;
        json(200,
          { status: true, message: 'Operation successful', data: { key: { id: `wamid.MOCK${sendCount}` } } },
          opts.slow === true ? SLOW_DELAY_MS : 0);
        return;
      }
      if (method === 'POST' && rawPath.endsWith('/media')) {
        json(200, { status: true, message: 'Operation successful', data: { key: { id: 'wamid.MOCKMEDIA1' } } });
        return;
      }

      sendJson(res, 404, { status: false, message: 'Route not found', error: 'Route not found' });
    })().catch(() => {
      if (!res.writableEnded) res.writeHead(500).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('mock: porta efémera indisponível');
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
