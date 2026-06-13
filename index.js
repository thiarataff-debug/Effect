// VERSÃO FINAL ENXUTA — travas mínimas + template detalhado + limpeza de manuais antigos
// INDEX CONSOLIDADO — 10/06/2026
// CORREÇÃO: horário real das mensagens recebido pelo timestamp do WhatsApp — versão Gemini
// Ajustes principais:
// 1) Travas menos agressivas: Lia não pausa por conversa longa sem avanço, retorno, entrevista, urgência, indicação ou cargo estratégico.
// 2) Mensagem enviada pela Laura: /inbox/enviar grava e devolve o evento salvo no histórico do servidor.
// 3) Mantém manual apenas para pedido explícito de humano/responsável, dados sensíveis, saúde/PCD, jurídico, irritação/risco ou possível cliente.
// 4) CORREÇÃO 10/06/2026 (parte 2): salvamento periódico no Sheets em paralelo e só para sessões com mudança
//    + chamarClaude com retry/log de erro real + Lia não envia mais a mensagem genérica de "instabilidade"
//    repetidamente ao candidato (evita spam); em vez disso alerta Thiara e tenta de novo silenciosamente.

const express = require("express");
const axios = require("axios");
const pdfParse = require("pdf-parse");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;
const CURRICULOS_DIR = process.env.CURRICULOS_DIR || path.join("/tmp", "effect-curriculos");
try { fs.mkdirSync(CURRICULOS_DIR, { recursive: true }); } catch (e) { console.error("Erro criando pasta local de currículos:", e.message); }

const CONFIG = {
  AI_PROVIDER: process.env.AI_PROVIDER || "gemini",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "effect_lia_2026",
  VAGAS_URL: process.env.VAGAS_URL,
  THIARA_WHATSAPP: "5527997925288",
  DRIVE_ROOT_FOLDER_ID: process.env.DRIVE_ROOT_FOLDER_ID || "1-N6OjCjfdpaPCxvkXFjoMtU3UlksifTH",
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON
};

const sessoes = {};
const mensagensProcessadas = new Set();
const curriculosProcessados = new Set();
const atendimentosManuais = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function limparTelefone(telefone) {
  return String(telefone || "").replace(/\D/g, "");
}

function normalizarTexto(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function campo(vaga, nomes, padrao = "") {
  for (const nome of nomes) {
    if (vaga && vaga[nome] !== undefined && vaga[nome] !== null && String(vaga[nome]).trim() !== "") {
      return vaga[nome];
    }
  }
  return padrao;
}

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function agoraMs() {
  return Date.now();
}

function agoraHorarioBR() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Sao_Paulo'
  });
}

function carimboTempo() {
  const ms = Date.now();
  return {
    timestampMs: ms,
    timestampISO: new Date(ms).toISOString(),
    horarioFormatado: agoraHorarioBR()
  };
}

function agoraISO() {
  return new Date().toISOString();
}

function parseDataFlexivel(valor) {
  if (!valor) return null;
  if (valor instanceof Date && !isNaN(valor.getTime())) return valor;
  if (typeof valor === "number") {
    const d = new Date(valor);
    return isNaN(d.getTime()) ? null : d;
  }

  const texto = String(valor).trim();
  if (!texto) return null;

  const direto = new Date(texto);
  if (!isNaN(direto.getTime())) return direto;

  // Aceita formatos do Brasil salvos anteriormente: 10/06/2026, 14:27:05
  const m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let dia = Number(m[1]);
    let mes = Number(m[2]);
    let ano = Number(m[3]);
    if (ano < 100) ano += 2000;
    if (mes > 12) { const tmp = dia; dia = mes; mes = tmp; }
    const hora = Number(m[4] || 0);
    const minuto = Number(m[5] || 0);
    const segundo = Number(m[6] || 0);
    const pad = n => String(n).padStart(2, '0');
    const isoStr = `${ano}-${pad(mes)}-${pad(dia)}T${pad(hora)}:${pad(minuto)}:${pad(segundo)}-03:00`;
    const d = new Date(isoStr);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function formatarDataWhatsApp(valor) {
  const date = parseDataFlexivel(valor);
  if (!date) return "";

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((startToday - startDate) / 86400000);

  if (diffDays === 0) {
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  }
  if (diffDays === 1) return "Ontem";
  if (diffDays >= 2 && diffDays < 7) {
    return ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][date.getDay()];
  }
  return date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function prepararEventoHistorico(role, content, timestampMs = null) {
  const ms = timestampMs || Date.now();
  const iso = new Date(ms).toISOString();
  return {
    role,
    content,
    timestamp: iso,
    timestampISO: iso,
    timestampMs: ms,
    horario: new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    horarioFormatado: formatarDataWhatsApp(ms)
  };
}

function normalizarEventoHistorico(evento) {
  function paraMs(valor) {
    if (!valor) return 0;

    if (typeof valor === "number") {
      return valor < 10000000000 ? valor * 1000 : valor;
    }

    const s = String(valor).trim();
    if (!s) return 0;

    if (/^\d{13,}$/.test(s)) return Number(s);
    if (/^\d{10}$/.test(s)) return Number(s) * 1000;

    // ISO: 2026-06-11T12:02:00.000Z
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    }

    // Formato BR: 11/06/2026, 09:02:33
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (br) {
      const dia = Number(br[1]);
      const mes = Number(br[2]);
      const ano = Number(br[3]);
      const hora = Number(br[4] || 0);
      const minuto = Number(br[5] || 0);
      const segundo = Number(br[6] || 0);

      const diaFinal = dia > 12 ? dia : (mes > 12 ? mes : dia);
      const mesFinal = dia > 12 ? mes : (mes > 12 ? dia : mes);
      // -03:00 explícito: Railway roda em UTC, sem isso fica 3h errado
      const pad2 = n => String(n).padStart(2, '0');
      const iso2 = `${ano}-${pad2(mesFinal)}-${pad2(diaFinal)}T${pad2(hora)}:${pad2(minuto)}:${pad2(segundo)}-03:00`;
      const d = new Date(iso2);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    }

    // Não usar new Date() livre para texto curto tipo "09:02".
    // Isso foi uma das causas de o Inbox assumir o horário atual.
    return 0;
  }

  const candidatos = [
    evento?.timestampMs,
    evento?.timestampISO,
    evento?.timestamp,
    evento?.createdAt,
    evento?.dataHora,
    evento?.horario
  ];

  let ms = 0;

  for (const c of candidatos) {
    const tentativa = paraMs(c);
    if (tentativa && tentativa > 0) {
      ms = tentativa;
      break;
    }
  }

  const iso = ms ? new Date(ms).toISOString() : "";

  return {
    ...(evento || {}),
    timestamp: iso || (evento?.timestamp || ""),
    timestampISO: iso || (evento?.timestampISO || ""),
    timestampMs: ms,
    horario: ms ? new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : (evento?.horario || ""),
    horarioFormatado: ms ? formatarDataWhatsApp(ms) : (evento?.horarioFormatado || "")
  };
}

function obterUltimaMensagem(sessao) {
  const historico = Array.isArray(sessao?.historico) ? sessao.historico.map(normalizarEventoHistorico) : [];
  if (!historico.length) return null;
  return historico.sort((a, b) => Number(a.timestampMs || 0) - Number(b.timestampMs || 0))[historico.length - 1];
}

function calcularUnreadSessao(sessao) {
  if (Number.isFinite(Number(sessao?.unreadCount))) return Number(sessao.unreadCount || 0);
  const historico = Array.isArray(sessao?.historico) ? sessao.historico : [];
  let count = 0;
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i]?.role === "user") count++;
    else if (historico[i]?.role === "assistant") break;
  }
  return count;
}

function normalizarSessaoParaInbox(telefone, sessao) {
  const historicoNormalizado = Array.isArray(sessao?.historico) ? sessao.historico.map(normalizarEventoHistorico) : [];
  historicoNormalizado.sort((a, b) => Number(a.timestampMs || 0) - Number(b.timestampMs || 0));

  const ultima = historicoNormalizado[historicoNormalizado.length - 1] || null;
  const lastMessageAtMs = ultima?.timestampMs || 0;
  const unreadCount = calcularUnreadSessao(sessao);

  return {
    historico: historicoNormalizado,
    nome: sessao?.nome || null,
    modo: sessao?.modo || "automatico",
    pausado: sessao?.pausado === true || atendimentosManuais.has(telefone),
    motivoPausa: sessao?.motivoPausa || "",
    aguardandoConfirmacaoInteresse: sessao?.aguardandoConfirmacaoInteresse || false,
    ultimaAnalise: sessao?.ultimaAnalise || null,
    curriculo: sessao?.curriculo ? { filename: sessao.curriculo.filename, mimeType: sessao.curriculo.mimeType || null, sizeBytes: sessao.curriculo.sizeBytes || null, recebidoEm: sessao.curriculo.recebidoEm, recebidoEmMs: sessao.curriculo.recebidoEmMs || 0, recebidoEmFormatado: formatarDataWhatsApp(sessao.curriculo.recebidoEmMs || sessao.curriculo.recebidoEm), driveLink: sessao.curriculo.driveLink || null, pasta: sessao.curriculo.pasta || null, analiseStatus: sessao.curriculo.analiseStatus || 'recebido', arquivoDisponivel: curriculoTemArquivo(sessao.curriculo), local: !!sessao.curriculo.localPath } : null,
    curriculos: normalizarCurriculosParaInbox(sessao),
    lastMessage: ultima?.content || "",
    lastMessageRole: ultima?.role || "",
    lastMessageAt: lastMessageAtMs ? new Date(lastMessageAtMs).toISOString() : "",
    lastMessageAtMs,
    dataWhatsapp: formatarDataWhatsApp(lastMessageAtMs),
    formattedLastMessageAt: formatarDataWhatsApp(lastMessageAtMs),
    unreadCount
  };
}

function registrarEntradaSessao(sessao, role, content, timestampMs = null) {
  const evento = prepararEventoHistorico(role, content, timestampMs);

  sessao.historico.push(evento);
  sessao.historico = sessao.historico.slice(-500);

  sessao.lastMessageAtMs = evento.timestampMs || Date.now();
  sessao.lastMessageAt = evento.timestampISO || new Date(sessao.lastMessageAtMs).toISOString();
  sessao.formattedLastMessageAt = evento.horarioFormatado || "";
  sessao.lastMessage = content || "";
  sessao.lastMessageRole = role;

  return evento;
}

function marcarMensagemRecebida(sessao, timestampMs = null) {
  sessao.unreadCount = Number(sessao.unreadCount || 0) + 1;
  sessao.lastMessageAtMs = timestampMs || Date.now();
}

function marcarConversaRespondida(sessao) {
  sessao.unreadCount = 0;
  // Preserva lastMessageAtMs real
}

const AREA_SYNONYMS = {
  rh: [
    "rh", "recursos humanos", "gente e gestao", "gente e gestão",
    "departamento pessoal", "dp", "recrutamento", "selecao", "seleção",
    "r&s", "rs", "treinamento", "endomarketing", "clima", "cultura",
    "administracao de pessoal", "administração de pessoal",
    "analista administrativo rh", "administrativo rh", "carreira", "remuneracao", "remuneração"
  ]
};

function contemSinonimoRH(texto = "") {
  const clean = normalizarTexto(texto);
  return AREA_SYNONYMS.rh.some(term => clean.includes(normalizarTexto(term)));
}

