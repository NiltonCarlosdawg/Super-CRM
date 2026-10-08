import WebSocket from 'ws';

/** Espera máximo pelo `echo:` (A5: sonda de websockets do cPanel). */
const TIMEOUT_MS = 5000;

function falhar(motivo: string): void {
  console.log(`WS_FAIL motivo=${motivo}`);
  process.exitCode = 1;
}

/**
 * Sonda de websockets do A5.
 *
 * Uso: `tsx scripts/ws-echo-client.ts <url-ws>`
 * Envia `ping-<ISO>`, espera `echo:` até 5000 ms e termina com
 * `WS_OK rtt=<n>ms` (exit 0) ou `WS_FAIL motivo=<motivo>` (exit 1).
 */
function main(): void {
  const url = process.argv[2];
  if (url === undefined) {
    falhar('url_em_falta');
    return;
  }
  if (!/^wss?:\/\/\S+$/.test(url)) {
    falhar('url_invalida');
    return;
  }

  const inicio = Date.now();
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(url);
  } catch (erro) {
    falhar((erro instanceof Error ? erro.message : String(erro)).replace(/\s+/g, '_'));
    return;
  }

  let terminado = false;
  let enviadoEm: number | undefined;

  const terminar = (codigo: number, saida: string): void => {
    if (terminado) return;
    terminado = true;
    clearTimeout(temporizador);
    console.log(saida);
    process.exitCode = codigo;
    socket?.terminate();
  };

  const temporizador = setTimeout(() => {
    terminar(1, 'WS_FAIL motivo=timeout');
  }, TIMEOUT_MS);

  socket.on('open', () => {
    enviadoEm = Date.now();
    socket?.send(`ping-${new Date().toISOString()}`);
  });

  socket.on('message', (dados) => {
    const texto = dados.toString();
    if (!texto.startsWith('echo:')) {
      // rejeita respostas fora do formato `echo:`
      terminar(1, 'WS_FAIL motivo=resposta_invalida');
      return;
    }
    const rtt = Date.now() - (enviadoEm ?? inicio);
    terminar(0, `WS_OK rtt=${rtt}ms`);
  });

  socket.on('error', (erro: Error) => {
    const motivo = erro.message.replace(/\s+/g, '_');
    terminar(1, `WS_FAIL motivo=${motivo}`);
  });

  socket.on('close', () => {
    // ligação fechada antes do echo: tratada aqui, sem erro não tratado
    terminar(1, 'WS_FAIL motivo=ligacao_fechada_sem_echo');
  });
}

main();
