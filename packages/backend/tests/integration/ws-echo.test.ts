import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('../../', import.meta.url));
const entradaServidor = path.join(raiz, 'scripts', 'ws-echo-server.ts');
const entradaCliente = path.join(raiz, 'scripts', 'ws-echo-client.ts');

const PORTA_SERVIDOR = 18787;
const PORTA_FECHADA = 18799;
const TIMEOUT_LISTENING_MS = 5000;
const POLL_MS = 50;

type ResultadoFilho = { exitCode: number | null; stdout: string };

function arrancar(argumentos: string[], env: NodeJS.ProcessEnv = process.env): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', ...argumentos], { cwd: raiz, env });
}

async function esperarListening(filho: ChildProcessWithoutNullStreams): Promise<string> {
  let stdout = '';
  filho.stdout.setEncoding('utf8');
  filho.stderr.setEncoding('utf8');
  filho.stdout.on('data', (pedaco: string) => {
    stdout += pedaco;
  });
  filho.stderr.on('data', () => {
    // consumido para o pipe não bloquear
  });

  const limite = Date.now() + TIMEOUT_LISTENING_MS;
  while (Date.now() < limite && !stdout.includes('ws_echo.listening')) {
    await esperar(POLL_MS);
  }
  return stdout;
}

function correrCliente(url: string): Promise<ResultadoFilho> {
  return new Promise((resolve, reject) => {
    const filho = arrancar([entradaCliente, url]);
    let stdout = '';
    filho.stdout.setEncoding('utf8');
    filho.stderr.setEncoding('utf8');
    filho.stdout.on('data', (pedaco: string) => {
      stdout += pedaco;
    });
    filho.stderr.on('data', () => {
      // consumido para o pipe não bloquear
    });
    filho.on('error', reject);
    filho.on('close', (code) => resolve({ exitCode: code, stdout }));
  });
}

async function pararFilho(filho: ChildProcessWithoutNullStreams): Promise<void> {
  if (filho.exitCode !== null || filho.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const salvaguarda = setTimeout(() => {
      filho.kill('SIGKILL');
      resolve();
    }, 3000);
    filho.once('close', () => {
      clearTimeout(salvaguarda);
      resolve();
    });
    filho.kill('SIGTERM');
  });
}

test('sonda ws: o cliente recebe echo do servidor local', async () => {
  const servidor = arrancar([entradaServidor], { ...process.env, PORT: String(PORTA_SERVIDOR) });
  try {
    const saidaServidor = await esperarListening(servidor);
    assert.ok(
      saidaServidor.includes('ws_echo.listening'),
      `servidor não anunciou ws_echo.listening em ${TIMEOUT_LISTENING_MS} ms; saída: ${saidaServidor}`,
    );

    const resultado = await correrCliente(`ws://127.0.0.1:${PORTA_SERVIDOR}`);
    assert.equal(resultado.exitCode, 0, `cliente devolveu ${resultado.exitCode}; stdout: ${resultado.stdout}`);
    assert.match(resultado.stdout, /^WS_OK rtt=\d+ms/);
  } finally {
    await pararFilho(servidor);
  }
});

test('sonda ws: porta fechada devolve WS_FAIL', async () => {
  const resultado = await correrCliente(`ws://127.0.0.1:${PORTA_FECHADA}`);
  assert.equal(resultado.exitCode, 1, `cliente devolveu ${resultado.exitCode}; stdout: ${resultado.stdout}`);
  assert.match(resultado.stdout, /^WS_FAIL/);
});