function isRHVaga(vaga) {
  return contemSinonimoRH([
    campo(vaga, ["cargo", "Cargo", "CARGO"]),
    campo(vaga, ["area", "Área/Setor", "Area/Setor", "Área", "Area"]),
    campo(vaga, ["perfilResumido", "Perfil Resumido", "Perfil"]),
    campo(vaga, ["palavrasChave", "Palavras-chave", "Palavras Chave"]),
    campo(vaga, ["requisitosDaVaga", "Requisitos da Vaga", "Requisitos"]),
    campo(vaga, ["observacoes", "Observações", "Observacoes"])
  ].join(" "));
}

function candidatoTemPerfilRH(texto = "") {
  return contemSinonimoRH(texto);
}

function buscarVagaRH(vagas = []) {
  return vagas.find(v => vagaEstaAtiva(v) && isRHVaga(v));
}

// ============================================================
// GOOGLE DRIVE — currículos organizados por pasta de cargo
// ============================================================

let driveClient = null;
const pastaPorCargoCache = {}; // { "auxiliar de servicos gerais": "folderId" }

function getDriveClient() {
  if (driveClient) return driveClient;
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.error("Drive: variável GOOGLE_SERVICE_ACCOUNT_JSON ausente.");
    return null;
  }
  try {
    const credentials = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"]
    });
    driveClient = google.drive({ version: "v3", auth });
    return driveClient;
  } catch (e) {
    console.error("Erro ao iniciar Google Drive client:", e.message);
    return null;
  }
}


function nomeArquivoSeguro(nome) {
  return String(nome || "curriculo")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "curriculo";
}

function salvarCurriculoLocal(buffer, filename, telefone, recebidoEmMs) {
  try {
    if (!buffer) return null;
    const tel = limparTelefone(telefone);
    const seguro = nomeArquivoSeguro(filename || `curriculo_${tel}`);
    const finalName = `${tel}_${recebidoEmMs || Date.now()}_${seguro}`;
    const fullPath = path.join(CURRICULOS_DIR, finalName);
    fs.writeFileSync(fullPath, buffer);
    return { localPath: fullPath, localFilename: finalName };
  } catch (e) {
    console.error("Erro salvarCurriculoLocal:", e.message);
    return null;
  }
}

function curriculoTemArquivo(cv) {
  if (!cv) return false;
  if (cv.base64) return true;
  if (cv.driveLink) return true;
  if (cv.localPath && fs.existsSync(cv.localPath)) return true;
  return false;
}

