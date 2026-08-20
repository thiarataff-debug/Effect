/**
 * DRIVE-JSON-STORE — armazenamento genérico de um "documento" JSON (objeto ou
 * lista) no Google Drive, com cache em memória e escrita em segundo plano.
 *
 * Por quê: várias partes do bot (Inbox, Contratos, Vagas/Empresas,
 * Vagas/Divulgações, Vagas/Cronograma, Vagas/Templates) guardavam seus dados
 * em arquivos soltos dentro de /data — um "Volume" persistente do Railway.
 * Hospedagens gratuitas (ex.: Render free tier) não oferecem disco
 * persistente: o filesystem é apagado a cada deploy e a cada period de
 * inatividade. Este módulo troca esse disco local pelo Google Drive (mesma
 * Service Account já usada pra currículos e pelo Financeiro), que é externo
 * ao servidor e não é afetado por reinícios/deploys/hibernação — então o bot
 * pode rodar em qualquer hospedagem, inclusive gratuita, sem perder dados.
 *
 * Migração automática: se ainda não existir nada salvo no Drive mas existir
 * um arquivo antigo no caminho local (Volume do Railway, ex: /data/contratos.json),
 * esse conteúdo é lido UMA VEZ e copiado pro Drive — nenhum dado existente é
 * perdido na troca.
 *
 * Desenho pensado pra não exigir nenhuma mudança nas rotas Express que já
 * existem: cada store cacheado expõe `ler()` (síncrono, sempre retorna o que
 * já está em memória) e `gravar(valor)` (síncrono, atualiza a memória na hora
 * e agenda a gravação no Drive em segundo plano) — ou seja, as funções
 * lerX()/gravarX() de cada módulo continuam com a MESMA assinatura de antes,
 * só que por baixo dos panos gravam no Drive em vez do disco local.
 */

const fs = require("fs");
const { Readable } = require("stream");
const { google } = require("googleapis");

const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "18ZHM0HgSsYmgDK84aynw96KNlRYlT6YD";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

let driveClient = null;
function getDriveClient() {
  if (driveClient) return driveClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.error("[drive-json-store] GOOGLE_SERVICE_ACCOUNT_JSON ausente — nada será salvo até isso ser configurado.");
    return null;
  }
  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive"] });
    driveClient = google.drive({ version: "v3", auth });
    return driveClient;
  } catch (e) {
    console.error("[drive-json-store] erro ao iniciar Google Drive client:", e.message);
    return null;
  }
}

