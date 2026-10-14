import path from 'node:path';
import { WebSocketServer } from 'ws';

/** Formato aceite: `ping-<ISO 8601 UTC>`, ex.: `ping-2026-10-08T09:00:00.000Z`. */
const FORMATO_PING = /^ping-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Sonda de websockets do A5: sobe um servidor echo que responde `echo:<mensagem>`
 * a cada mensagem no formato `ping-<ISO>` e anuncia o arranque com uma linha JSON
 * `{"event":"ws_echo.listening","porta":<n>}` no stdout.
 */
export function criarServidorEcho(porta: number): Promise<{ porta: number; fechar(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const servidor = new WebSocketServer({ port: porta });
    let pronto = false;

    servidor.on('error', (erro: Error) => {
      if (!pronto) {
        reject(erro);
        return;
      }
      console.error(JSON.stringify({ event: 'ws_echo.server_error', erro: erro.message }));
    });

    servidor.on('connection', (socket) => {
      socket.on('error', (erro: Error) => {
        // erro de ligação tratado aqui: nunca sem handler (erro não tratado rebentaria o processo)
        console.error(JSON.stringify({ event: 'ws_echo.socket_error', erro: erro.message }));
      });
      socket.on('close', () => {
        // fecho normal da ligação: nada a fazer além de não deixar erro por tratar
      });
      socket.on('message', (dados) => {
        const mensagem = dados.toString();
        if (!FORMATO_PING.test(mensagem)) {
          // rejeita mensagens fora do formato
          socket.close(1003, 'mensagem fora do formato ping-<ISO>');
          return;
        }
        socket.send(`echo:${mensagem}`);
      });
    });

    servidor.on('listening', () => {
      pronto = true;
      const endereco = servidor.address();
      const portaEfetiva = typeof endereco === 'object' && endereco !== null ? endereco.port : porta;
      console.log(JSON.stringify({ event: 'ws_echo.listening', porta: portaEfetiva }));
      resolve({
        porta: portaEfetiva,
        fechar: () =>
          new Promise<void>((resolveFechar) => {
            for (const cliente of servidor.clients) {
              cliente.terminate();
            }
            servidor.close(() => resolveFechar());
          }),
      });
    });
  });
}

function portaDasVariaveis(bruta: string | undefined): number {
  const valor = bruta ?? '8787';
  if (!/^\d+$/.test(valor) || Number(valor) > 65535) {
    console.error(JSON.stringify({ event: 'ws_echo.invalid_port', valor }));
    process.exit(1);
  }
  return Number(valor);
}

const eEntrada = process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1]);

if (eEntrada) {
  criarServidorEcho(portaDasVariaveis(process.env.PORT)).catch((erro: unknown) => {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    console.error(JSON.stringify({ event: 'ws_echo.start_failed', erro: motivo }));
    process.exit(1);
  });
}