function nomePastaCargo(cargo) {
  const limpo = String(cargo || "Sem Cargo Identificado").trim();
  return limpo
    .replace(/[\\/:*?"<>|]/g, "-") // remove caracteres inválidos para nome de pasta
    .slice(0, 100) || "Sem Cargo Identificado";
}

async function obterOuCriarPastaCargo(drive, cargo) {
  const nomePasta = nomePastaCargo(cargo);
  const chave = nomePasta.toLowerCase();
  if (pastaPorCargoCache[chave]) return pastaPorCargoCache[chave];

  // Procura subpasta existente com esse nome dentro da pasta raiz
  const q = `'${CONFIG.DRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${nomePasta.replace(/'/g, "\\'")}' and trashed=false`;
  const busca = await drive.files.list({ q, fields: "files(id, name)", supportsAllDrives: true, includeItemsFromAllDrives: true });

  let folderId;
  if (busca.data.files && busca.data.files.length > 0) {
    folderId = busca.data.files[0].id;
  } else {
    const criada = await drive.files.create({
      requestBody: {
        name: nomePasta,
        mimeType: "application/vnd.google-apps.folder",
        parents: [CONFIG.DRIVE_ROOT_FOLDER_ID]
      },
      fields: "id",
      supportsAllDrives: true
    });
    folderId = criada.data.id;
  }
  pastaPorCargoCache[chave] = folderId;
  return folderId;
}

async function uploadCurriculoDrive(buffer, filename, cargo, telefone, mimeType = 'application/octet-stream') {
  try {
    const drive = getDriveClient();
    if (!drive) { console.log("Drive não configurado — pulando upload"); return null; }

    const folderId = await obterOuCriarPastaCargo(drive, cargo);

    // Nome final: telefone + nome do arquivo, evita sobrescrever
    const nomeFinal = `${telefone}_${filename}`.replace(/[\\/:*?"<>|]/g, "-");

    const { Readable } = require("stream");
    const stream = Readable.from(buffer);

    const resp = await drive.files.create({
      requestBody: {
        name: nomeFinal,
        parents: [folderId]
      },
      media: {
        mimeType: mimeType || 'application/octet-stream',
        body: stream
      },
      fields: "id, webViewLink, webContentLink",
      supportsAllDrives: true
    });

    // Torna o arquivo acessível por link (qualquer pessoa com o link pode visualizar)
    try {
      await drive.permissions.create({
        fileId: resp.data.id,
        requestBody: { role: "reader", type: "anyone" },
        supportsAllDrives: true
      });
    } catch (e) { console.error("Erro ao definir permissão pública do CV:", e.message); }

    return { fileId: resp.data.id, link: resp.data.webViewLink, pasta: nomePastaCargo(cargo) };
  } catch (e) {
    console.error("uploadCurriculoDrive falhou (1ª tentativa):", JSON.stringify(e.response?.data || e.message));
    await new Promise(r => setTimeout(r, 3000));
    try {
      const drive2 = getDriveClient();
      if (!drive2) { console.error(`⚠️ CURRÍCULO NÃO SALVO NO DRIVE: ${telefone} | ${filename}`); return null; }
      const folderId2 = await obterOuCriarPastaCargo(drive2, cargo);
      const nomeFinal2 = `${telefone}_${filename}`.replace(/[\/\\:*?"<>|]/g, "-");
      const { Readable: Readable2 } = require("stream");
      const resp2 = await drive2.files.create({
        requestBody: { name: nomeFinal2, parents: [folderId2] },
        media: { mimeType: mimeType || "application/octet-stream", body: Readable2.from(buffer) },
        fields: "id, webViewLink", supportsAllDrives: true
      });
      try { await drive2.permissions.create({ fileId: resp2.data.id, requestBody: { role: "reader", type: "anyone" }, supportsAllDrives: true }); } catch(pe){}
      console.log(`✅ Currículo salvo no Drive (retry): ${telefone} | ${filename}`);
      return { fileId: resp2.data.id, link: resp2.data.webViewLink, pasta: nomePastaCargo(cargo) };
    } catch (e2) {
      console.error(`⚠️ CURRÍCULO NÃO SALVO NO DRIVE: ${telefone} | ${filename} | ${e2.message}`);
      return null;
    }
  }
}


function normalizarCurriculosParaInbox(sessao) {
  const lista = Array.isArray(sessao?.curriculos) ? sessao.curriculos : [];
  return lista.map((cv, idx) => ({
    idx,
    filename: cv.filename || `curriculo_${idx + 1}.pdf`,
    mimeType: cv.mimeType || "application/octet-stream",
    sizeBytes: cv.sizeBytes || null,
    mediaId: cv.mediaId || null,
    recebidoEm: cv.recebidoEm || "",
    recebidoEmMs: cv.recebidoEmMs || 0,
    recebidoEmFormatado: formatarDataWhatsApp(cv.recebidoEmMs || cv.recebidoEm),
    driveLink: cv.driveLink || null,
    pasta: cv.pasta || null,
    analiseStatus: cv.analiseStatus || "recebido",
    arquivoDisponivel: curriculoTemArquivo(cv),
    local: !!cv.localPath
  })).sort((a, b) => Number(b.recebidoEmMs || 0) - Number(a.recebidoEmMs || 0));
}

function registrarCurriculoNaSessao(sessao, dados) {
  if (!sessao.curriculos) sessao.curriculos = [];
  const mediaId = dados.mediaId || null;
  if (mediaId) {
    const existente = sessao.curriculos.find(cv => cv.mediaId === mediaId);
    if (existente) {
      Object.assign(existente, dados);
      sessao.curriculo = existente;
      return existente;
    }
  }

  const recebidoEmMs = dados.recebidoEmMs || Date.now();
  const filename = dados.filename || `curriculo_${recebidoEmMs}.pdf`;

  // Evita duplicidade visual quando o mesmo arquivo chega repetido em poucos segundos.
  const duplicado = sessao.curriculos.find(cv =>
    String(cv.filename || "") === String(filename || "") &&
    Math.abs(Number(cv.recebidoEmMs || 0) - Number(recebidoEmMs || 0)) < 120000
  );
  if (duplicado) {
    Object.assign(duplicado, dados, { filename, recebidoEmMs });
    sessao.curriculo = duplicado;
    return duplicado;
  }

  const cv = {
    filename,
    mimeType: dados.mimeType || "application/octet-stream",
    sizeBytes: dados.sizeBytes || null,
    mediaId,
    base64: dados.base64 || "",
    localPath: dados.localPath || "",
    localFilename: dados.localFilename || "",
    recebidoEmMs,
    recebidoEm: dados.recebidoEm || new Date(recebidoEmMs).toISOString(),
    driveLink: dados.driveLink || null,
    pasta: dados.pasta || null,
    analiseStatus: dados.analiseStatus || "recebido"
  };
  sessao.curriculos.push(cv);
  sessao.curriculos = sessao.curriculos
    .sort((a, b) => Number(b.recebidoEmMs || 0) - Number(a.recebidoEmMs || 0))
    .slice(0, 20);
  sessao.curriculo = cv;
  return cv;
}

// Quando true, toda NOVA conversa (primeiro contato) já nasce em modo manual,
// pausada — a Lia não responde até alguém liberar manualmente no Inbox.
let novaConversaIniciaManual = false;

function garantirSessao(telefoneOriginal) {
  const telefone = limparTelefone(telefoneOriginal);
  if (!sessoes[telefone]) {
    if (novaConversaIniciaManual) {
      sessoes[telefone] = { historico: [], nome: null, modo: "manual", pausado: true, motivoPausa: "Iniciado em modo manual (configuração ativa no Inbox)" };
      atendimentosManuais.add(telefone);
    } else {
      sessoes[telefone] = { historico: [], nome: null, modo: "automatico", pausado: false, motivoPausa: "" };
    }
  }
  if (atendimentosManuais.has(telefone)) {
    sessoes[telefone].modo = "manual";
    sessoes[telefone].pausado = true;
  }
  return sessoes[telefone];
}

function estaEmManual(telefoneOriginal) {
  const telefone = limparTelefone(telefoneOriginal);
  const sessao = garantirSessao(telefone);
  return atendimentosManuais.has(telefone) || sessao.pausado === true || sessao.modo === "manual";
}

// ============================================================
// TRAVAS / MODO SUPERVISOR
// ============================================================

const TRAVAS = {
  // PAUSA REAL: somente pedido explícito de humano/responsável.
  humano: [
    "quero falar com alguém","quero falar com alguem","quero falar com uma pessoa",
    "quero falar com o responsável","quero falar com o responsavel",
    "quero falar com responsável","quero falar com responsavel",
    "quero falar com atendente","quero falar com humano","quero falar com recrutador",
    "falar com alguém","falar com alguem","falar com uma pessoa",
    "falar com o responsável","falar com o responsavel",
    "falar com responsável","falar com responsavel",
    "falar com atendente","falar com humano","falar com recrutador",
    "não quero falar com robo","nao quero falar com robo",
    "pessoa de verdade","alguém da effect","alguem da effect"
  ],

  // ALERTA, mas NÃO pausa automaticamente.
  entrevista: ["tenho entrevista","marcaram minha entrevista","vim para entrevista","qual horario da entrevista","qual horário da entrevista","onde e a entrevista","onde é a entrevista","confirmar entrevista","marcar entrevista","agendar entrevista"],
  retorno: ["fui aprovado","fui aprovada","fui reprovado","fui reprovada","nao tive retorno","não tive retorno","cadê meu retorno","cade meu retorno","estou aguardando retorno","ninguém me respondeu","ninguem me respondeu","já faz dias","ja faz dias"],
  exFuncionario: ["ja trabalhei ai","já trabalhei aí","ja trabalhei nessa empresa","já trabalhei nessa empresa","fui funcionario","fui funcionário","fui colaborador","trabalhei anteriormente","ex funcionario","ex funcionário"],
  urgencia: ["urgente","urgencia","urgência","preciso trabalhar","estou desempregado","estou desempregada","preciso muito","estou passando necessidade"],
  indicacao: ["fulano me indicou","fui indicado","fui indicada","recebi indicação","recebi indicacao","indicação","indicacao"],
  cargoEstrategico: ["supervisor","supervisora","coordenador","coordenadora","gerente","analista senior","analista sênior","especialista","engenheiro","engenheira","liderança","lideranca","gestão de equipe","gestao de equipe"],

  // PAUSA REAL: temas sensíveis/risco.
  pcdSaude: ["sou pcd","tenho laudo","deficiencia","deficiência","cota pcd","laudo medico","laudo médico","afastamento","atestado","cirurgia","gravidez","gestante","limitação","limitacao","tratamento"],
  irritacao: ["não entendeu","nao entendeu","isso está errado","isso esta errado","péssimo atendimento","pessimo atendimento","ridículo","ridiculo","reclamação","reclamacao","processo","advogado","procon","isso não ajuda","isso nao ajuda"],
  dadosSensiveis: ["cpf","rg","cnh","pis","ctps","conta bancária","conta bancaria","pix","cartão","cartao","dados bancários","dados bancarios","nome da mãe","nome da mae","nome do pai","data de nascimento"],
  juridico: ["fgts","férias","ferias","13º","13°","décimo terceiro","decimo terceiro","rescisão","rescisao","processo trabalhista","direitos trabalhistas","justa causa","advogado trabalhista"],
  empresa: ["preciso contratar","quero contratar","quero divulgar vaga","procuro recrutamento","minha empresa","sou empresa","contratar funcionário","contratar funcionario","tenho uma vaga","serviço de recrutamento","servico de recrutamento"],

  // Não pausar por baixa confiança. Usar só para alerta.
  baixaConfianca: ["não encontrei","nao encontrei","não consegui localizar","nao consegui localizar","não tenho certeza","nao tenho certeza","talvez","provavelmente","tive uma instabilidade","pode me mandar novamente","não consegui entender","nao consegui entender"],
  salario: ["salário","salario","quanto ganha","remuneração","remuneracao","benefícios","beneficios","vale transporte","vale alimentação","vale alimentacao","ticket","vr","va"],
  vagaNaoEncontrada: ["vaga do instagram","vaga que vi","vi uma vaga","anúncio","anuncio","vaga administrativa","postagem","publicação","publicacao"]
};

function contemAlguma(texto, lista) {
  const t = normalizarTexto(texto);
  return lista.some(p => t.includes(normalizarTexto(p)));
}

function detectarMenorIdade(texto) {
  const t = normalizarTexto(texto);
  return /\b(14|15|16|17)\s*anos\b/.test(t);
}

function ultimasPerguntasRepetidas(sessao) {
  const falasLia = (sessao.historico || []).filter(h => h.role === "assistant").map(h => normalizarTexto(h.content || "")).filter(Boolean).slice(-3);
  if (falasLia.length < 2) return false;
  const ultima = falasLia[falasLia.length - 1];
  const anterior = falasLia[falasLia.length - 2];
  if (!ultima || !anterior) return false;
  return ultima === anterior || ultima.includes(anterior) || anterior.includes(ultima);
}

function conversaSemAvanco(sessao) {
  const historico = sessao.historico || [];
  if (historico.length < 12) return false;
  const texto = normalizarTexto(historico.map(h => h.content || "").join(" "));
  const temNome = !!sessao.nome || texto.includes("meu nome") || texto.includes("sou ");
  const temCidade = texto.includes("vitoria") || texto.includes("vitória") || texto.includes("vila velha") || texto.includes("serra") || texto.includes("cariacica") || texto.includes("linhares") || texto.includes("guarapari");
  const temVaga = texto.includes("vaga") || texto.includes("cargo") || texto.includes("oportunidade") || texto.includes("trabalho");
  return !(temNome && temCidade && temVaga);
}

async function enviarAlertaSimplesThiara(telefoneOriginal, titulo, mensagem) {
  const telefone = limparTelefone(telefoneOriginal);
  const alerta = `${titulo}\n\n📱 Candidato:\n+${telefone}\n\n💬 Mensagem:\n${mensagem || "Não informada"}`;
  await enviarMensagem(CONFIG.THIARA_WHATSAPP, alerta);
}

async function pausarPorTrava(telefoneOriginal, motivo, ultimaMensagem, respostaSegura = null) {
  const telefone = limparTelefone(telefoneOriginal);
  const sessao = garantirSessao(telefone);
  atendimentosManuais.add(telefone);
  sessao.modo = "manual";
  sessao.pausado = true;
  sessao.motivoPausa = motivo;
  const alerta = `🚨 INTERVENÇÃO NECESSÁRIA — LIA PAUSADA\n\n📱 Candidato:\n+${telefone}\n\n⚠️ Motivo:\n${motivo}\n\n💬 Última mensagem:\n${ultimaMensagem || "Não informada"}\n\n✅ A conversa foi colocada em modo MANUAL.`;
  await enviarMensagem(CONFIG.THIARA_WHATSAPP, alerta);
  if (respostaSegura) {
    await enviarMensagem(telefone, respostaSegura);
    registrarEntradaSessao(sessao, "assistant", respostaSegura);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", respostaSegura, sessao.nome || "");
  }
  await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");
  return true;
}

async function aplicarTravasEntrada(telefoneOriginal, mensagem) {
  const telefone = limparTelefone(telefoneOriginal);
  const texto = mensagem || "";

  // VERSÃO ENXUTA: a Lia NÃO deve jogar candidatos normais para manual.
  // Manual automático fica restrito a pedido explícito de humano/responsável.
  // Todo o restante no máximo gera alerta para Thiara, mas a Lia continua atendendo.

  if (contemAlguma(texto, TRAVAS.humano)) {
    return await pausarPorTrava(
      telefone,
      "Candidato pediu atendimento humano/responsável",
      texto,
      "Claro. Vou direcionar sua mensagem para a equipe da Effect dar continuidade ao atendimento com você. 💙"
    );
  }

  // Alertas sem pausar a Lia.
  if (contemAlguma(texto, TRAVAS.entrevista)) await enviarAlertaSimplesThiara(telefone, "📅 CANDIDATO FALOU SOBRE ENTREVISTA", texto);
  if (contemAlguma(texto, TRAVAS.retorno)) await enviarAlertaSimplesThiara(telefone, "🔁 CANDIDATO PEDIU RETORNO DO PROCESSO", texto);
  if (contemAlguma(texto, TRAVAS.exFuncionario)) await enviarAlertaSimplesThiara(telefone, "📌 CANDIDATO DISSE QUE JÁ TRABALHOU NA EMPRESA", texto);
  if (contemAlguma(texto, TRAVAS.urgencia)) await enviarAlertaSimplesThiara(telefone, "⚠️ CANDIDATO EM URGÊNCIA/VULNERABILIDADE", texto);
  if (contemAlguma(texto, TRAVAS.indicacao)) await enviarAlertaSimplesThiara(telefone, "📌 CANDIDATO COM INDICAÇÃO", texto);
  if (contemAlguma(texto, TRAVAS.cargoEstrategico)) await enviarAlertaSimplesThiara(telefone, "⭐ CANDIDATO/CARGO ESTRATÉGICO IDENTIFICADO", texto);
  if (contemAlguma(texto, TRAVAS.pcdSaude)) await enviarAlertaSimplesThiara(telefone, "♿ MENSAGEM ENVOLVE PCD/SAÚDE/LAUDO", texto);
  if (contemAlguma(texto, TRAVAS.dadosSensiveis)) await enviarAlertaSimplesThiara(telefone, "🔒 MENSAGEM ENVOLVE DADOS PESSOAIS", texto);
  if (contemAlguma(texto, TRAVAS.juridico)) await enviarAlertaSimplesThiara(telefone, "⚖️ MENSAGEM ENVOLVE TEMA TRABALHISTA/JURÍDICO", texto);
  if (contemAlguma(texto, TRAVAS.empresa)) await enviarAlertaSimplesThiara(telefone, "🏢 POSSÍVEL CLIENTE/EMPRESA", texto);
  if (detectarMenorIdade(texto)) await enviarAlertaSimplesThiara(telefone, "🚸 POSSÍVEL CANDIDATO MENOR DE IDADE", texto);
  if (ultimasPerguntasRepetidas(garantirSessao(telefone))) await enviarAlertaSimplesThiara(telefone, "🔁 POSSÍVEL LOOP DE PERGUNTA DA LIA", texto);

  return false;
}

async function aplicarTravasResposta(telefoneOriginal, resposta, mensagemOriginal) {
  const telefone = limparTelefone(telefoneOriginal);
  const texto = resposta || "";

  // Nunca pausar por resposta de baixa confiança. Apenas alerta.
  if (contemAlguma(texto, TRAVAS.baixaConfianca)) {
    await enviarAlertaSimplesThiara(
      telefone,
      "⚠️ RESPOSTA DA LIA COM BAIXA CONFIANÇA",
      `Mensagem do candidato: ${mensagemOriginal || ""}\n\nResposta da Lia: ${resposta || ""}`
    );
  }

  return false;
}

// ============================================================
// SHEETS
// ============================================================

async function salvarMensagemSheets(telefoneOriginal, role, mensagem, nome, timestampMs = null) {
  const telefone = limparTelefone(telefoneOriginal);
  const MAX_TENTATIVAS = 3;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      if (!CONFIG.VAGAS_URL) return;
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      const ms = timestampMs || Date.now();
      const payload = JSON.stringify({
        acao: "salvarMensagem",
        telefone,
        role,
        mensagem,
        nome: nome || "",
        timestamp: new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        timestampISO: new Date(ms).toISOString(),
        timestampMs: ms
      });
      await axios.post(urlBase, payload, { headers: { "Content-Type": "text/plain" }, timeout: 15000, maxRedirects: 5 });
      return;
    } catch (e) {
      console.error(`Erro salvarMensagemSheets (${tentativa}/3):`, e.message);
      if (tentativa < MAX_TENTATIVAS) await sleep(2000 * tentativa);
    }
  }
}

async function salvarConversaCompletaSheets(telefoneOriginal, historico, nome) {
  const telefone = limparTelefone(telefoneOriginal);
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const sessaoAtualSheets = sessoes[telefone] || {};
    const curriculosMeta = (Array.isArray(sessaoAtualSheets.curriculos) ? sessaoAtualSheets.curriculos : (sessaoAtualSheets.curriculo ? [sessaoAtualSheets.curriculo] : [])).map(cv => ({
      filename: cv.filename || "",
      mimeType: cv.mimeType || "",
      sizeBytes: cv.sizeBytes || null,
      mediaId: cv.mediaId || null,
      recebidoEm: cv.recebidoEm || "",
      recebidoEmMs: cv.recebidoEmMs || 0,
      driveLink: cv.driveLink || "",
      pasta: cv.pasta || "",
      analiseStatus: cv.analiseStatus || "recebido"
    }));
    const payload = JSON.stringify({ acao: "salvarConversaCompleta", telefone, nome: nome || "", historico: historico || [], modo: sessaoAtualSheets.modo || "automatico", pausado: sessaoAtualSheets.pausado || false, motivoPausa: sessaoAtualSheets.motivoPausa || "", unreadCount: Number(sessaoAtualSheets.unreadCount || 0), curriculos: curriculosMeta, curriculo: curriculosMeta[0] || null, timestamp: agora(), timestampISO: agoraISO(), timestampMs: Date.now() });
    await axios.post(urlBase, payload, { headers: { "Content-Type": "text/plain" }, timeout: 30000, maxRedirects: 5 });
  } catch (e) {
    console.error("Erro salvarConversaCompletaSheets:", e.message);
  }
}

async function carregarSessoesDoSheets() {
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=conversas`, { timeout: 15000, maxRedirects: 5 });
    const data = r.data;
    if (!data.sucesso || !data.sessoes) return;

    Object.entries(data.sessoes).forEach(([telOriginal, sessao]) => {
      const tel = limparTelefone(telOriginal);
      const motivoOriginal = sessao.motivoPausa || "";
      const motivoNormalizado = normalizarTexto(motivoOriginal);

      // Limpa praticamente todos os manuais antigos criados por travas automáticas.
      // Mantém manual somente quando foi assumido no Inbox/Laura ou pedido explícito de humano.
      const motivoMantemManual =
        motivoNormalizado.includes("pausado manualmente no inbox") ||
        motivoNormalizado.includes("atendimento assumido manualmente") ||
        motivoNormalizado.includes("candidato pediu atendimento humano") ||
        motivoNormalizado.includes("humano/responsavel") ||
        motivoNormalizado.includes("humano/responsável");

      const modoOriginal = sessao.modo || (sessao.pausado ? "manual" : "automatico");
      const manualAntigoIndevido = modoOriginal === "manual" && !motivoMantemManual;
      const modo = manualAntigoIndevido ? "automatico" : modoOriginal;
      const pausado = manualAntigoIndevido ? false : (modo === "manual" || sessao.pausado === true);
      const motivoPausa = manualAntigoIndevido ? "" : motivoOriginal;

      const existente = sessoes[tel] || {};
      const curriculosExistentes = Array.isArray(existente.curriculos) ? existente.curriculos : (existente.curriculo ? [existente.curriculo] : []);
      const curriculosSheets = Array.isArray(sessao.curriculos) ? sessao.curriculos : (sessao.curriculo ? [sessao.curriculo] : []);
      const curriculosMesclados = curriculosExistentes.length ? curriculosExistentes : curriculosSheets;

      sessoes[tel] = {
        historico: Array.isArray(sessao.historico)
          ? sessao.historico.map(normalizarEventoHistorico).filter(h => h && h.content !== undefined)
          : [],
        nome: sessao.nome || null,
        modo,
        pausado,
        motivoPausa,
        unreadCount: Number(sessao.unreadCount || 0),
        curriculos: curriculosMesclados,
        curriculo: curriculosMesclados[0] || existente.curriculo || null,
        ultimaAnalise: existente.ultimaAnalise || sessao.ultimaAnalise || null,
        statusProcesso: existente.statusProcesso || sessao.statusProcesso || "Novo contato"
      };

      if (pausado) atendimentosManuais.add(tel);
      else atendimentosManuais.delete(tel);
    });

    console.log(`Sessões carregadas do Sheets: ${Object.keys(data.sessoes).length}`);
  } catch (e) {
    console.error("Erro carregarSessoesDoSheets:", e.message);
  }
}

carregarSessoesDoSheets();

// Salvamento periódico — em paralelo e só para sessões com mudança desde o último ciclo.
// (antes era sequencial para TODAS as sessões, com timeout de 20s cada — sob carga isso
// sozinho ultrapassava o intervalo de 5min e sobrecarregava o servidor, derrubando
// também as chamadas à API da Claude.)
const ultimoSaveSessao = {};

setInterval(async () => {
  const tarefas = Object.entries(sessoes)
    .filter(([telefone, sessao]) => {
      if (!sessao.historico || sessao.historico.length === 0) return false;
      const ultima = sessao.historico[sessao.historico.length - 1];
      const assinatura = `${sessao.historico.length}|${ultima?.timestampMs || ultima?.content || ""}`;
      if (ultimoSaveSessao[telefone] === assinatura) return false;
      ultimoSaveSessao[telefone] = assinatura;
      return true;
    })
    .map(([telefone, sessao]) =>
      salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome)
        .catch(e => console.error(`Erro ao salvar ${telefone} no ciclo periódico:`, e.message))
    );

  if (tarefas.length) {
    console.log(`Salvamento periódico: ${tarefas.length} sessão(ões) com mudanças.`);
    await Promise.allSettled(tarefas);
  }
}, 5 * 60 * 1000);

// ============================================================
// ROTAS PRINCIPAIS
// ============================================================

app.get("/", (req, res) => {
  res.send("Lia Effect rodando — modo supervisor + Linhares via planilha ✅");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    if (message.id && mensagensProcessadas.has(message.id)) return;
    if (message.id) { mensagensProcessadas.add(message.id); if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear(); }
    if (!message.text?.body && !message.document && !message.audio) return;
    const from = limparTelefone(message.from);
    const sessaoAtual = garantirSessao(from);
    const messageTimestampMs = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();
    if (message.text?.body) {
      const texto = message.text.body;
      registrarEntradaSessao(sessaoAtual, "user", texto, messageTimestampMs);
      marcarMensagemRecebida(sessaoAtual, messageTimestampMs);
      sessaoAtual.historico = sessaoAtual.historico.slice(-500);
      await salvarMensagemSheets(from, "user", texto, sessaoAtual.nome || "", messageTimestampMs);
      if (estaEmManual(from)) { console.log("LIA BLOQUEADA — ATENDIMENTO MANUAL:", from); await salvarConversaCompletaSheets(from, sessaoAtual.historico, sessaoAtual.nome); return; }
      const travou = await aplicarTravasEntrada(from, texto);
      if (travou) return;
      const resposta = await processarMensagem(from, texto);
      if (resposta) await enviarMensagem(from, resposta);
      return;
    }
    if (message.audio) {
      registrarEntradaSessao(sessaoAtual, "user", "[Áudio recebido]", messageTimestampMs);
      marcarMensagemRecebida(sessaoAtual, messageTimestampMs);
      sessaoAtual.historico = sessaoAtual.historico.slice(-500);
      await salvarMensagemSheets(from, "user", "[Áudio recebido]", sessaoAtual.nome || "", messageTimestampMs);
      if (estaEmManual(from)) { console.log("LIA BLOQUEADA — ÁUDIO EM ATENDIMENTO MANUAL:", from); await salvarConversaCompletaSheets(from, sessaoAtual.historico, sessaoAtual.nome); return; }
      const respostaAudio = "Recebi seu áudio! 🎧 No momento ainda não consigo ouvir áudios por aqui — pode me escrever a mesma informação por texto? Assim consigo te ajudar melhor. 💙";
      registrarEntradaSessao(sessaoAtual, "assistant", respostaAudio);
      marcarConversaRespondida(sessaoAtual);
      sessaoAtual.historico = sessaoAtual.historico.slice(-500);
      await salvarMensagemSheets(from, "assistant", respostaAudio, sessaoAtual.nome || "");
      await salvarConversaCompletaSheets(from, sessaoAtual.historico, sessaoAtual.nome);
      await enviarMensagem(from, respostaAudio);
      return;
    }
    if (message.document) {
      const emManual = estaEmManual(from);
      const conteudoDoc = `[Documento/Currículo recebido]`;

      // Evita duplicar a mesma linha no histórico quando a Meta reenvia o evento.
      const ultimo = sessaoAtual.historico?.[sessaoAtual.historico.length - 1];
      const ultimoMs = Number(ultimo?.timestampMs || 0);
      if (!(ultimo && ultimo.role === "user" && String(ultimo.content || "").includes("Documento/Currículo") && Math.abs(ultimoMs - messageTimestampMs) < 120000)) {
        registrarEntradaSessao(sessaoAtual, "user", conteudoDoc, messageTimestampMs);
        await salvarMensagemSheets(from, "user", conteudoDoc, sessaoAtual.nome || "", messageTimestampMs);
      }

      marcarMensagemRecebida(sessaoAtual, messageTimestampMs);
      sessaoAtual.historico = sessaoAtual.historico.slice(-500);

      if (!emManual) {
        await enviarMensagem(from, "Perfeito, recebi seu currículo. 💙");
      } else {
        console.log("CURRÍCULO RECEBIDO EM MANUAL — salvando silenciosamente:", from);
      }

      const resposta = await processarCurriculo(from, message.document, { silencioso: emManual, timestampMs: messageTimestampMs });
      if (!emManual && resposta) await enviarMensagem(from, resposta);
      return;
    }
  } catch (erro) {
    console.error("Erro no webhook:", JSON.stringify(erro.response?.data || erro.message));
  }
});

// ============================================================
// ROTAS HTML — PÁGINAS
// ============================================================

app.get("/painel", (req, res) => res.sendFile(path.join(__dirname, "painel.html")));
app.get("/sheets", (req, res) => res.sendFile(path.join(__dirname, "sheets-viewer.html")));
app.get("/inbox", (req, res) => res.sendFile(path.join(__dirname, "inbox.html")));
app.get("/cliente", (req, res) => res.sendFile(path.join(__dirname, "cliente.html")));
app.get("/meu-app", (req, res) => res.sendFile(path.join(__dirname, "meu-app.html")));
app.get("/cliente/:id", (req, res) => res.sendFile(path.join(__dirname, "cliente.html")));

// ============================================================
// ROTAS API — SHEETS
// ============================================================

app.get("/sheets/candidatos", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ candidatos: [] });
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=candidatos`, { timeout: 15000 });
    res.json(r.data);
  } catch (e) { res.json({ candidatos: [], erro: e.message }); }
});

