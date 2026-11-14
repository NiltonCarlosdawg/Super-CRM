// Startup file do cPanel/LiteSpeed (o lsnode arranca `node <ficheiro>`, não
// `npm start`): reproduz `tsx --env-file-if-exists=.env src/infra/main.ts` —
// carrega o .env se existir, regista o loader do tsx e importa o entrypoint.
//
// O lsnode.js do LiteSpeed (/usr/local/lsws/fcgi-bin/lsnode.js) faz patch de
// http.Server.prototype.listen ANTES de requerer este ficheiro: o primeiro
// listen() da app é desviado para o fd0 (socket unix extapp) e nunca prender
// TCP — por isso 127.0.0.1:3002 recusava ligação e o proxy do frontend não
// tinha alvo (medido 2026-11-11). Desfazemos o desvio: a app volta a escutar
// em PORT (3002) e o fd0 herdado é reencaminhado por baixo para esse port,
// para o domínio da API continuar a servir pelo socket extapp como dantes.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { register } from 'tsx/esm/api';

if (http.Server.prototype.realListen) {
  // Só existe no processo lançado pelo lsnode; em dev/CI o bloco não corre.
  http.Server.prototype.listen = http.Server.prototype.realListen;
  http.Server.prototype.address = net.Server.prototype.address;

  // shortcut: se o LiteSpeed recriar o socket extapp por caminho, este
  // processo fica com o fd antigo — um restart da app repõe (o shim original
  // vigiava o inode e matava a app; aqui não vale a pena replicar isso).
  try {
    if (process.env.LSNODE_SOCKET && fs.fstatSync(0).isSocket()) {
      net.createServer((client) => {
        const upstream = net.connect({ port: Number(process.env.PORT || 3002), host: '127.0.0.1' });
        client.pipe(upstream);
        upstream.pipe(client);
        const drop = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on('error', drop);
        upstream.on('error', drop);
      }).listen({ fd: 0 });
    }
  } catch (err) {
    process.stderr.write(`fd0 relay: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch (err) {
  if (err?.code !== 'ENOENT') throw err; // sem .env: arranca com o ambiente do processo
}

register();
await import('./src/infra/main.ts');