const pastaCache = {}; // { "Inbox": "folderId", "Vagas": "folderId", ... }
const pastaEmAndamento = {}; // evita duas pastas "Vagas" duplicadas quando vários
// stores que dividem a mesma pastaNome (ex.: os 4 stores de Vagas) são criados
// ao mesmo tempo na inicialização — sem isso, cada um faria sua própria busca
// (que ainda não acha nada) e cada um criaria sua própria pasta em paralelo.
async function obterOuCriarPasta(drive, nome, parentId) {
  const chave = parentId + "/" + nome;
  if (pastaCache[chave]) return pastaCache[chave];
  if (pastaEmAndamento[chave]) return pastaEmAndamento[chave];

  const promessa = (async () => {
    const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${nome.replace(/'/g, "\\'")}' and trashed=false`;
    const busca = await drive.files.list({ q, fields: "files(id, name)", supportsAllDrives: true, includeItemsFromAllDrives: true });
    let id;
    if (busca.data.files && busca.data.files.length > 0) {
      id = busca.data.files[0].id;
    } else {
      const criada = await drive.files.create({
        requestBody: { name: nome, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
        fields: "id",
        supportsAllDrives: true
      });
      id = criada.data.id;
    }
    pastaCache[chave] = id;
    return id;
  })();

  pastaEmAndamento[chave] = promessa;
  try {
    return await promessa;
  } finally {
    delete pastaEmAndamento[chave];
  }
}

async function localizarArquivo(drive, pastaId, nomeArquivo) {
  const q = `'${pastaId}' in parents and name='${nomeArquivo.replace(/'/g, "\\'")}' and trashed=false`;
  const busca = await drive.files.list({ q, fields: "files(id, name)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  return busca.data.files && busca.data.files.length > 0 ? busca.data.files[0].id : null;
}

function lerArquivoLocalSeExistir(caminhoLocal, valorPadrao) {
  try {
    if (caminhoLocal && fs.existsSync(caminhoLocal)) {
      return JSON.parse(fs.readFileSync(caminhoLocal, "utf8"));
    }
  } catch (e) {
    console.error(`[drive-json-store] erro lendo arquivo local antigo (${caminhoLocal}) pra migrar:`, e.message);
  }
  return valorPadrao;
}

/**
 * Cria um store cacheado, com "Anexo/pastaNome/nomeArquivo" no Drive.
 * @param {string} nomeArquivo - ex.: "contratos.json"
 * @param {string} pastaNome - ex.: "Contratos" (subpasta dentro da raiz do Drive)
 * @param {*} valorPadrao - valor inicial (ex.: [] ou {}) antes do primeiro load
 * @param {string} [migrarDeArquivoLocal] - caminho local antigo (Volume Railway) pra migrar uma única vez, se existir e o Drive ainda estiver vazio
 */
function criarStoreCacheado({ nomeArquivo, pastaNome, valorPadrao, migrarDeArquivoLocal }) {
  let cache = valorPadrao;
  let fileId = null;
  let pastaId = null;

  async function persistir(valor) {
    const drive = getDriveClient();
    if (!drive) throw new Error("Google Drive não configurado (GOOGLE_SERVICE_ACCOUNT_JSON ausente)");
    if (!pastaId) pastaId = await obterOuCriarPasta(drive, pastaNome, DRIVE_ROOT_FOLDER_ID);
    if (!fileId) fileId = await localizarArquivo(drive, pastaId, nomeArquivo);
    if (fileId) {
      await drive.files.update({
        fileId,
        media: { mimeType: "application/json", body: Readable.from(Buffer.from(JSON.stringify(valor))) },
        supportsAllDrives: true
      });
    } else {
      const file = await drive.files.create({
        requestBody: { name: nomeArquivo, parents: [pastaId], mimeType: "application/json" },
        media: { mimeType: "application/json", body: Readable.from(Buffer.from(JSON.stringify(valor))) },
        fields: "id",
        supportsAllDrives: true
      });
      fileId = file.data.id;
    }
  }

  async function carregar() {
    const drive = getDriveClient();
    if (!drive) {
      console.error(`[drive-json-store:${nomeArquivo}] sem acesso ao Drive — usando valor padrão só nesta execução (nada será salvo até o Drive ficar configurado).`);
      return;
    }
    try {
      pastaId = await obterOuCriarPasta(drive, pastaNome, DRIVE_ROOT_FOLDER_ID);
      fileId = await localizarArquivo(drive, pastaId, nomeArquivo);
      if (fileId) {
        const resp = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
        cache = JSON.parse(resp.data);
        console.log(`[drive-json-store:${nomeArquivo}] carregado do Google Drive.`);
      } else {
        // Nada salvo no Drive ainda: migra do arquivo local antigo (Volume), se existir.
        const migrado = lerArquivoLocalSeExistir(migrarDeArquivoLocal, valorPadrao);
        cache = migrado;
        await persistir(cache);
        const veioDoLocal = migrarDeArquivoLocal && migrado !== valorPadrao;
        console.log(`[drive-json-store:${nomeArquivo}] criado no Drive${veioDoLocal ? " (migrado do arquivo local existente)" : " (valor padrão)"}.`);
      }
    } catch (e) {
      console.error(`[drive-json-store:${nomeArquivo}] erro carregando do Drive, mantendo valor padrão nesta execução:`, e.message);
    }
  }

  const prontoPromise = carregar();

  return {
    ler() { return cache; },
    gravar(valor) {
      cache = valor;
      persistir(valor).catch(e => console.error(`[drive-json-store:${nomeArquivo}] erro ao salvar no Drive:`, e.message));
      return true;
    },
    prontoPromise
  };
}

module.exports = { criarStoreCacheado };