app.get("/sheets/vagas", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ vagas: [] });
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=vagas`, { timeout: 15000 });
    res.json(r.data);
  } catch (e) { res.json({ vagas: [], erro: e.message }); }
});

app.post("/sheets/candidatos/status", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ ok: false });
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, { acao: "salvarAnalise", telefone: req.body.telefone, status: req.body.status, observacoes: req.body.observacao }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
    res.json({ ok: true, sucesso: true });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ============================================================
// ROTAS API — INBOX
// ============================================================

app.post("/inbox/config-novas-conversas", (req, res) => {
  novaConversaIniciaManual = req.body.manual === true;
  res.json({ ok: true, novaConversaIniciaManual });
});

app.get("/inbox/sessoes", (req, res) => {
  try {
    const lista = Object.entries(sessoes).map(([tel, sessao]) => {
      const telefone = limparTelefone(tel);
      garantirSessao(telefone);

      // Segurança extra: se restou motivo antigo agressivo em memória, não mostrar como manual.
      const motivoNormalizado = normalizarTexto(sessao.motivoPausa || "");
      const manualAntigoIndevido =
        motivoNormalizado.includes("conversa longa sem avanco") ||
        motivoNormalizado.includes("conversa longa sem avanço") ||
        motivoNormalizado.includes("baixa confianca") ||
        motivoNormalizado.includes("baixa confiança") ||
        motivoNormalizado.includes("solicitacao de retorno") ||
        motivoNormalizado.includes("solicitação de retorno") ||
        motivoNormalizado.includes("assunto relacionado a entrevista") ||
        motivoNormalizado.includes("assunto relacionado à entrevista") ||
        motivoNormalizado.includes("possivel repeticao") ||
        motivoNormalizado.includes("possível repetição");

      if (manualAntigoIndevido) {
        atendimentosManuais.delete(telefone);
        sessao.modo = "automatico";
        sessao.pausado = false;
        sessao.motivoPausa = "";
      }

      return [telefone, normalizarSessaoParaInbox(telefone, sessao)];
    }).sort((a, b) => Number(b[1].lastMessageAtMs || 0) - Number(a[1].lastMessageAtMs || 0));

    const dados = {};
    lista.forEach(([telefone, sessao]) => { dados[telefone] = sessao; });

    const totalConversas = lista.length;
    const totalNaoLidas = lista.filter(([, sessao]) => Number(sessao.unreadCount || 0) > 0).length;
    const totalMensagensNaoLidas = lista.reduce((acc, [, sessao]) => acc + Number(sessao.unreadCount || 0), 0);

    res.json({
      sessoes: dados,
      totalConversas,
      totalNaoLidas,
      totalMensagensNaoLidas,
      novaConversaIniciaManual,
      atualizadoEm: new Date().toISOString(),
      atualizadoEmFormatado: formatarDataWhatsApp(Date.now())
    });
  } catch (erro) {
    res.json({ sessoes: {}, totalConversas: 0, totalNaoLidas: 0, totalMensagensNaoLidas: 0, erro: erro.message });
  }
});

app.post("/inbox/marcar-lida", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from || req.body.numero || req.body.whatsapp);
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });
    const sessao = garantirSessao(telefone);
    sessao.unreadCount = 0;
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return res.json({ ok: true, telefone, unreadCount: 0 });
  } catch (erro) {
    return res.json({ ok: false, erro: erro.message });
  }
});

app.post("/inbox/pausar", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from || req.body.numero || req.body.whatsapp);
    const devePausar = req.body.pausado === true || req.body.manual === true || req.body.modo === "manual" || req.body.mode === "manual" || req.body.status === "manual";
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });
    const sessao = garantirSessao(telefone);
    if (devePausar) { atendimentosManuais.add(telefone); sessao.modo = "manual"; sessao.pausado = true; sessao.motivoPausa = sessao.motivoPausa || "Pausado manualmente no inbox"; }
    else { atendimentosManuais.delete(telefone); sessao.modo = "automatico"; sessao.pausado = false; sessao.motivoPausa = ""; }
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return res.json({ ok: true, telefone, modo: sessao.modo, pausado: sessao.pausado, motivoPausa: sessao.motivoPausa || "" });
  } catch (erro) { return res.json({ ok: false, erro: erro.message }); }
});

app.post("/inbox/modo", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from || req.body.numero || req.body.whatsapp);
    const modo = req.body.modo || req.body.mode;
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });
    const sessao = garantirSessao(telefone);
    if (modo === "manual") { atendimentosManuais.add(telefone); sessao.modo = "manual"; sessao.pausado = true; sessao.motivoPausa = sessao.motivoPausa || "Pausado manualmente no inbox"; }
    else { atendimentosManuais.delete(telefone); sessao.modo = "automatico"; sessao.pausado = false; sessao.motivoPausa = ""; }
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return res.json({ ok: true, telefone, modo: sessao.modo, pausado: sessao.pausado, motivoPausa: sessao.motivoPausa || "" });
  } catch (erro) { return res.json({ ok: false, erro: erro.message }); }
});

app.post("/inbox/enviar", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from || req.body.numero || req.body.whatsapp);
    const mensagem = req.body.mensagem || req.body.message || req.body.texto || req.body.text;
    if (!telefone || !mensagem) return res.json({ ok: false, erro: "Dados incompletos" });

    const sessao = garantirSessao(telefone);

    // Quando a Laura envia pelo Inbox, a conversa deve ficar em manual.
    atendimentosManuais.add(telefone);
    sessao.modo = "manual";
    sessao.pausado = true;
    sessao.motivoPausa = sessao.motivoPausa || "Atendimento assumido manualmente";

    // Primeiro envia para o WhatsApp.
    await enviarMensagem(telefone, mensagem);

    // Depois grava imediatamente no histórico do servidor.
    // Isso permite que o Inbox recarregue e já encontre a mensagem enviada.
    const eventoSalvo = registrarEntradaSessao(sessao, "assistant", mensagem);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);

    await salvarMensagemSheets(telefone, "assistant", mensagem, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

    return res.json({
      ok: true,
      telefone,
      modo: "manual",
      pausado: true,
      mensagem: eventoSalvo,
      historicoLength: sessao.historico.length
    });
  } catch (erro) {
    return res.json({ ok: false, erro: erro.message });
  }
});

app.get("/inbox/curriculo/:telefone", (req, res) => {
  try {
    const tel = limparTelefone(req.params.telefone);
    const sessao = sessoes[tel];
    if (!sessao) return res.status(404).send("Conversa não encontrada");

    const lista = Array.isArray(sessao.curriculos) && sessao.curriculos.length ? sessao.curriculos : (sessao.curriculo ? [sessao.curriculo] : []);
    if (!lista.length) return res.status(404).send("Currículo não encontrado");

    const idx = Math.max(0, Math.min(Number(req.query.idx || 0), lista.length - 1));
    const cv = lista[idx];
    let buffer = null;
    if (cv?.base64) buffer = Buffer.from(cv.base64, "base64");
    else if (cv?.localPath && fs.existsSync(cv.localPath)) buffer = fs.readFileSync(cv.localPath);
    if (!buffer) return res.status(404).send("Arquivo do currículo indisponível. Abra pelo Drive ou solicite reenvio.");
    const inline = req.query.inline === "1" || req.query.inline === "true";
    res.set("Content-Type", cv.mimeType || "application/octet-stream");
    res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${cv.filename || "curriculo"}"`);
    res.send(buffer);
  } catch (erro) {
    res.status(500).send("Erro ao obter currículo");
  }
});


