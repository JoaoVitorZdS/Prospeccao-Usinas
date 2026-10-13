// baixar.mjs — download de um arquivo grande direto para o disco, em streaming (o ZIP da ANEEL tem ~110 MB).

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const mb = (bytes) => (bytes / 1048576).toFixed(1);

/**
 * Baixa `url` para `destino`. Reaproveita o arquivo se ele tem menos de `maxIdadeHoras` (várias execuções no mesmo
 * dia não baixam de novo) ou se `reaproveitar`. Escreve num `.parcial` e só renomeia no fim: uma queda de conexão
 * nunca deixa um arquivo pela metade passando por completo.
 * @returns {{ reutilizado: boolean, bytes: number }}
 */
export async function baixarArquivo(url, destino, { log = () => {}, maxIdadeHoras = 12, reaproveitar = false, buscar = fetch } = {}) {
  if (existsSync(destino)) {
    const st = statSync(destino);
    const horas = (Date.now() - st.mtimeMs) / 3600e3;
    if (reaproveitar || horas < maxIdadeHoras) {
      log(`  reaproveitando ${destino} (${mb(st.size)} MB, baixado há ${horas < 1 ? 'menos de 1' : Math.round(horas)} h)`);
      return { reutilizado: true, bytes: st.size };
    }
  }
  mkdirSync(dirname(destino), { recursive: true });
  const parcial = `${destino}.parcial`;
  rmSync(parcial, { force: true });

  const resposta = await buscar(url, { redirect: 'follow' });
  if (!resposta.ok || !resposta.body) throw new Error(`O servidor respondeu ${resposta.status} ao baixar ${url}`);
  const esperado = Number(resposta.headers.get('content-length')) || 0;

  let lidos = 0;
  let ultimoLog = 0;
  const contador = new Transform({
    transform(pedaco, _enc, pronto) {
      lidos += pedaco.length;
      if (lidos - ultimoLog >= 10 * 1048576) {
        ultimoLog = lidos;
        log(`  ${mb(lidos)}${esperado ? ` / ${mb(esperado)}` : ''} MB`);
      }
      pronto(null, pedaco);
    },
  });
  try {
    await pipeline(Readable.fromWeb(resposta.body), contador, createWriteStream(parcial));
  } catch (e) {
    rmSync(parcial, { force: true });
    throw e;
  }
  if (esperado && lidos !== esperado) {
    rmSync(parcial, { force: true });
    throw new Error(`Download incompleto: vieram ${lidos} bytes de ${esperado}. Rode de novo.`);
  }
  renameSync(parcial, destino);
  log(`  baixado: ${mb(lidos)} MB`);
  return { reutilizado: false, bytes: lidos };
}
