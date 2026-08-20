/**
 * FINANCEIRO — persistência central da aba Financeiro (substitui as planilhas
 * Excel que a Thiara preenchia manualmente).
 *
 * Guarda um único "store" (objeto JSON) com uma chave por área da tela
 * (entries = lançamentos de receita/custo/poupança, notas = notas fiscais,
 * venc/vencValores = contas fixas, pipe = pipeline de clientes, etc.).
 * O financeiro.html já organizava tudo isso em localStorage sob chaves
 * 'ef_<chave>' — aqui só espelhamos as mesmas chaves no servidor, então
 * nenhuma tela precisou ser redesenhada: os dados agora sobrevivem a troca
 * de navegador/computador e a deploys, em vez de ficarem presos ao
 * localStorage de um único dispositivo.
 *
 * PERSISTÊNCIA: Google Drive (mesma Service Account que já é usada pra
 * currículos), NÃO disco local. Isso é proposital: hospedagens gratuitas
 * (ex.: Render free tier) não oferecem disco persistente — o filesystem é
 * apagado a cada novo deploy e a cada "hibernada" por inatividade. Guardando
 * tudo no Drive (que é externo ao servidor), o bot pode rodar em qualquer
 * hospedagem, inclusive gratuita, sem perder dados financeiros nem os PDFs
 * das notas anexadas.
 *
 * Estrutura criada no Drive (dentro da pasta raiz configurada em
 * DRIVE_ROOT_FOLDER_ID, a mesma pasta onde já ficam os currículos):
 *   Financeiro/
 *     financeiro-data.json   ← o "store" inteiro (entries, notas, etc.)
 *     Anexos/                ← PDFs das notas fiscais anexadas
 *
 * Na primeira vez que o bot roda (arquivo financeiro-data.json ainda não
 * existe no Drive), o store é inicializado a partir de financeiro-seed.json
 * — que já vem com:
 *   - os lançamentos reais de 2026 (Jan–Ago) importados da planilha
 *     "Controle Financeiro 2026 Atualizado.xlsx"
 *   - as notas fiscais cuja comissão cai em Setembro ou Outubro/2026,
 *     relançadas automaticamente a partir da aba JHO dessa planilha.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { Readable } = require("stream");
const { google } = require("googleapis");

const router = express.Router();

const SEED_PATH = path.join(__dirname, "financeiro-seed.json");
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "18ZHM0HgSsYmgDK84aynw96KNlRYlT6YD";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const uploadAnexo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── Cliente Drive (mesmo mecanismo usado pros currículos em index.js) ─────
let driveClient = null;
function getDriveClient() {
  if (driveClient) return driveClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.error("[financeiro] Drive: variável GOOGLE_SERVICE_ACCOUNT_JSON ausente — o Financeiro não vai conseguir salvar nada até isso ser configurado.");
    return null;
  }
  try {
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
    driveClient = google.drive({ version: "v3", auth });
    return driveClient;
  } catch (e) {
    console.error("[financeiro] Erro ao iniciar Google Drive client:", e.message);
    return null;
  }
}

// ── Pastas Financeiro/ e Financeiro/Anexos/ (criadas uma vez, cacheadas) ──
let pastaFinanceiroId = null;
let pastaAnexosId = null;

async function obterOuCriarPasta(drive, nome, parentId) {
  const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${nome.replace(/'/g, "\\'")}' and trashed=false`;
  const busca = await drive.files.list({ q, fields: "files(id, name)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (busca.data.files && busca.data.files.length > 0) return busca.data.files[0].id;
  const criada = await drive.files.create({
    requestBody: { name: nome, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
    supportsAllDrives: true
  });
  return criada.data.id;
}

async function obterPastaFinanceiro(drive) {
  if (pastaFinanceiroId) return pastaFinanceiroId;
  pastaFinanceiroId = await obterOuCriarPasta(drive, "Financeiro", DRIVE_ROOT_FOLDER_ID);
  return pastaFinanceiroId;
}

async function obterPastaAnexos(drive) {
  if (pastaAnexosId) return pastaAnexosId;
  const pastaFin = await obterPastaFinanceiro(drive);
  pastaAnexosId = await obterOuCriarPasta(drive, "Anexos", pastaFin);
  return pastaAnexosId;
}

// ── Arquivo financeiro-data.json dentro da pasta Financeiro/ ──────────────
let storeFileId = null; // cacheado depois da primeira busca/criação

async function localizarArquivoStore(drive, pastaFinanceiroId) {
  const q = `'${pastaFinanceiroId}' in parents and name='financeiro-data.json' and trashed=false`;
  const busca = await drive.files.list({ q, fields: "files(id, name)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  return busca.data.files && busca.data.files.length > 0 ? busca.data.files[0].id : null;
}

function lerSeed() {
  try {
    const raw = fs.readFileSync(SEED_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("[financeiro] erro lendo seed:", e.message);
    return {};
  }
}

async function baixarStoreDoDrive(drive, fileId) {
  const resp = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
  return JSON.parse(resp.data);
}

async function criarArquivoStoreNoDrive(drive, pastaFinanceiroId, store) {
  const file = await drive.files.create({
    requestBody: { name: "financeiro-data.json", parents: [pastaFinanceiroId], mimeType: "application/json" },
    media: { mimeType: "application/json", body: Readable.from(Buffer.from(JSON.stringify(store))) },
    fields: "id",
    supportsAllDrives: true
  });
  return file.data.id;
}

async function atualizarArquivoStoreNoDrive(drive, fileId, store) {
  await drive.files.update({
    fileId,
    media: { mimeType: "application/json", body: Readable.from(Buffer.from(JSON.stringify(store))) },
    supportsAllDrives: true
  });
}

// ── Cache em memória do store (evita ida ao Drive a cada leitura) ─────────
let storeCache = null;
let carregandoPromise = null;

async function carregarStore() {
  if (storeCache) return storeCache;
  if (carregandoPromise) return carregandoPromise;

  carregandoPromise = (async () => {
    const drive = getDriveClient();
    if (!drive) {
      console.error("[financeiro] Sem acesso ao Drive — usando o seed local só nesta execução (nada será salvo até o Drive ficar configurado).");
      storeCache = lerSeed();
      return storeCache;
    }
    try {
      const pastaFin = await obterPastaFinanceiro(drive);
      const fileId = await localizarArquivoStore(drive, pastaFin);
      if (fileId) {
        storeFileId = fileId;
        storeCache = await baixarStoreDoDrive(drive, fileId);
        console.log("[financeiro] store carregado do Google Drive.");
      } else {
        const seed = lerSeed();
        storeFileId = await criarArquivoStoreNoDrive(drive, pastaFin, seed);
        storeCache = seed;
        console.log("[financeiro] financeiro-data.json não existia no Drive — criado a partir do seed (planilha 2026 + notas de Set/Out relançadas).");
      }
    } catch (e) {
      console.error("[financeiro] erro carregando store do Drive, usando seed como fallback temporário:", e.message);
      storeCache = lerSeed();
    }
    return storeCache;
  })();

  return carregandoPromise;
}

async function salvarStore() {
  const drive = getDriveClient();
  if (!drive) throw new Error("Google Drive não configurado (GOOGLE_SERVICE_ACCOUNT_JSON ausente) — nada foi salvo.");
  if (!storeFileId) {
    const pastaFin = await obterPastaFinanceiro(drive);
    storeFileId = await localizarArquivoStore(drive, pastaFin);
    if (!storeFileId) {
      storeFileId = await criarArquivoStoreNoDrive(drive, pastaFin, storeCache || {});
      return;
    }
  }
  await atualizarArquivoStoreNoDrive(drive, storeFileId, storeCache || {});
}

// ── Store genérico: espelha as chaves usadas pelo financeiro.html ─────────
router.get("/financeiro/api/store", async (req, res) => {
  try {
    const store = await carregarStore();
    res.json({ ok: true, store });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// (o body-parser JSON já está montado globalmente em index.js antes desta rota)
router.post("/financeiro/api/store/:key", async (req, res) => {
  try {
    const key = req.params.key;
    const store = await carregarStore();
    store[key] = req.body ? req.body.value : undefined;
    await salvarStore();
    res.json({ ok: true });
  } catch (e) {
    console.error("[financeiro] erro salvando store:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── ANEXOS: guarda o PDF da nota fiscal (DANFE) que a Thiara anexa ────────
// Sobe direto pro Google Drive (pasta Financeiro/Anexos), com permissão de
// leitura pública por link — igual ao que já é feito com os currículos —
// e devolve o link do Drive, que a tabela de notas usa como href do "PDF".
function nomeSeguro(nomeOriginal) {
  return String(nomeOriginal || "nota.pdf")
    .replace(/[^\w\.\-]+/g, "_")
    .slice(-80);
}

router.post("/financeiro/api/anexo", uploadAnexo.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, erro: "Nenhum PDF enviado" });
    const drive = getDriveClient();
    if (!drive) return res.status(500).json({ ok: false, erro: "Google Drive não configurado (GOOGLE_SERVICE_ACCOUNT_JSON ausente)" });

    const pastaAnexos = await obterPastaAnexos(drive);
    const nomeFinal = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "-" + nomeSeguro(req.file.originalname);

    const file = await drive.files.create({
      requestBody: { name: nomeFinal, parents: [pastaAnexos], mimeType: "application/pdf" },
      media: { mimeType: "application/pdf", body: Readable.from(req.file.buffer) },
      fields: "id, webViewLink",
      supportsAllDrives: true
    });

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true
    }).catch(e => console.warn("[financeiro] anexo: permissão pública não aplicada:", e.message));

    const url = file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;
    res.json({ ok: true, url, nome: req.file.originalname });
  } catch (e) {
    console.error("[financeiro] erro salvando anexo no Drive:", e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