app.post("/inbox/observacao", async (req, res) => {
  const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from);
  const observacao = req.body.observacao || req.body.note || "";
  if (!telefone) return res.json({ ok: false });
  try {
    if (CONFIG.VAGAS_URL) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      await axios.post(urlBase, { acao: "salvarMensagem", telefone, role: "observacao", mensagem: observacao, nome: sessoes[telefone]?.nome || "" }, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    }
  } catch (e) { console.error("Erro salvar obs:", e.message); }
  res.json({ ok: true });
});


app.post("/inbox/status", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from);
    const status = String(req.body.status || "").trim();
    const prioritario = req.body.prioritario === true;
    const enviar = req.body.enviarMensagem === true;
    const mensagem = String(req.body.mensagem || "").trim();
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });

    const sessao = garantirSessao(telefone);
    sessao.statusProcesso = status || sessao.statusProcesso || "Novo contato";
    if (prioritario) sessao.motivoPausa = "Prioritário";

    if (CONFIG.VAGAS_URL && status) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      await axios.post(urlBase, {
        acao: "salvarAnalise",
        telefone,
        nome: sessao.nome || sessao.ultimaAnalise?.nome || "",
        status,
        observacoes: `${status}${prioritario ? " | Prioritário" : ""}`,
        vagaInteresse: sessao.ultimaAnalise?.vagaInteresse || "",
        idVaga: sessao.ultimaAnalise?.idVaga || "",
        curriculoDriveLink: sessao.curriculo?.driveLink || sessao.ultimaAnalise?.curriculoDriveLink || "",
        perfilResumido: sessao.ultimaAnalise?.perfilResumido || sessao.ultimaAnalise?.motivoMatch || ""
      }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
    }

    if (enviar && mensagem) {
      await enviarMensagem(telefone, mensagem);
      registrarEntradaSessao(sessao, "assistant", mensagem);
      marcarConversaRespondida(sessao);
      await salvarMensagemSheets(telefone, "assistant", mensagem, sessao.nome || sessao.ultimaAnalise?.nome || "");
    }

    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || sessao.ultimaAnalise?.nome || "");
    return res.json({ ok: true, telefone, status: sessao.statusProcesso, prioritario });
  } catch (erro) {
    console.error("Erro /inbox/status:", erro.message);
    return res.json({ ok: false, erro: erro.message });
  }
});

app.post("/inbox/encaminhar", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from);
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });

    const sessao = garantirSessao(telefone);
    const idVaga = String(req.body.idVaga || req.body.id || "").trim();
    const vagaInteresse = String(req.body.vagaInteresse || req.body.cargo || "").trim();
    const vaga = req.body.vaga || {};
    const agoraLocal = agora();

    sessao.statusProcesso = "Interessado";
    sessao.aguardandoConfirmacaoInteresse = false;
    sessao.ultimaAnalise = {
      ...(sessao.ultimaAnalise || {}),
      idVaga,
      vagaInteresse,
      status: "Interessado",
      curriculoDriveLink: sessao.curriculo?.driveLink || sessao.ultimaAnalise?.curriculoDriveLink || ""
    };

    if (CONFIG.VAGAS_URL) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      const basePayload = {
        telefone,
        nome: sessao.nome || sessao.ultimaAnalise?.nome || "",
        status: "Interessado",
        vagaInteresse,
        idVaga,
        proximaAcao: "Encaminhado manualmente pelo Inbox",
        observacoes: `Encaminhado manualmente pelo Inbox em ${agoraLocal}.`,
        curriculoDriveLink: sessao.curriculo?.driveLink || sessao.ultimaAnalise?.curriculoDriveLink || "",
        perfilResumido: sessao.ultimaAnalise?.perfilResumido || sessao.ultimaAnalise?.motivoMatch || sessao.ultimaAnalise?.pontosFortes || ""
      };
      await axios.post(urlBase, { acao: "salvarAnalise", ...basePayload }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
      try {
        await axios.post(urlBase, { acao: "confirmarInteresse", ...basePayload }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
      } catch (e) {
        console.error("confirmarInteresse manual falhou, mas salvarAnalise rodou:", e.message);
      }
    }

    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || sessao.ultimaAnalise?.nome || "");
    return res.json({ ok: true, telefone, idVaga, vagaInteresse, status: "Interessado" });
  } catch (erro) {
    console.error("Erro /inbox/encaminhar:", erro.message);
    return res.json({ ok: false, erro: erro.message });
  }
});


// ============================================================
// ROTA — PORTAL DO CLIENTE
// ============================================================

app.post("/cliente/solicitar", async (req, res) => {
  try {
    const d = req.body;
    const msg = `🆕 NOVA SOLICITAÇÃO DE VAGA — Effect

🏢 EMPRESA
• Nome: ${d.empresa_nome || ''}
• Responsável: ${d.responsavel_nome || ''} ${d.responsavel_cargo ? '('+d.responsavel_cargo+')' : ''}
• WhatsApp: ${d.responsavel_whatsapp || ''}
• E-mail: ${d.responsavel_email || ''}
• Segmento: ${d.segmento || ''}

💼 VAGA
• Cargo: ${d.vaga_cargo || ''} (${d.vaga_quantidade || '1'} vaga(s))
• Cidade: ${d.vaga_cidade || ''}
• Salário: ${d.vaga_salario || 'A combinar'}
• Horário: ${d.vaga_horario || ''}
• Benefícios: ${d.vaga_beneficios || ''}
• Responsabilidades: ${d.vaga_responsabilidades || ''}
• Requisitos: ${d.vaga_requisitos || ''}

👤 PERFIL
• Escolaridade: ${d.perfil_escolaridade || ''}
• Experiência: ${d.perfil_experiencia || ''}
• Competências: ${d.perfil_competencias || ''}
${d.perfil_obs ? '• Obs: '+d.perfil_obs : ''}

📄 CONTRATO
• Razão social: ${d.contrato_razao || ''}
• CNPJ: ${d.contrato_cnpj || ''}
• Endereço: ${d.contrato_endereco || ''}
• Serviço: ${d.contrato_servico || ''}
• Valor: ${d.contrato_valor || 'A definir'}
• Pagamento: ${d.contrato_pagamento || ''}
${d.contrato_obs ? '• Obs: '+d.contrato_obs : ''}`;

    await enviarMensagem(CONFIG.THIARA_WHATSAPP, msg);

    if (CONFIG.VAGAS_URL) {
      try {
        const urlBase = CONFIG.VAGAS_URL.split("?")[0];
        await axios.post(urlBase, { acao: "salvarAnalise", cargo: d.vaga_cargo, cliente: d.empresa_nome, cidade: d.vaga_cidade, salario: d.vaga_salario, horario: d.vaga_horario, beneficios: d.vaga_beneficios, responsabilidades: d.vaga_responsabilidades, requisitos: d.vaga_requisitos, escolaridade: d.perfil_escolaridade, experiencia: d.perfil_experiencia, contato: d.responsavel_whatsapp, origem: "Portal do Cliente" }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
      } catch(e) { console.error("Erro salvar vaga cliente:", e.message); }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("Erro /cliente/solicitar:", e.message);
    res.json({ ok: false, erro: e.message });
  }
});

app.post("/cliente/disponibilidade", async (req, res) => {
  try {
    const { slots, empresa } = req.body;
    if (!slots || !slots.length) return res.json({ ok: false });
    const msg = `📅 DISPONIBILIDADE DE AGENDA RECEBIDA\n\n🏢 Empresa: ${empresa || 'Cliente'}\n\nHorários disponíveis para entrevistas:\n${slots.sort().map(s => {
      const [data, hora] = s.split('_');
      const d = new Date(data + 'T12:00:00');
      return `• ${d.toLocaleDateString('pt-BR', {weekday:'short',day:'2-digit',month:'2-digit'})} às ${hora}`;
    }).join('\n')}\n\nAgende pelo painel: /painel → 📅 Agenda`;
    await enviarMensagem(CONFIG.THIARA_WHATSAPP, msg);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ============================================================
// ROTA — TRANSIÇÃO LIA → LAURA
// ============================================================

app.post("/inbox/transicao", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    if (!telefone) return res.json({ ok: false });
    const msg = "Olá! 😊 A partir de agora, a Laura da nossa equipe Effect dará continuidade ao seu atendimento. Pode falar! 💙";
    await enviarMensagem(telefone, msg);
    const sessao = garantirSessao(telefone);
    registrarEntradaSessao(sessao, "assistant", msg);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", msg, sessao.nome || "");
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// ============================================================
// PROCESSAMENTO
// ============================================================

const FALLBACK_INSTABILIDADE = "Tive uma instabilidade aqui. Pode me mandar novamente?";
const FALLBACK_RATE_LIMIT = "Estou processando suas informações, só preciso de um instantinho. Pode me responder novamente em alguns segundos?";

async function processarMensagem(telefoneOriginal, mensagem) {
  const telefone = limparTelefone(telefoneOriginal);
  const sessao = garantirSessao(telefone);
  if (estaEmManual(telefone)) { console.log("BLOQUEIO INTERNO — IA NÃO CHAMADA:", telefone); return null; }
  if (ehSaudacaoSimples(mensagem) && sessao.historico.length <= 1) {
    const candidatoExistente = await buscarCandidatoNaPlanilha(telefone);
    if (candidatoExistente?.encontrado) {
      const nome = candidatoExistente.candidato?.Nome || "";
      const resposta = `Olá${nome ? ", " + primeiroNome(nome) : ""}! 😊\n\nSeu currículo já está cadastrado em nosso Banco de Talentos.\n\nQuando surgir uma oportunidade compatível com seu perfil, entraremos em contato. 💙\n\nCaso queira atualizar alguma informação profissional ou buscar uma vaga específica, estou à disposição.`;
      registrarEntradaSessao(sessao, "assistant", resposta);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", resposta, nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, nome);
      return resposta;
    }
  }
  if (sessao.aguardandoConfirmacaoInteresse && ehConfirmacaoInteresse(mensagem)) {
    await confirmarInteresseNaPlanilha(telefone, sessao.ultimaAnalise);
    await enviarAlertaInteresseThiara(sessao.ultimaAnalise, telefone);
    sessao.aguardandoConfirmacaoInteresse = false;
    const resposta = `Perfeito, ${sessao.ultimaAnalise?.nome || ""}! 😊\n\nJá registrei seu interesse na oportunidade e sua candidatura seguirá para análise da nossa equipe.\n\nCaso seu perfil avance para a próxima etapa, entraremos em contato pelos canais informados.\n\nObrigada pelo interesse e boa sorte! 💙`;
    registrarEntradaSessao(sessao, "assistant", resposta);
      marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return resposta;
  }
  const vagas = await buscarVagas();
  const prompt = montarPromptConversa(sessao, mensagem, vagas);
  const resposta = await chamarClaudeTexto(prompt);

  // Se a chamada à Claude falhou (mensagem genérica de instabilidade/rate-limit),
  // NÃO manda isso pro candidato e NÃO grava no histórico — evita o spam de
  // "Tive uma instabilidade aqui..." em loop. Só alerta a Thiara uma vez.
  if (resposta === FALLBACK_INSTABILIDADE || resposta === FALLBACK_RATE_LIMIT) {
    if (!sessao._alertaInstabilidadeEnviado || (Date.now() - sessao._alertaInstabilidadeEnviado) > 10 * 60 * 1000) {
      sessao._alertaInstabilidadeEnviado = Date.now();
      await enviarAlertaSimplesThiara(telefone, "🔥 FALHA AO CHAMAR A IA — LIA NÃO RESPONDEU", mensagem);
    }
    return null;
  }

  const respostaTravada = await aplicarTravasResposta(telefone, resposta, mensagem);
  if (respostaTravada) return null;
  registrarEntradaSessao(sessao, "assistant", resposta);
      marcarConversaRespondida(sessao);
  sessao.historico = sessao.historico.slice(-500);
  await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);
  await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
  return resposta;
}

async function processarCurriculo(telefoneOriginal, documento, opcoes = {}) {
  const telefone = limparTelefone(telefoneOriginal);
  const silencioso = opcoes.silencioso === true;
  const recebidoEmMs = opcoes.timestampMs || Date.now();
  const sessao = garantirSessao(telefone);
  let cvSalvo = null;

  try {
    const { texto: textoCurriculo, buffer: arquivoBuffer, filename: arquivoNome, mimeType, sizeBytes } = await baixarELerPdf(documento.id, documento.filename, documento.mime_type || documento.mimeType);

    // 1) RECEBIMENTO/SALVAMENTO DO CURRÍCULO — independente da IA e do Drive.
    if (arquivoBuffer) {
      const localInfo = salvarCurriculoLocal(arquivoBuffer, arquivoNome || `curriculo_${telefone}`, telefone, recebidoEmMs) || {};
      cvSalvo = registrarCurriculoNaSessao(sessao, {
        mediaId: documento.id || null,
        base64: arquivoBuffer.toString("base64"),
        localPath: localInfo.localPath || "",
        localFilename: localInfo.localFilename || "",
        filename: arquivoNome || `curriculo_${telefone}`,
        mimeType,
        sizeBytes,
        recebidoEmMs,
        recebidoEm: new Date(recebidoEmMs).toISOString(),
        analiseStatus: "recebido"
      });
      sessao.curriculo = cvSalvo;
      console.log(`CV SALVO NO INBOX — ${telefone} — ${cvSalvo.filename} — currículos na sessão: ${Array.isArray(sessao.curriculos) ? sessao.curriculos.length : 1}`);

      // Tenta subir no Drive mesmo se a IA estiver fora. Não pode bloquear o recebimento.
      try {
        const driveInfo = await uploadCurriculoDrive(arquivoBuffer, cvSalvo.filename, "Currículos Recebidos", telefone, mimeType);
        if (driveInfo) {
          cvSalvo.driveLink = driveInfo.link;
          cvSalvo.pasta = driveInfo.pasta;
          sessao.curriculo = cvSalvo;
        }
      } catch (e) {
        console.error(`Currículo de ${telefone}: upload no Drive falhou, mas arquivo ficou salvo no Inbox:`, e.message);
        if (cvSalvo) cvSalvo.analiseStatus = "drive_indisponivel";
      }
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");
    }

    // Se não houver texto legível, ainda assim o currículo fica salvo e abrindo.
    if (!textoCurriculo || textoCurriculo.length < 50) {
      if (cvSalvo) cvSalvo.analiseStatus = "sem_texto";
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");
      return silencioso ? null : "Recebi seu currículo com sucesso. A análise automática não conseguiu ler o conteúdo do arquivo, mas ele ficou salvo para avaliação da equipe. 💙";
    }

    // 2) ANÁLISE DA IA — opcional. Se falhar, não invalida o currículo.
    let analise;
    try {
      const vagas = await buscarVagas();
      let vagasFiltradas = filtrarVagasRelevantes(vagas, textoCurriculo, sessao.historico).slice(0, 5);
      const vagaRH = candidatoTemPerfilRH(textoCurriculo) ? buscarVagaRH(vagas) : null;
      if (vagaRH && !vagasFiltradas.some(v => campo(v, ["idVaga", "ID Vaga", "ID"]) === campo(vagaRH, ["idVaga", "ID Vaga", "ID"]))) {
        vagasFiltradas = [vagaRH, ...vagasFiltradas].slice(0, 5);
      }

      const prompt = montarPromptAnaliseEstruturada(textoCurriculo, vagasFiltradas);
      analise = await chamarGeminiJSON(prompt).catch(() => chamarClaudeJSON(prompt));

      if (vagaRH) {
        const cargoRH = campo(vagaRH, ["cargo", "Cargo", "CARGO"]);
        const cidadeRH = campo(vagaRH, ["cidade", "Cidade/Bairro", "Cidade", "Local"]);
        const idRH = campo(vagaRH, ["idVaga", "ID Vaga", "ID"]);
        const semMatch = !analise.vagaInteresse || normalizarTexto(analise.mensagemCandidato || "").includes("nao ha vagas") || normalizarTexto(analise.mensagemCandidato || "").includes("não há vagas");
        if (semMatch || !isRHVaga({ cargo: analise.vagaInteresse, area: analise.areaInteresse, palavrasChave: analise.motivoMatch })) {
          analise.vagaInteresse = cargoRH || "Analista Administrativo (RH)";
          analise.idVaga = idRH || analise.idVaga || "";
          analise.cidade = analise.cidade || cidadeRH || "Serra/ES";
          analise.areaInteresse = analise.areaInteresse || "Recursos Humanos";
          analise.scoreGeral = Math.max(Number(analise.scoreGeral || 0), 75);
          analise.scoreVaga = Math.max(Number(analise.scoreVaga || 0), 75);
          analise.classificacao = analise.classificacao || "Bom";
          analise.motivoMatch = analise.motivoMatch || "Experiência/aderência com RH, Recursos Humanos, DP, R&S ou Gente e Gestão.";
          analise.mensagemCandidato = `😊 Olá, ${analise.nome || "tudo bem"}!

Analisei seu currículo e encontrei uma vaga que pode ter aderência ao seu perfil:

📍 ${cargoRH || "Analista Administrativo (RH)"}
📍 ${cidadeRH || "Serra/ES"}

Vou registrar seu interesse e encaminhar seu perfil para avaliação da nossa equipe. Você teria interesse em participar deste processo seletivo? 💙`;
        }
      }

      if (cvSalvo) {
        cvSalvo.analiseStatus = "analisado";
        analise.curriculoDriveLink = cvSalvo.driveLink || null;
      }

      await salvarAnaliseNaPlanilha(telefone, analise);
      await enviarAlertaThiara(analise, telefone);
      sessao.aguardandoConfirmacaoInteresse = true;
      sessao.ultimaAnalise = analise;
      sessao.nome = analise.nome || sessao.nome;

      if (!silencioso) {
        registrarEntradaSessao(sessao, "assistant", analise.mensagemCandidato);
        marcarConversaRespondida(sessao);
        sessao.historico = sessao.historico.slice(-500);
        await salvarMensagemSheets(telefone, "assistant", analise.mensagemCandidato, analise.nome);
      } else {
        console.log(`CURRÍCULO DE ${telefone} SALVO/ANALISADO EM MODO MANUAL — sem resposta automática ao candidato.`);
      }

      await salvarConversaCompletaSheets(telefone, sessao.historico, analise.nome || sessao.nome || "");
      return silencioso ? null : analise.mensagemCandidato;
    } catch (erroIA) {
      if (cvSalvo) cvSalvo.analiseStatus = "analise_indisponivel";
      console.error("Análise automática indisponível, mas currículo foi salvo:", JSON.stringify(erroIA.response?.data || erroIA.message || erroIA));
      await enviarAlertaSimplesThiara(telefone, "⚠️ CURRÍCULO SALVO, MAS IA NÃO ANALISOU", String(erroIA.message || erroIA));
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");
      return silencioso ? null : "Recebi seu currículo com sucesso. A análise automática está temporariamente indisponível, mas o arquivo ficou salvo para avaliação da equipe. 💙";
    }
  } catch (erro) {
    console.error("Erro ao receber/salvar currículo:", JSON.stringify(erro.response?.data || erro.message || erro));
    await enviarAlertaSimplesThiara(telefone, "🔥 FALHA AO RECEBER/SALVAR CURRÍCULO", String(erro.message || erro));
    return silencioso ? null : "Recebi seu arquivo, mas tive uma falha técnica para salvar o currículo. Pode me encaminhar novamente, por favor?";
  }
}


async function baixarELerPdf(mediaId, filenameOriginal, mimeTypeOriginal = "") {
  const mediaInfo = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` }, timeout: 15000 });
  const arquivo = await axios.get(mediaInfo.data.url, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` }, responseType: "arraybuffer", timeout: 30000 });
  const buffer = Buffer.from(arquivo.data);
  const filename = filenameOriginal || "curriculo";
  const mimeType = mimeTypeOriginal || arquivo.headers?.["content-type"] || "application/octet-stream";
  let texto = "";

  // A leitura automática só é obrigatória para análise. O salvamento do arquivo não depende dela.
  const ehPdf = /pdf/i.test(mimeType) || /\.pdf$/i.test(filename);
  if (ehPdf) {
    try {
      const pdfData = await pdfParse(buffer);
      texto = String(pdfData.text || "").slice(0, 12000);
    } catch (e) {
      console.error("PDF salvo, mas leitura automática falhou:", e.message);
      texto = "";
    }
  }

  return { texto, buffer, filename, mimeType, sizeBytes: buffer.length };
}


async function buscarCandidatoNaPlanilha(telefone) {
  try {
    if (!CONFIG.VAGAS_URL) return null;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=candidato&telefone=${encodeURIComponent(telefone)}`, { timeout: 15000 });
    return r.data;
  } catch (e) { return null; }
}

function vagaEstaAtiva(vaga) {
  const status = normalizarTexto(campo(vaga, ["status", "Status"]));
  if (!status) return true;
  return !["encerrada","cancelada","inativa","suspensa","fechada","finalizada"].includes(status);
}

async function buscarVagas() {
  try {
    const vagasSheets = [];
    if (CONFIG.VAGAS_URL) {
      const r = await axios.get(CONFIG.VAGAS_URL, { timeout: 15000 });
      if (r.data?.vagas) vagasSheets.push(...r.data.vagas.filter(vagaEstaAtiva));
    }
    return vagasSheets;
  } catch (e) { console.error("Erro buscarVagas:", e.message); return []; }
}

function primeiroNome(nome) { return String(nome || "").trim().split(/\s+/)[0]; }

function ehSaudacaoSimples(mensagem) {
  const texto = normalizarTexto(mensagem).trim();
  return ["oi","ola","olá","bom dia","boa tarde","boa noite","tudo bem","td bem"].includes(texto);
}

function textoDaVaga(vaga) {
  return normalizarTexto([campo(vaga,["idVaga","ID Vaga","ID"]),campo(vaga,["cargo","Cargo","CARGO"]),campo(vaga,["area","Área/Setor","Area/Setor","Área","Area"]),campo(vaga,["cidade","Cidade/Bairro","Cidade","Local"]),campo(vaga,["perfilResumido","Perfil Resumido","Perfil"]),campo(vaga,["palavrasChave","Palavras-chave","Palavras Chave"]),campo(vaga,["requisitosDaVaga","Requisitos da Vaga","Requisitos"]),campo(vaga,["requisitoObrigatorio","Requisito Obrigatório","Requisito Obrigatorio"]),campo(vaga,["observacoes","Observações","Observacoes"]),campo(vaga,["status","Status"])].join(" "));
}

function filtrarVagasRelevantes(vagas, texto, historico) {
  const textoBusca = normalizarTexto(texto + " " + historico.map(h => h.content).join(" "));
  const vagasComScore = vagas.map(vaga => {
    const textoVaga = textoDaVaga(vaga);
    let score = 0;
    textoBusca.split(/\s+/).filter(p => p.length >= 4).slice(0, 100).forEach(p => { if (textoVaga.includes(p)) score++; });
    if (textoBusca.includes("linhares") && textoVaga.includes("linhares")) score += 50;
    if (textoBusca.includes("limpeza") && textoVaga.includes("limpeza")) score += 30;
    if (textoBusca.includes("diaria") && textoVaga.includes("diaria")) score += 30;
    if (textoBusca.includes("servicos gerais") && textoVaga.includes("servicos gerais")) score += 30;
    if (candidatoTemPerfilRH(textoBusca) && isRHVaga(vaga)) score += 80;
    return { vaga, score };
  });
  const filtradas = vagasComScore.filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(i => i.vaga);
  return filtradas.length > 0 ? filtradas : vagas.slice(0, 8);
}

function resumirVagas(vagas) {
  return vagas.map(vaga => ({
    idVaga: campo(vaga,["idVaga","ID Vaga","ID"]),
    cargo: campo(vaga,["cargo","Cargo","CARGO"]),
    area: campo(vaga,["area","Área/Setor","Area/Setor","Área","Area"]),
    cidade: campo(vaga,["cidade","Cidade/Bairro","Cidade","Local"]),
    horario: campo(vaga,["horario","Horário","Escala/Horário","Escala/Horario"]),
    escala: campo(vaga,["escala","Escala","Escala/Horário","Escala/Horario"]),
    salario: campo(vaga,["salario","Salário Base","Salario Base","Salário","Salario"]),
    beneficios: campo(vaga,["beneficios","Benefícios","Beneficios"]),
    escolaridade: campo(vaga,["escolaridade","Escolaridade"]),
    experienciaMinima: campo(vaga,["experienciaMinima","Exp. Mínima","Exp. Minima"]),
    requisitoObrigatorio: campo(vaga,["requisitoObrigatorio","Requisito Obrigatório","Requisito Obrigatorio"]),
    aceitaSemExperiencia: campo(vaga,["aceitaSemExperiencia","Aceita Sem Experiência","Aceita Sem Experiencia"]),
    perfilResumido: campo(vaga,["perfilResumido","Perfil Resumido"]),
    palavrasChave: campo(vaga,["palavrasChave","Palavras-chave","Palavras Chave"]),
    status: campo(vaga,["status","Status"]),
    observacoes: campo(vaga,["observacoes","Observações","Observacoes"])
  }));
}

function montarPromptConversa(sessao, mensagemAtual, vagas) {
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagemAtual, sessao.historico);
  const vagasResumidas = resumirVagas(vagasFiltradas);
  const historicoCurto = sessao.historico.slice(-8).map(h => `${h.role}: ${h.content}`).join("\n");
  const textoConversa = normalizarTexto(mensagemAtual + " " + historicoCurto);
  const ehLinhares = textoConversa.includes("linhares") || textoConversa.includes("shell") || textoConversa.includes("diaria") || textoConversa.includes("diária") || textoConversa.includes("limpeza") || textoConversa.includes("servicos gerais") || textoConversa.includes("serviços gerais");
  const instrucaoCurriculo = ehLinhares ? `REGRA ESPECIAL — LINHARES / DIÁRIA DE LIMPEZA:\n- Colete APENAS: nome, se mora em Linhares, se possui experiência com limpeza ou serviços gerais\n- O currículo é opcional.\n- NÃO peça escolaridade, documentos, disponibilidade de horário ou escala.\n- Informe quando fizer sentido: diária de R$ 250,00, passagem inclusa, alimentação inclusa, local: Bairro Shell, Linhares\n- Após coletar essas informações, diga que a equipe da Effect fará contato para os próximos passos.` : `COLETA PADRÃO:\nColete aos poucos: nome, cidade/bairro, área ou vaga, experiência, escolaridade, disponibilidade e currículo.\nSe o currículo já foi recebido, siga com interesse na vaga, disponibilidade, deslocamento ou próximos passos.`;
  return `Você é a Lia, da Effect Pessoas e Performance.\n\nREGRAS GERAIS:\n- Nunca diga que é robô, IA, chatbot ou assistente virtual.\n- Nunca use menu numérico.\n- Faça somente uma pergunta por vez.\n- Não repita "Eu sou a Lia" se a conversa já começou.\n- Seja humana, acolhedora, organizada, profissional e leve.\n- Seja simpática, mas sem exageros.\n- NÃO diga "que nome lindo", "amei seu nome", "nome bonito" ou qualquer elogio ao nome da pessoa.\n- Use o nome do candidato de forma natural e profissional.\n- Responda curto, como WhatsApp.\n- Se o histórico indicar que o currículo já foi recebido ou analisado, NÃO peça o currículo novamente.\n- Se tiver dúvida, NÃO invente. Responda que vai confirmar com a equipe da Effect.
- Quando apresentar uma vaga ao candidato, use este formato mais completo e nesta ordem: VAGA, Local, Regime, Remuneração e Benefícios, Jornada, Início imediato quando houver, e Requisitos por último.
- Não resuma salário e benefícios quando esses dados estiverem disponíveis nas vagas.\n\nABERTURA:\nSe for o primeiro contato e a pessoa ainda não informou o nome, responda:\n"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"\n\n${instrucaoCurriculo}\n\nVAGAS DISPONÍVEIS:\n${JSON.stringify(vagasResumidas, null, 2)}\n\nHISTÓRICO RECENTE:\n${historicoCurto}\n\nMENSAGEM ATUAL:\n${mensagemAtual}\n\nResponda somente a próxima mensagem da Lia.`;
}

function montarPromptAnaliseEstruturada(textoCurriculo, vagas) {
  const vagasResumidas = resumirVagas(vagas);
  return `Você é a Lia, da Effect Pessoas e Performance.\n\nAnalise o currículo abaixo e compare com as vagas disponíveis.\n\nResponda SOMENTE em JSON válido, sem markdown, sem explicação fora do JSON.\n\nUse exatamente esta estrutura:\n\n{\n  "nome": "",\n  "cidade": "",\n  "areaInteresse": "",\n  "vagaInteresse": "",\n  "idVaga": "",\n  "scoreGeral": 0,\n  "scoreVaga": 0,\n  "classificacao": "",\n  "motivoMatch": "",\n  "status": "",\n  "requisitoObrigatorio": "",\n  "escolaridadeCompativel": "",\n  "experienciaCompativel": "",\n  "anosExperiencia": "",\n  "pontosFortes": "",\n  "pontosAtencao": "",\n  "analiseIA": "",\n  "transporteProprio": "",\n  "cltImediato": "",\n  "observacoes": "",\n  "mensagemCandidato": ""\n}\n\nREGRAS DE CLASSIFICAÇÃO:\n- 90 a 100: Excelente\n- 70 a 89: Bom\n- 50 a 69: Regular\n- abaixo de 50: Reprovado\n- Nunca use Excelente se faltar requisito obrigatório.\n- Não prometa contratação.\n\nFORMATO DA mensagemCandidato:\n😊 Olá, {NOME}!\n\nAnalisei seu currículo e identifiquei uma oportunidade que possui compatibilidade com sua experiência profissional.\n\n📍 {CARGO}\n📍 {CIDADE}\n\nOs principais pontos observados foram:\n\n• {PONTO FORTE 1}\n• {PONTO FORTE 2}\n• {PONTO FORTE 3}\n\nVocê teria interesse em participar deste processo seletivo?\n\nFico à disposição. 💙\n\nREGRAS:\n- Não mostrar score.\n- Não mostrar classificação.\n- Não falar em IA ou análise automática.\n- Não elogiar o nome.\n- Não usar textos longos.\n- Não prometer contratação.\n\nVAGAS:\n${JSON.stringify(vagasResumidas, null, 2)}\n\nCURRÍCULO:\n${textoCurriculo}`;
}

async function chamarClaudeTexto(prompt) { return await chamarClaude(prompt); }

async function chamarClaudeJSON(prompt) {
  const texto = await chamarClaude(prompt);
  try { return JSON.parse(texto); }
  catch (e) {
    const match = texto.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Claude não retornou JSON válido: " + texto);
  }
}

// Versão JSON-only do Gemini — usada exclusivamente para análise de currículo
async function chamarGeminiJSON(prompt) {
  try {
    if (!CONFIG.GEMINI_API_KEY) return null;
    const model = CONFIG.GEMINI_MODEL || "gemini-2.0-flash";
    const { default: axios2 } = await import("axios").catch(() => ({ default: require("axios") }));
    const axiosFn = axios2 || require("axios");
    const response = await axiosFn.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: "application/json" }
      },
      { headers: { "Content-Type": "application/json" }, timeout: 45000 }
    );
    const texto = response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    if (!texto) throw new Error("Gemini retornou resposta vazia");
    try { return JSON.parse(texto); }
    catch (e) {
      const match = texto.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error("GeminiJSON não retornou JSON válido: " + texto.slice(0, 200));
    }
  } catch (e) {
    throw e;
  }
}

// chamarClaude agora:
// - loga o erro REAL (status + corpo da resposta da API), não só um JSON resumido
// - faz 1 retry automático em caso de timeout/erro de rede antes de desistir
// - timeout maior (45s) para reduzir falsos timeouts sob carga
async function chamarGemini(prompt, tentativa = 1) {
  try {
    if (!CONFIG.GEMINI_API_KEY) {
      console.error("chamarGemini: GEMINI_API_KEY não configurada.");
      return FALLBACK_INSTABILIDADE;
    }

    const model = CONFIG.GEMINI_MODEL || "gemini-2.0-flash";
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192
        }
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 45000
      }
    );

    return response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || FALLBACK_INSTABILIDADE;
  } catch (erro) {
    const status = erro.response?.status;
    const corpo = erro.response?.data;
    console.error(`Erro chamarGemini (tentativa ${tentativa}) — status: ${status || "sem status"} — msg: ${erro.message} — corpo: ${JSON.stringify(corpo)}`);

    const corpoTexto = JSON.stringify(corpo || "").toLowerCase();
    const ehRateLimit = status === 429 || corpoTexto.includes("rate") || corpoTexto.includes("quota");
    const ehTimeoutOuRede = !status || erro.code === "ECONNABORTED" || erro.code === "ETIMEDOUT" || erro.code === "ECONNRESET";

    if (ehRateLimit) return FALLBACK_RATE_LIMIT;

    if (ehTimeoutOuRede && tentativa < 2) {
      await sleep(1500);
      return chamarGemini(prompt, tentativa + 1);
    }

    return FALLBACK_INSTABILIDADE;
  }
}

async function chamarClaudeOriginal(prompt, tentativa = 1) {
  try {
    if (!CONFIG.CLAUDE_API_KEY) {
      console.error("chamarClaudeOriginal: CLAUDE_API_KEY não configurada.");
      return FALLBACK_INSTABILIDADE;
    }
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    }, { headers: { "x-api-key": CONFIG.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, timeout: 45000 });
    return response.data?.content?.[0]?.text || FALLBACK_INSTABILIDADE;
  } catch (erro) {
    const status = erro.response?.status;
    const corpo = erro.response?.data;
    console.error(`Erro chamarClaudeOriginal (tentativa ${tentativa}) — status: ${status || "sem status"} — msg: ${erro.message} — corpo: ${JSON.stringify(corpo)}`);

    const ehRateLimit = status === 429 || JSON.stringify(corpo || "").toLowerCase().includes("rate_limit");
    const ehTimeoutOuRede = !status || erro.code === "ECONNABORTED" || erro.code === "ETIMEDOUT" || erro.code === "ECONNRESET";

    if (ehRateLimit) return FALLBACK_RATE_LIMIT;

    if (ehTimeoutOuRede && tentativa < 2) {
      await sleep(1500);
      return chamarClaudeOriginal(prompt, tentativa + 1);
    }

    return FALLBACK_INSTABILIDADE;
  }
}

// Função central de IA.
// Por padrão usa Gemini. Se AI_PROVIDER=claude, usa Claude.
// Se Gemini falhar e houver CLAUDE_API_KEY configurada, tenta Claude como plano B.
async function chamarClaude(prompt, tentativa = 1) {
  const provider = String(CONFIG.AI_PROVIDER || "gemini").toLowerCase().trim();

  if (provider === "claude") {
    return chamarClaudeOriginal(prompt, tentativa);
  }

  const respostaGemini = await chamarGemini(prompt, tentativa);

  if (
    (respostaGemini === FALLBACK_INSTABILIDADE || respostaGemini === FALLBACK_RATE_LIMIT) &&
    CONFIG.CLAUDE_API_KEY
  ) {
    console.error("Gemini falhou. Tentando Claude como fallback temporário.");
    return chamarClaudeOriginal(prompt, tentativa);
  }

  return respostaGemini;
}

async function salvarAnaliseNaPlanilha(telefone, analise) {
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, { acao: "salvarAnalise", telefone, nome: analise.nome || "", cidade: analise.cidade || "", areaInteresse: analise.areaInteresse || "", vagaInteresse: analise.vagaInteresse || "", idVaga: analise.idVaga || "", scoreGeral: analise.scoreGeral || "", scoreVaga: analise.scoreVaga || "", classificacao: analise.classificacao || "", motivoMatch: analise.motivoMatch || "", status: analise.status || "Analisado pela Lia", requisitoObrigatorio: analise.requisitoObrigatorio || "", escolaridadeCompativel: analise.escolaridadeCompativel || "", experienciaCompativel: analise.experienciaCompativel || "", anosExperiencia: analise.anosExperiencia || "", pontosFortes: analise.pontosFortes || "", pontosAtencao: analise.pontosAtencao || "", analiseIA: analise.analiseIA || "", transporteProprio: analise.transporteProprio || "", cltImediato: analise.cltImediato || "", observacoes: analise.observacoes || "", curriculoDriveLink: analise.curriculoDriveLink || "" }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
  } catch (e) { console.error("Erro ao salvar análise:", e.message); }
}

async function confirmarInteresseNaPlanilha(telefone, analise) {
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, { acao: "confirmarInteresse", telefone, vagaInteresse: analise?.vagaInteresse || "", idVaga: analise?.idVaga || "" }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
  } catch (e) { console.error("Erro ao confirmar interesse:", e.message); }
}

function ehConfirmacaoInteresse(mensagem) {
  const texto = normalizarTexto(mensagem);
  return ["sim","tenho interesse","quero","quero participar","aceito","tenho sim","pode ser","tenho disponibilidade","tenho","ok"].some(p => texto === p || texto.includes(p));
}

async function enviarAlertaThiara(analise, telefone) {
  try {
    const score = Number(analise.scoreVaga || analise.scoreGeral || 0);
    const classificacao = String(analise.classificacao || "").toLowerCase();
    if (score < 80 && !classificacao.includes("excelente")) return;
    const destaque = score >= 90 || classificacao.includes("excelente") ? "⭐ CANDIDATO EXCELENTE IDENTIFICADO" : "🚨 NOVO MATCH IDENTIFICADO";
    const texto = `${destaque}\n\n👤 ${analise.nome || "Não identificado"}\n\n📌 Vaga:\n${analise.vagaInteresse || "Não identificada"}\n\n📍 Cidade:\n${analise.cidade || "Não informada"}\n\n⭐ Score: ${analise.scoreVaga || analise.scoreGeral || "Não informado"}\n🏅 Classificação: ${analise.classificacao || "Não informada"}\n\n💼 Pontos fortes:\n${formatarLista(analise.pontosFortes)}\n\n📱 WhatsApp:\n+${telefone}`;
    await enviarMensagem(CONFIG.THIARA_WHATSAPP, texto);
  } catch (e) { console.error("Erro alerta Thiara:", e.message); }
}

async function enviarAlertaInteresseThiara(analise, telefone) {
  try {
    const texto = `✅ CANDIDATO CONFIRMOU INTERESSE\n\n👤 ${analise?.nome || "Não identificado"}\n\n📌 Vaga:\n${analise?.vagaInteresse || "Não identificada"}\n\n📍 Cidade:\n${analise?.cidade || "Não informada"}\n\n⭐ Score: ${analise?.scoreVaga || analise?.scoreGeral || "Não informado"}\n🏅 Classificação: ${analise?.classificacao || "Não informada"}\n\n📱 WhatsApp:\n+${telefone}\n\n✅ O candidato confirmou interesse na oportunidade.`;
    await enviarMensagem(CONFIG.THIARA_WHATSAPP, texto);
  } catch (e) { console.error("Erro alerta interesse:", e.message); }
}

function formatarLista(texto) {
  if (!texto) return "Não informado";
  const partes = String(texto).split(/;|,|\n/).map(p => p.trim()).filter(Boolean).slice(0, 5);
  return partes.length === 0 ? texto : partes.map(p => `• ${p}`).join("\n");
}

async function enviarMensagem(toOriginal, body) {
  const to = limparTelefone(toOriginal);
  try {
    if (!CONFIG.META_ACCESS_TOKEN || !CONFIG.PHONE_NUMBER_ID) return;
    await axios.post(`https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body } }, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 });
  } catch (e) { console.error("Erro ao enviar WhatsApp:", JSON.stringify(e.response?.data || e.message)); }
}

app.listen(PORT, () => {
  console.log(`Lia rodando na porta ${PORT} — modo supervisor + Linhares via planilha ✅`);
});
