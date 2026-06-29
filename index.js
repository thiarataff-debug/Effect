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
const calendar   = require("./calendar");
const supervisor = require("./supervisor");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); if (req.method === "OPTIONS") return res.sendStatus(200); next(); });

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
  DRIVE_ROOT_FOLDER_ID: process.env.DRIVE_ROOT_FOLDER_ID || "18ZHM0HgSsYmgDK84aynw96KNlRYlT6YD",
  DRIVE_SCRIPT_URL: process.env.DRIVE_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbxYrDTUtz01uIEHbCaQwEqHWg--f6oA48RCUFntFOZn2LcqhyZMK6zxIdUGPhBXJPt3GQ/exec",
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

  // Interpola timestampMs em msgs sem hora
  historicoNormalizado.forEach((msg, i) => {
    if (Number(msg.timestampMs) > 0) return;
    let prevMs = 0, nextMs = 0;
    for (let j = i - 1; j >= 0; j--) { if (Number(historicoNormalizado[j].timestampMs) > 0) { prevMs = Number(historicoNormalizado[j].timestampMs); break; } }
    for (let j = i + 1; j < historicoNormalizado.length; j++) { if (Number(historicoNormalizado[j].timestampMs) > 0) { nextMs = Number(historicoNormalizado[j].timestampMs); break; } }
    if (prevMs && nextMs) msg.timestampMs = Math.round((prevMs + nextMs) / 2);
    else if (prevMs)      msg.timestampMs = prevMs + 1;
    else if (nextMs)      msg.timestampMs = nextMs - 1;
    if (msg.timestampMs > 0) msg._approxMs = msg.timestampMs;
  });

  historicoNormalizado.sort((a, b) => Number(a.timestampMs || 0) - Number(b.timestampMs || 0));

  const ultima = historicoNormalizado[historicoNormalizado.length - 1] || null;
  const lastMessageAtMs = ultima?.timestampMs || 0;
  const unreadCount = calcularUnreadSessao(sessao);

  // GERA A HORA NO FUSO CORRETO DE SÃO PAULO IGUAL WHATSAPP
  const horaFormatadaWhatsApp = lastMessageAtMs 
    ? new Date(lastMessageAtMs).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
    : '';

  return {
    historico: historicoNormalizado,
    nome: sessao?.nome || null,
    modo: sessao?.modo || "automatico",
    pausado: sessao?.pausado === true || atendimentosManuais.has(telefone),
    motivoPausa: sessao?.motivoPausa || "",
    aguardandoConfirmacaoInteresse: sessao?.aguardandoConfirmacaoInteresse || false,
    aguardandoDisponibilidade: sessao?.aguardandoDisponibilidade || false,
    preTriagem: sessao?.preTriagem || null,
    miniQuestionario: sessao?.miniQuestionario || null,
    disponibilidadeColetada: sessao?.disponibilidadeColetada || "",
    ultimaAnalise: sessao?.ultimaAnalise || null,
    discResult: sessao?.discResult || null,
    curriculo: sessao?.curriculo ? { filename: sessao.curriculo.filename, mimeType: sessao.curriculo.mimeType || null, sizeBytes: sessao.curriculo.sizeBytes || null, recebidoEm: sessao.curriculo.recebidoEm, recebidoEmMs: sessao.curriculo.recebidoEmMs || 0, recebidoEmFormatado: formatarDataWhatsApp(sessao.curriculo.recebidoEmMs || sessao.curriculo.recebidoEm), driveLink: sessao.curriculo.driveLink || null, pasta: sessao.curriculo.pasta || null, analiseStatus: sessao.curriculo.analiseStatus || 'recebido', local: !!sessao.curriculo.localPath } : null,
    curriculos: normalizarCurriculosParaInbox(sessao),
    lastMessage: ultima?.content || "",
    lastMessageRole: ultima?.role || "",
    lastMessageAt: lastMessageAtMs ? new Date(lastMessageAtMs).toISOString() : "",
    lastMessageAtMs,
    dataWhatsapp: horaFormatadaWhatsApp || formatarDataWhatsApp(lastMessageAtMs), // <--- CORREÇÃO AQUI
    formattedLastMessageAt: horaFormatadaWhatsApp || formatarDataWhatsApp(lastMessageAtMs), // <--- CORREÇÃO AQUI
    unreadCount,
    semResposta: ultima?.role === "user",
    raiox: Array.isArray(sessao?.raiox) ? sessao.raiox.slice(-5) : []
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
  ],
  logistica: [
    "logistica", "logístico", "auxiliar de logistica", "assistente de logistica",
    "operador de logistica", "estoque", "almoxarifado", "expedicao", "expedição",
    "armazem", "armazém", "separacao", "separação", "conferente", "inventario",
    "carga e descarga", "carregamento", "descarga", "empilhadeira", "paletizacao",
    "supply chain", "cadeia de suprimentos", "transportadora", "frota", "deposito"
  ],
  administrativo: [
    "administrativo", "administracao", "administração", "assistente administrativo",
    "auxiliar administrativo", "secretaria", "secretario", "secretária", "recepcao", "recepção",
    "recepcionista", "backoffice", "back office", "suporte administrativo", "rotinas administrativas",
    "digitacao", "digitação", "financeiro", "contas a pagar", "contas a receber",
    "faturamento", "cobranca", "cobrança", "tesouraria", "fiscal", "notas fiscais",
    "sesmt", "seguranca do trabalho", "segurança do trabalho"
  ],
  operacional: [
    "operacional", "operacoes", "operações", "producao", "produção", "operador",
    "auxiliar de producao", "auxiliar de produção", "linha de producao", "linha de produção",
    "montagem", "embalagem", "qualidade", "controle de qualidade", "manutencao", "manutenção",
    "tecnico", "técnico", "operador de maquina", "operador de máquina"
  ],
  projetos: [
    "projetos", "assistente de projetos", "analista de projetos", "gerente de projetos",
    "pmo", "engenharia", "engenheiro", "engenheira", "vistoriador", "instalacao", "instalação",
    "obras", "construcao", "construção"
  ],
  alimentos: [
    "garcom", "garçom", "garconete", "garçonete", "barman", "bartender",
    "cozinha", "cozinheiro", "cozinheira", "auxiliar de cozinha", "ajudante de cozinha",
    "pizzaiolo", "churrasco", "chefe de cozinha", "sous chef", "confeiteiro", "confeitaria",
    "atendente de restaurante", "atendente de bar", "restaurante", "buffet", "lanchonete",
    "padeiro", "panificacao", "panificação"
  ],
  limpeza: [
    "limpeza", "servicos gerais", "serviços gerais", "faxina", "faxineira", "faxineiro",
    "zelador", "zeladora", "auxiliar de limpeza", "copeira", "copeiro",
    "lavanderia", "higienizacao", "higienização", "portaria", "porteiro", "diaria", "diária"
  ],
  vendas: [
    "vendas", "vendedor", "vendedora", "comercial", "representante", "consultor de vendas",
    "atendimento ao cliente", "atendente", "balconista", "caixa", "promotor", "promotora",
    "televendas", "telemarketing", "call center", "sdr"
  ]
};

function contemSinonimoArea(texto = "", area) {
  const clean = normalizarTexto(texto);
  return (AREA_SYNONYMS[area] || []).some(term => clean.includes(normalizarTexto(term)));
}

function contemSinonimoRH(texto = "") {
  return contemSinonimoArea(texto, "rh");
}

function textoDaVagaParaArea(vaga) {
  return normalizarTexto([
    campo(vaga, ["cargo", "Cargo", "CARGO"]),
    campo(vaga, ["area", "Área/Setor", "Area/Setor", "Área", "Area"]),
    campo(vaga, ["perfilResumido", "Perfil Resumido", "Perfil"]),
    campo(vaga, ["palavrasChave", "Palavras-chave", "Palavras Chave"]),
    campo(vaga, ["requisitosDaVaga", "Requisitos da Vaga", "Requisitos"]),
    campo(vaga, ["observacoes", "Observações", "Observacoes"])
  ].join(" "));
}

function isVagaDaArea(vaga, area) {
  return contemSinonimoArea(textoDaVagaParaArea(vaga), area);
}

function isRHVaga(vaga) {
  return isVagaDaArea(vaga, "rh");
}

function candidatoTemPerfilArea(texto = "", area) {
  return contemSinonimoArea(texto, area);
}

function candidatoTemPerfilRH(texto = "") {
  return candidatoTemPerfilArea(texto, "rh");
}

function buscarVagaDaArea(vagas = [], area) {
  return vagas.find(v => vagaEstaAtiva(v) && isVagaDaArea(v, area));
}

function buscarVagaRH(vagas = []) {
  return buscarVagaDaArea(vagas, "rh");
}

function detectarAreaCandidato(texto = "") {
  const areas = ["logistica", "administrativo", "operacional", "projetos", "alimentos", "limpeza", "vendas", "rh"];
  return areas.find(area => candidatoTemPerfilArea(texto, area)) || null;
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
  const nomeFinal = `${telefone}_${filename}`.replace(/[\/:*?"<>|]/g, "-");

  // ── MÉTODO 1: Service Account direto (mesmo mecanismo dos backups) ──────────
  try {
    const drive = getDriveClient();
    if (drive) {
      const pastaId = await obterOuCriarPastaCargo(drive, cargo || "Currículos Recebidos");
      const { Readable } = require("stream");
      const file = await drive.files.create({
        requestBody: {
          name: nomeFinal,
          parents: [pastaId],
          mimeType: mimeType || "application/octet-stream"
        },
        media: {
          mimeType: mimeType || "application/octet-stream",
          body: Readable.from(buffer)
        },
        fields: "id, webViewLink",
        supportsAllDrives: true
      });
      if (file.data?.id) {
        // Torna o arquivo acessível para qualquer pessoa com o link
        await drive.permissions.create({
          fileId: file.data.id,
          requestBody: { role: "reader", type: "anyone" },
          supportsAllDrives: true
        }).catch(e => console.warn("uploadCurriculoDrive: permissão pública não aplicada:", e.message));
        const link = file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`;
        console.log(`✅ CV NO DRIVE via Service Account: ${telefone} | ${link}`);
        return { link, fileId: file.data.id, pasta: cargo };
      }
    }
  } catch (e) {
    console.error(`uploadCurriculoDrive Service Account falhou: ${e.message} — tentando Apps Script...`);
  }

  // ── MÉTODO 2: Apps Script (fallback) ─────────────────────────────────────────
  const scriptUrl = CONFIG.DRIVE_SCRIPT_URL;
  if (!scriptUrl) { console.error("DRIVE_SCRIPT_URL não configurado"); return null; }
  const base64 = buffer.toString("base64");

  for (let tent = 1; tent <= 3; tent++) {
    try {
      const r = await axios.post(scriptUrl, {
        base64,
        filename: nomeFinal,
        mimeType: mimeType || "application/octet-stream",
        folderId: CONFIG.DRIVE_ROOT_FOLDER_ID,
        subfolder: cargo || "Currículos Recebidos"
      }, { timeout: 30000 });

      if (r.data?.ok && r.data?.link) {
        console.log(`✅ CV NO DRIVE via Apps Script (tent ${tent}): ${telefone} | ${r.data.link}`);
        return { link: r.data.link, fileId: r.data.id, pasta: cargo };
      }
      console.error(`Drive Script tentativa ${tent}: resposta sem link —`, r.data);
    } catch (e) {
      console.error(`Drive Script tentativa ${tent} falhou: ${e.message}`);
      if (tent < 3) await new Promise(res => setTimeout(res, 2000 * tent));
    }
  }

  console.error(`⚠️ CV NÃO SALVO NO DRIVE após todas as tentativas — ${telefone} | ${filename}`);
  return null;
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
    const payload = JSON.stringify({ acao: "salvarConversaCompleta", telefone, nome: nome || "", historico: historico || [], modo: sessaoAtualSheets.modo || "automatico", pausado: sessaoAtualSheets.pausado || false, motivoPausa: sessaoAtualSheets.motivoPausa || "", unreadCount: Number(sessaoAtualSheets.unreadCount || 0), curriculos: curriculosMeta, curriculo: curriculosMeta[0] || null, discResult: sessaoAtualSheets.discResult || null, timestamp: agora(), timestampISO: agoraISO(), timestampMs: Date.now() });
    await axios.post(urlBase, payload, { headers: { "Content-Type": "text/plain" }, timeout: 30000, maxRedirects: 5 });
  } catch (e) {
    console.error("Erro salvarConversaCompletaSheets:", e.message);
  }
}

async function restaurarDoUltimoBackup() {
  try {
    const resp = await fetch(`${CONFIG.VAGAS_URL}?acao=ultimoBackup`);
    if (!resp.ok) return false;
    const backup = await resp.json();
    if (!backup.sessoes) return false;
    let restauradas = 0;
    Object.entries(backup.sessoes).forEach(([tel, s]) => {
      if (!sessoes[tel] && s.historico?.length) {
        sessoes[tel] = {
          historico: (s.historico || []).map(normalizarEventoHistorico),
          nome: s.nome || null,
          modo: "automatico",
          pausado: false,
          motivoPausa: "",
          unreadCount: 0,
          curriculos: [],
          curriculo: null,
          ultimaAnalise: s.ultimaAnalise || null,
          discResult: s.discResult || null
        };
        restauradas++;
      }
    });
    console.log(`✅ Restauradas ${restauradas} sessões do backup`);
    return restauradas > 0;
  } catch(e) {
    console.error("Erro restaurarDoUltimoBackup:", e.message);
    return false;
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

      // Normaliza histórico e injeta timestamps estáveis nas msgs sem hora
      const historicoNorm = Array.isArray(sessao.historico)
        ? sessao.historico.map(normalizarEventoHistorico).filter(h => h && h.content !== undefined)
        : [];

      // Âncora estável: usa o timestampMs salvo na sessão do Sheets (nunca Date.now())
      // Assim o horário aproximado não muda a cada refresh
      const ancoraSessaoMs = Number(sessao.timestampMs || sessao.lastMessageAtMs || 0);
      let ancoraMs = ancoraSessaoMs;
      if (!ancoraMs) {
        // Procura a última msg com timestamp real como âncora
        for (let i = historicoNorm.length - 1; i >= 0; i--) {
          const ms = Number(historicoNorm[i].timestampMs || 0);
          if (ms > 0) { ancoraMs = ms; break; }
        }
      }
      if (ancoraMs > 0) {
        // Injeta _approxMs estável nas msgs sem timestamp, trabalhando de trás pra frente
        for (let i = historicoNorm.length - 1; i >= 0; i--) {
          if (!Number(historicoNorm[i].timestampMs)) {
            historicoNorm[i].timestampMs = ancoraMs - (historicoNorm.length - 1 - i) * 90000;
            historicoNorm[i]._approxMs = historicoNorm[i].timestampMs;
          }
        }
      }

      sessoes[tel] = {
        historico: historicoNorm,
        nome: sessao.nome || null,
        modo,
        pausado,
        motivoPausa,
        unreadCount: Number(sessao.unreadCount || 0),
        curriculos: curriculosMesclados,
        curriculo: curriculosMesclados[0] || existente.curriculo || null,
        ultimaAnalise: existente.ultimaAnalise || sessao.ultimaAnalise || null,
        statusProcesso: existente.statusProcesso || sessao.statusProcesso || "Novo",
        discResult: existente.discResult || sessao.discResult || null
      };

      if (pausado) atendimentosManuais.add(tel);
      else atendimentosManuais.delete(tel);
    });

    console.log(`Sessões carregadas do Sheets: ${Object.keys(data.sessoes).length}`);
  } catch (e) {
    console.error("Erro carregarSessoesDoSheets:", e.message);
  }
}

carregarSessoesDoSheets().then(async () => {
  const total = Object.keys(sessoes).length;
  console.log(`Sessões carregadas: ${total}`);
  if (total < 10) {
    console.log("Poucas sessões — tentando restaurar do backup Drive...");
    await restaurarDoUltimoBackup();
  }
  setTimeout(() => fazerBackup("startup"), 10 * 1000);
}).catch(e => console.error("Erro na inicialização:", e.message));
setInterval(() => fazerBackup("diario"), 2 * 60 * 60 * 1000);

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
// BACKUP AUTOMÁTICO (DIÁRIO + SEMANAL) → Google Drive
// ============================================================

let ultimoBackupDiario = null;
let ultimoBackupSemanal = null;

async function fazerBackup(tipo) {
  try {
    const sessoesCompactas = {};
    Object.entries(sessoes).forEach(([tel, s]) => {
      sessoesCompactas[tel] = {
        nome: s.nome,
        modo: s.modo,
        pausado: s.pausado,
        motivoPausa: s.motivoPausa,
        discResult: s.discResult,
        ultimaAnalise: s.ultimaAnalise,
        historico: (s.historico || []).slice(-20)
      };
    });
    const dados = { timestamp: new Date().toISOString(), motivo: tipo, sessoes: sessoesCompactas };
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(CONFIG.VAGAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acao: "salvarBackup", dados }),
      signal: controller.signal
    });
    clearTimeout(tid);
    const json = await resp.json();
    if (json.sucesso) {
      console.log(`✅ backup ${tipo} salvo: ${json.arquivo}`);
    } else {
      console.error(`Erro backup ${tipo}:`, json.erro);
    }
  } catch(e) {
    console.error(`Erro backup ${tipo}:`, e.message);
  }
}

// Backup diário — executa a cada 24h
setInterval(() => fazerBackup("diario"), 2 * 60 * 60 * 1000);

// Backup semanal — executa a cada 7 dias
setInterval(() => fazerBackup("semanal"), 7 * 24 * 60 * 60 * 1000);

// Backup a cada 2 horas
// removido — substituído pelo intervalo de 2h acima

// ── Rota: iniciar mini-questionário manualmente pelo Inbox ─────────────────
app.post("/inbox/iniciar-questionario", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    if (!telefone) return res.status(400).json({ ok: false, erro: "telefone obrigatório" });
    const sessao = garantirSessao(telefone);
    sessao.miniQuestionario = { ativo: true, indice: 0, respostas: {}, concluido: false };
    sessao.pausado = false; sessao.modo = "automatico";
    atendimentosManuais.delete(telefone);
    const nmInicio = primeiroNome(sessao.nome || "");
    const msgQ = `Sem problema${nmInicio ? ", " + nmInicio : ""}! 😊 Vou fazer algumas perguntas rápidas para registrar seu perfil.\n\n${MINI_QUESTIONARIO_PERGUNTAS[0].pergunta}`;
    await enviarMensagem(telefone, msgQ);
    registrarEntradaSessao(sessao, "assistant", msgQ);
    await salvarMensagemSheets(telefone, "assistant", msgQ, sessao.nome);
    res.json({ ok: true, mensagem: "Mini-questionário iniciado" });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Endpoint para backup manual via Inbox
app.post("/inbox/backup", async (req, res) => {
  const ok = await fazerBackup("manual");
  return res.json({
    ok,
    ultimoBackupDiario: ultimoBackupDiario?.toISOString() || null,
    ultimoBackupSemanal: ultimoBackupSemanal?.toISOString() || null
  });
});

// Endpoint de status do backup
app.get("/inbox/backup/status", (req, res) => {
  res.json({
    ok: true,
    ultimoBackupDiario: ultimoBackupDiario?.toISOString() || null,
    ultimoBackupSemanal: ultimoBackupSemanal?.toISOString() || null,
    totalSessoes: Object.keys(sessoes).length
  });
});

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
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/sheets", (req, res) => res.sendFile(path.join(__dirname, "sheets-viewer.html")));
app.get("/inbox", (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, "inbox.html"), "utf8");
    // Injeta função toast caso não esteja definida no HTML
    const toastFn = `<script>
if(typeof toast !== 'function'){
  window.toast = function toast(msg,tipo){
    const t=document.getElementById('toast');
    if(!t)return;
    t.textContent=msg;
    t.className='toast show '+(tipo||'');
    clearTimeout(t._hideTimer);
    t._hideTimer=setTimeout(()=>{t.className='toast';},3500);
  };
}
</script>`;
    html = html.replace('</head>', toastFn + '</head>');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname, "inbox.html"));
  }
});


// ─── ENVIAR DISC (sem ativar modo manual) ───
app.post("/inbox/enviar-disc", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || '');
    const mensagem = req.body.mensagem || '';
    if (!telefone || !mensagem) return res.json({ ok: false, erro: "Dados incompletos" });
    const sessao = garantirSessao(telefone);
    await enviarMensagem(telefone, mensagem);
    registrarEntradaSessao(sessao, "assistant", mensagem);
    await salvarMensagemSheets(telefone, "assistant", mensagem, sessao.nome || "");
    return res.json({ ok: true });
  } catch (e) {
    console.error('Erro /inbox/enviar-disc:', e.message);
    return res.json({ ok: false, erro: e.message });
  }
});

// ─── DISC ASSESSMENT ───
app.get("/disc/:telefone", (req, res) => res.sendFile(path.join(__dirname, "disc.html")));

app.post("/disc/submit", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || '');
    const nome = String(req.body.nome || '').trim();
    const vaga = String(req.body.vaga || '').trim();
    const percentuaisNatural = req.body.percentuaisNatural || {};
    const percentuaisAdaptado = req.body.percentuaisAdaptado || {};
    const primarioNatural = req.body.primarioNatural || '';
    const primarioAdaptado = req.body.primarioAdaptado || '';
    const secundarioNatural = req.body.secundarioNatural || null;
    const relatorioRH = req.body.relatorioRH || null;

    const resultado = {
      respondidoEm: new Date().toISOString(),
      nome, vaga,
      percentuaisNatural,
      percentuaisAdaptado,
      primario: primarioNatural,          // compatibilidade com inbox
      primarioNatural,
      primarioAdaptado,
      secundario: secundarioNatural,
      secundarioNatural,
      relatorioRH
    };

    if (telefone && sessoes[telefone]) {
      sessoes[telefone].discResult = resultado;
      if (nome && !sessoes[telefone].nome) sessoes[telefone].nome = nome;
    }

    await salvarDiscNoDrive(telefone, nome, resultado).catch(e => console.error('Erro DISC Drive:', e.message));

    // Notificar candidato que o DISC foi recebido
    if (telefone) {
      const nomeFirst = (nome || 'Candidato').split(' ')[0];
      const perfisDesc = { D: 'Dominante', I: 'Influente', S: 'Estável', C: 'Criterioso' };
      const descPrimario = perfisDesc[resultado.primario] || resultado.primario || '';
      const msgConfirm = `✅ ${nomeFirst}, recebemos seu questionário DISC!\n\nSeu perfil predominante é *${resultado.primario}${descPrimario ? ' — ' + descPrimario : ''}*. Nossa equipe irá considerar essas informações na avaliação do seu perfil. 💙`;
      enviarMensagem(telefone, msgConfirm).catch(e => console.error('Erro ao notificar DISC:', e.message));
      // Salvar no Sheets
      if (sessoes[telefone]) {
        salvarConversaCompletaSheets(telefone, sessoes[telefone].historico, sessoes[telefone].nome || nome || '').catch(()=>{});
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Erro /disc/submit:', e.message);
    return res.json({ ok: false, erro: e.message });
  }
});

app.get("/disc/resultado/:telefone", (req, res) => {
  const tel = limparTelefone(req.params.telefone);
  const sessao = sessoes[tel];
  if (!sessao?.discResult) return res.json({ ok: false });
  return res.json({ ok: true, resultado: sessao.discResult });
});

// Relatório visual completo (abre em nova aba pelo inbox)
app.get("/disc/resultado-view/:telefone", (req, res) => {
  const tel = limparTelefone(req.params.telefone);
  const sessao = sessoes[tel];
  if (!sessao?.discResult) return res.send('<h3>Sem resultado DISC para este candidato.</h3>');
  const d = sessao.discResult;
  const rh = d.relatorioRH || null;
  const nome = d.nome || sessao.nome || tel;
  const CORES = {D:'#dc2626',I:'#d97706',S:'#16a34a',C:'#2563eb'};
  const NOMES = {D:'Dominante',I:'Influente',S:'Estável',C:'Criterioso'};
  const EMOJIS = {D:'🔴',I:'🟡',S:'🟢',C:'🔵'};
  const pctN = d.percentuaisNatural || d.percentuais || {};
  const pctA = d.percentuaisAdaptado || {};
  const data = new Date(d.respondidoEm||Date.now()).toLocaleDateString('pt-BR');

  function barras(pct) {
    return ['D','I','S','C'].map(k=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="font-size:11px;font-weight:800;color:${CORES[k]};width:12px">${k}</div>
      <div style="flex:1;background:#e8ecf1;border-radius:999px;height:11px;overflow:hidden">
        <div style="width:${pct[k]||0}%;height:100%;background:${CORES[k]};border-radius:999px"></div></div>
      <div style="font-size:11px;font-weight:700;color:#6b7280;width:28px;text-align:right">${pct[k]||0}%</div>
    </div>`).join('');
  }

  function lista(arr, cor='#374151') {
    if (!arr||!arr.length) return '<p style="color:#a1a1aa;font-size:12px">—</p>';
    return arr.map(i=>`<div style="display:flex;gap:8px;margin-bottom:5px"><span style="color:${cor};font-size:13px">•</span><span style="font-size:12.5px;color:#374151;line-height:1.5">${i}</span></div>`).join('');
  }

  function sec(titulo) {
    return `<div style="font-size:10px;font-weight:800;color:#a1a1aa;text-transform:uppercase;letter-spacing:.07em;margin:18px 0 8px">${titulo}</div>`;
  }

  const matchBloco = rh?.match ? (() => {
    const m = rh.match;
    const cor = m.score >= 70 ? '#16a34a' : m.score >= 45 ? '#d97706' : '#dc2626';
    const emoji = m.score >= 70 ? '✅' : m.score >= 45 ? '⚠️' : '❌';
    return `<div style="background:#f0fdf4;border:1.5px solid ${cor};border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div style="font-size:28px;font-weight:800;color:${cor}">${m.score}%</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:${cor}">${emoji} ${m.nivel} para a vaga</div>
          <div style="font-size:11px;color:#6b7280">${rh.vaga||'vaga não especificada'}</div>
        </div>
      </div>
      ${m.insights&&m.insights.length?m.insights.map(i=>`<div style="font-size:12px;color:#374151;margin-bottom:4px">• ${i}</div>`).join(''):''}
    </div>`;
  })() : '';

  const tensaoBloco = rh?.tensaoAlerta?.length ? `
    <div style="background:#fff7ed;border:1.5px solid #f59e0b;border-radius:12px;padding:14px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:800;color:#b45309;margin-bottom:8px">⚠️ TENSÃO DE ADAPTAÇÃO</div>
      ${rh.tensaoAlerta.map(t=>`<div style="font-size:12px;color:#374151;margin-bottom:6px;line-height:1.5">• ${t}</div>`).join('')}
    </div>` : '';

  const comboBloco = rh?.combo ? `
    <div style="background:#eff6ff;border-radius:12px;padding:14px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:800;color:#1d4ed8;margin-bottom:6px">🔗 COMBINAÇÃO DE PERFIL</div>
      <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.combo}</p>
    </div>` : '';

  const rhBloco = rh ? `
    <div class="card">
      <div style="font-size:13px;font-weight:800;color:#1e3a5f;margin-bottom:14px">📋 ANÁLISE PARA SELEÇÃO</div>
      ${sec('Resumo do perfil')}
      <p style="font-size:12.5px;color:#374151;line-height:1.6;margin-bottom:8px">${rh.resumoRH||''}</p>

      ${sec('Ambientes com fit')}
      ${lista(rh.ambientesFit,'#16a34a')}

      ${sec('Ambientes de risco')}
      ${lista(rh.ambientesRisco,'#dc2626')}

      ${sec('Liderança ideal')}
      <p style="font-size:12.5px;color:#374151;line-height:1.5;margin-bottom:6px">${rh.liderancaFit||''}</p>
      ${rh.liderancaRisco?`<p style="font-size:12px;color:#b45309;line-height:1.5">⚠️ ${rh.liderancaRisco}</p>`:''}

      ${sec('Conflito')}
      <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.conflito||''}</p>

      ${sec('Motivação')}
      <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.motivacao||''}</p>

      ${sec('Retenção')}
      <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.retencao||''}</p>

      ${sec('Autonomia')}
      <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.autonomia||''}</p>
    </div>

    <div class="card">
      <div style="font-size:13px;font-weight:800;color:#16a34a;margin-bottom:12px">✅ Sinais positivos na entrevista</div>
      ${lista(rh.sinaisVerde,'#16a34a')}
    </div>

    <div class="card">
      <div style="font-size:13px;font-weight:800;color:#dc2626;margin-bottom:12px">⚠️ Pontos de atenção</div>
      ${lista(rh.alertas,'#dc2626')}
    </div>

    <div class="card">
      <div style="font-size:13px;font-weight:800;color:#1e3a5f;margin-bottom:12px">❓ Perguntas sugeridas para entrevista</div>
      ${(rh.perguntasEntrevista||[]).map((p,i)=>`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:800;color:#a1a1aa;margin-bottom:3px">PERGUNTA ${i+1}</div><p style="font-size:12.5px;color:#374151;line-height:1.5">${p}</p></div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>DISC RH — ${nome}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Montserrat',sans-serif;background:#f5f7fa;padding:24px 16px;max-width:680px;margin:0 auto}
    .card{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 1px 5px rgba(0,0,0,.08);margin-bottom:14px}
    .logo{font-size:14px;font-weight:800;color:#2a2a2b;margin-bottom:18px}.logo span{color:#8ed1b2}
    @media print{body{background:#fff;padding:10px}.card{box-shadow:none;border:1px solid #e5e7eb;break-inside:avoid}}
  </style></head><body>
  <div class="logo">Effect <span>Pessoas</span> · Relatório de Seleção</div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <div>
        <div style="font-size:18px;font-weight:800;color:#2a2a2b">${EMOJIS[d.primarioNatural||d.primario]||''} ${nome}</div>
        <div style="font-size:12px;color:#a1a1aa;margin-top:2px">${data} · ${d.vaga||'Vaga não informada'}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:700;color:${CORES[d.primarioNatural||d.primario]||'#374151'}">${NOMES[d.primarioNatural||d.primario]||''}${d.secundarioNatural?' / '+NOMES[d.secundarioNatural]:''}</div>
        <div style="font-size:11px;color:#a1a1aa">Perfil predominante</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:10px;font-weight:800;color:#a1a1aa;margin-bottom:8px">PERFIL NATURAL</div>
        ${barras(pctN)}
      </div>
      <div>
        <div style="font-size:10px;font-weight:800;color:#a1a1aa;margin-bottom:8px">PERFIL ADAPTADO${d.referencia?' ('+d.referencia+')':''}</div>
        ${barras(pctA)}
      </div>
    </div>
  </div>

  ${matchBloco}
  ${tensaoBloco}
  ${comboBloco}
  ${rhBloco}

  <button onclick="window.print()" style="background:#2a2a2b;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:24px;width:100%">🖨️ Imprimir / Salvar PDF</button>
  </body></html>`;
  res.send(html);
});

async function salvarDiscNoDrive(telefone, nome, resultado) {
  const drive = getDriveClient();
  if (!drive) return;

  // Garante pasta DISC-Resultados
  const q = `'${CONFIG.DRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='DISC-Resultados' and trashed=false`;
  const busca = await drive.files.list({ q, fields: 'files(id)' });
  let folderId;
  if (busca.data.files?.length) {
    folderId = busca.data.files[0].id;
  } else {
    const nova = await drive.files.create({
      requestBody: { name: 'DISC-Resultados', mimeType: 'application/vnd.google-apps.folder', parents: [CONFIG.DRIVE_ROOT_FOLDER_ID] },
      fields: 'id'
    });
    folderId = nova.data.id;
  }

  const { Readable } = require('stream');
  const ts = new Date().toISOString().slice(0, 10);
  const nomeArq = `DISC-${(nome||telefone).replace(/\s+/g,'-')}-${telefone}-${ts}.json`;
  const conteudo = JSON.stringify({ telefone, nome, ...resultado }, null, 2);

  await drive.files.create({
    requestBody: { name: nomeArq, parents: [folderId], mimeType: 'application/json' },
    media: { mimeType: 'application/json', body: Readable.from(Buffer.from(conteudo, 'utf8')) },
    fields: 'id'
  });
  console.log(`✅ DISC salvo no Drive: ${nomeArq}`);
}
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

// ─── RESUMIR CONVERSA com IA ───
app.post("/inbox/resumir", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });
    const sessao = garantirSessao(telefone);
    const hist = sessao.historico || [];
    if (!hist.length) return res.json({ ok: false, erro: "Sem histórico para resumir" });

    const ultimas = hist.slice(-30);
    const transcript = ultimas.map(h => `${h.role === 'user' ? 'Candidato' : 'Lia'}: ${h.content || ''}`).join('\n');

    const prompt = `Você é um assistente de RH. Com base no histórico de conversa abaixo, forneça um resumo estruturado e objetivo.

HISTÓRICO:
${transcript}

Responda EXATAMENTE neste formato (sem markdown, sem asteriscos):
Nome: [nome do candidato ou "não identificado"]
Cidade/Bairro: [cidade e/ou bairro mencionado ou "não informado"]
Vaga de interesse: [cargo ou vaga ou "não mencionado"]
Experiência: [resumo breve da experiência ou "não informado"]
Pendências: [o que ainda falta coletar ou confirmar — seja específico]
Próxima ação: [o que deve ser feito a seguir — ex: "Agendar entrevista", "Aguardar envio de currículo", "Analisar perfil"]`;

    const resumo = await chamarGeminiJSON(prompt).catch(() => chamarGemini(prompt));
    if (!resumo) return res.json({ ok: false, erro: "IA não retornou resposta" });

    const texto = typeof resumo === 'string' ? resumo : JSON.stringify(resumo, null, 2);
    return res.json({ ok: true, resumo: texto });
  } catch (erro) {
    console.error("Erro /inbox/resumir:", erro.message);
    return res.json({ ok: false, erro: erro.message });
  }
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

app.get("/inbox/curriculo/:telefone", async (req, res) => {
  try {
    const tel = limparTelefone(req.params.telefone);
    let sessao = sessoes[tel];

    // Se sessão não existe ou não tem currículo, tenta recarregar do Sheets
    let lista = sessao
      ? (Array.isArray(sessao.curriculos) && sessao.curriculos.length ? sessao.curriculos : (sessao.curriculo ? [sessao.curriculo] : []))
      : [];

    if (!lista.length && CONFIG.VAGAS_URL) {
      try {
        const urlBase = CONFIG.VAGAS_URL.split("?")[0];
        const r = await axios.get(`${urlBase}?acao=conversas&telefone=${tel}`, { timeout: 8000, maxRedirects: 3 });
        const d = r.data;
        if (d?.sessoes) {
          const telKey = Object.keys(d.sessoes).find(k => limparTelefone(k) === tel);
          if (telKey) {
            const s = d.sessoes[telKey];
            const cvs = Array.isArray(s.curriculos) ? s.curriculos : (s.curriculo ? [s.curriculo] : []);
            if (cvs.length) {
              // Salva de volta na sessão em memória
              if (!sessoes[tel]) sessoes[tel] = { historico: [], nome: s.nome || null, modo: "automatico", pausado: false, motivoPausa: "", unreadCount: 0, curriculos: [], curriculo: null, ultimaAnalise: null };
              sessoes[tel].curriculos = cvs;
              sessoes[tel].curriculo = cvs[0];
              sessao = sessoes[tel];
              lista = cvs;
            }
          }
        }
      } catch (e) { console.error("Fallback Sheets curriculo:", e.message); }
    }

    if (!lista.length) {
      const nomeCandidato = sessao?.nome || tel;
      const nomeArquivo = sessao?.curriculo?.filename || '';
      const termoBusca = nomeCandidato !== tel ? nomeCandidato : nomeArquivo || nomeCandidato;
      const driveSearchLink = `https://drive.google.com/drive/search?q=${encodeURIComponent(termoBusca)}`;
      return res.status(404).send(`
        <html><head><style>
          body{font-family:sans-serif;padding:32px;max-width:520px;color:#1e293b}
          .nome-box{display:flex;align-items:center;gap:8px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;padding:10px 14px;margin:12px 0}
          .nome-text{font-size:15px;font-weight:700;flex:1}
          .copy-btn{background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;white-space:nowrap}
          .copy-btn:active{opacity:.8}
          a{color:#2563eb}
        </style></head>
        <body>
        <h3>📄 Currículo não disponível</h3>
        <p>O arquivo de <strong>${nomeCandidato}</strong> não foi encontrado após reinicialização do servidor.</p>
        <p><strong>Copie o nome e busque no Drive:</strong></p>
        <div class="nome-box">
          <span class="nome-text" id="nome">${termoBusca}</span>
          <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('nome').textContent).then(()=>{this.textContent='✓ Copiado!';setTimeout(()=>this.textContent='Copiar',1500)})">Copiar</button>
        </div>
        <p><a href="${driveSearchLink}" target="_blank">🔍 Tentar abrir Drive com busca</a></p>
        <p style="margin-top:16px"><a href="/inbox/curriculo/${tel}/pedir-reenvio" style="color:#e53e3e">📩 Pedir reenvio ao candidato via WhatsApp</a></p>
        </body></html>`);
    }

    const idx = Math.max(0, Math.min(Number(req.query.idx || 0), lista.length - 1));
    const cv = lista[idx];

    // Se tem driveLink, redireciona diretamente para o Drive
    if (cv?.driveLink) return res.redirect(cv.driveLink);

    let buffer = null;
    if (cv?.base64) buffer = Buffer.from(cv.base64, "base64");
    else if (cv?.localPath && fs.existsSync(cv.localPath)) buffer = fs.readFileSync(cv.localPath);

    if (!buffer) {
      // Arquivo local sumiu (reinício do Railway) — tenta driveLink da análise
      const dlFallback = sessao?.ultimaAnalise?.curriculoDriveLink || sessao?.ultimaAnalise?.linkCurriculo || "";
      if (dlFallback) return res.redirect(dlFallback);
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;padding:32px">
        <h3>📄 Arquivo indisponível</h3>
        <p>O arquivo do currículo foi apagado após reinicialização do servidor (armazenamento temporário).</p>
        <p>Acesse o <strong>Google Drive</strong> para encontrar o currículo salvo, ou solicite reenvio pelo WhatsApp.</p>
        </body></html>`);
    }

    const inline = req.query.inline === "1" || req.query.inline === "true";
    res.set("Content-Type", cv.mimeType || "application/octet-stream");
    res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${cv.filename || "curriculo"}"`);
    res.send(buffer);
  } catch (erro) {
    console.error("Erro /inbox/curriculo:", erro.message);
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
    sessao.statusProcesso = status || sessao.statusProcesso || "Novo";
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

    let erroEnvio = null;
    if (enviar && mensagem) {
      try {
        await enviarMensagem(telefone, mensagem);
        registrarEntradaSessao(sessao, "assistant", mensagem);
        marcarConversaRespondida(sessao);
        await salvarMensagemSheets(telefone, "assistant", mensagem, sessao.nome || sessao.ultimaAnalise?.nome || "");
      } catch (eMensagem) {
        erroEnvio = eMensagem.message; // status salvo, mas mensagem não enviada
        console.error("Falha ao enviar mensagem no /inbox/status:", erroEnvio);
      }
    }

    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || sessao.ultimaAnalise?.nome || "");

    // Banco de Talentos: registra em aba dedicada no Sheets
    if (status === "Banco de Talentos" && CONFIG.VAGAS_URL) {
      try {
        const urlBase = CONFIG.VAGAS_URL.split("?")[0];
        await axios.post(urlBase, {
          acao: "bancoTalentos",
          telefone,
          nome: sessao.nome || sessao.ultimaAnalise?.nome || "",
          cargo: sessao.ultimaAnalise?.vagaInteresse || sessao.vagaInteresse || "",
          cidade: sessao.ultimaAnalise?.cidade || sessao.cidade || "",
          driveLink: sessao.curriculo?.driveLink || sessao.ultimaAnalise?.curriculoDriveLink || "",
          perfilResumido: sessao.ultimaAnalise?.perfilResumido || sessao.ultimaAnalise?.motivoMatch || "",
          discPrimario: sessao.discResult?.primario || "",
          dataEntrada: new Date().toLocaleDateString("pt-BR"),
          timestampMs: Date.now()
        }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
        console.log(`Banco de Talentos: ${telefone} (${sessao.nome || ""})`);
      } catch (e) { console.error("Erro bancoTalentos Sheets:", e.message); }
    }

    return res.json({ ok: true, telefone, status: sessao.statusProcesso, prioritario, erroEnvio: erroEnvio || null });
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

app.post("/inbox/transicao-lia", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone);
    if (!telefone) return res.json({ ok: false });
    const msg = "Olá! 😊 Lia está de volta para continuar te acompanhando. Pode falar! 💙";
    await enviarMensagem(telefone, msg);
    const sessao = garantirSessao(telefone);
    registrarEntradaSessao(sessao, "assistant", msg);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", msg, sessao.nome || "");
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

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
  // ── AGUARDANDO DISPONIBILIDADE (última etapa da pré-triagem) ──────────────
  if (sessao.aguardandoDisponibilidade) {
    sessao.aguardandoDisponibilidade = false;
    const disponibilidade = mensagem.trim();
    sessao.disponibilidadeColetada = disponibilidade;
    await salvarDisponibilidadeNaPlanilha(telefone, disponibilidade);
    await confirmarInteresseNaPlanilha(telefone, sessao.ultimaAnalise);
    await enviarAlertaFinalThiara(sessao.ultimaAnalise, telefone, disponibilidade, true, sessao.perfilSintetico || null);
    const nomeDisp = primeiroNome(sessao.ultimaAnalise && sessao.ultimaAnalise.nome ? sessao.ultimaAnalise.nome : (sessao.nome || ""));
    const respDisp = `Perfeito${nomeDisp ? ", " + nomeDisp : ""}! 😊\n\nRegistrei sua disponibilidade e sua candidatura está sendo encaminhada para a nossa equipe.\n\nEm breve entraremos em contato para os próximos passos. Obrigada pelo interesse! 💙`;
    registrarEntradaSessao(sessao, "assistant", respDisp);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", respDisp, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return respDisp;
  }

  // ── PRÉ-TRIAGEM: perguntas eliminatórias em andamento ─────────────────────
  if (sessao.preTriagem && sessao.preTriagem.ativa) {
    const pt = sessao.preTriagem;
    const pergAtual = pt.perguntas[pt.indice];
    if (pergAtual) {
      pt.respostas[pergAtual.campo] = mensagem.trim();
      // Knock-out: resposta negativa a requisito eliminatório
      if (pergAtual.knockout && ehRespostaNegativaKO(mensagem)) {
        pt.ativa = false;
        pt.reprovado = true;
        console.log(`PRÉ-TRIAGEM REPROVADA — ${telefone} — ${pergAtual.campo}`);
        await salvarAnaliseNaPlanilha(telefone, Object.assign({}, sessao.ultimaAnalise || {}, { status: "Reprovado na pré-triagem — " + pergAtual.campo, scoreVaga: 0 }));
        const nomeKO = primeiroNome(sessao.ultimaAnalise && sessao.ultimaAnalise.nome ? sessao.ultimaAnalise.nome : (sessao.nome || ""));
        const respKO = `Entendi${nomeKO ? ", " + nomeKO : ""}! 😊\n\nInfelizmente esse requisito é necessário para essa vaga.\n\nMas vou manter seu contato no nosso banco de talentos. Se surgir uma oportunidade mais compatível com seu perfil, entraremos em contato. 💙`;
        registrarEntradaSessao(sessao, "assistant", respKO);
        marcarConversaRespondida(sessao);
        sessao.historico = sessao.historico.slice(-500);
        await salvarMensagemSheets(telefone, "assistant", respKO, sessao.nome);
        await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
        return respKO;
      }
      pt.indice++;
    }
    const proxPerg = pt.perguntas[pt.indice];
    if (proxPerg) {
      registrarEntradaSessao(sessao, "assistant", proxPerg.pergunta);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", proxPerg.pergunta, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
      return proxPerg.pergunta;
    }
    // Pré-triagem concluída → pedir disponibilidade
    pt.ativa = false;
    sessao.aguardandoDisponibilidade = true;
    const respDisponib = `Ótimo! 😊 Quase lá.\n\nQue horários você teria disponibilidade para uma entrevista essa semana? (ex: manhã, tarde, dias específicos)`;
    registrarEntradaSessao(sessao, "assistant", respDisponib);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", respDisponib, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return respDisponib;
  }

  // ── MINI-QUESTIONÁRIO: candidatos sem currículo ────────────────────────────
  if (sessao.miniQuestionario && sessao.miniQuestionario.ativo) {
    const mq = sessao.miniQuestionario;
    const mqPergAtual = MINI_QUESTIONARIO_PERGUNTAS[mq.indice];
    if (mqPergAtual) {
      mq.respostas[mqPergAtual.campo] = mensagem.trim();
      mq.indice++;
    }
    const mqProxima = MINI_QUESTIONARIO_PERGUNTAS[mq.indice];
    if (mqProxima) {
      registrarEntradaSessao(sessao, "assistant", mqProxima.pergunta);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", mqProxima.pergunta, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
      return mqProxima.pergunta;
    }
    // Mini-questionário concluído
    mq.ativo = false; mq.concluido = true;
    sessao.perfilSintetico = gerarPerfilSintetico(mq.respostas, sessao);
    const analiseSint = { nome: sessao.nome || "", cidade: mq.respostas.localidade || "", areaInteresse: mq.respostas.areaExperiencia || "", anosExperiencia: mq.respostas.anosExperiencia || "", escolaridade: mq.respostas.escolaridade || "", status: "Perfil coletado sem CV", scoreGeral: 50, scoreVaga: 50, classificacao: "A verificar", vagaInteresse: sessao.ultimaAnalise && sessao.ultimaAnalise.vagaInteresse ? sessao.ultimaAnalise.vagaInteresse : "", idVaga: sessao.ultimaAnalise && sessao.ultimaAnalise.idVaga ? sessao.ultimaAnalise.idVaga : "" };
    sessao.ultimaAnalise = Object.assign({}, sessao.ultimaAnalise || {}, analiseSint);
    await salvarAnaliseNaPlanilha(telefone, analiseSint);
    const vagasMQ = await buscarVagas();
    const koMQ = montarPerguntasKnockout(sessao.ultimaAnalise, vagasMQ);
    if (koMQ.length > 0) {
      sessao.preTriagem = { ativa: true, perguntas: koMQ, indice: 0, respostas: {}, reprovado: false };
      const respKO = `Obrigada! 😊 Só mais algumas perguntinhas rápidas sobre a vaga.\n\n${koMQ[0].pergunta}`;
      registrarEntradaSessao(sessao, "assistant", respKO);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", respKO, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
      return respKO;
    }
    sessao.aguardandoDisponibilidade = true;
    const respMQFim = `Obrigada por compartilhar! 😊\n\nQue horários você teria disponibilidade para uma entrevista essa semana?`;
    registrarEntradaSessao(sessao, "assistant", respMQFim);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", respMQFim, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return respMQFim;
  }

  // ── CANDIDATO CONFIRMA INTERESSE (fluxo com CV analisado) ─────────────────
  if (sessao.aguardandoConfirmacaoInteresse && ehConfirmacaoInteresse(mensagem)) {
    sessao.aguardandoConfirmacaoInteresse = false;
    const vagasKO = await buscarVagas();
    const perguntasKO = montarPerguntasKnockout(sessao.ultimaAnalise, vagasKO);
    if (perguntasKO.length > 0) {
      sessao.preTriagem = { ativa: true, perguntas: perguntasKO, indice: 0, respostas: {}, reprovado: false };
      const nomeKO2 = primeiroNome(sessao.ultimaAnalise && sessao.ultimaAnalise.nome ? sessao.ultimaAnalise.nome : (sessao.nome || ""));
      const respInicio = `Que ótimo${nomeKO2 ? ", " + nomeKO2 : ""}! 😊 Antes de encaminhar sua candidatura, preciso confirmar algumas informações sobre a vaga.\n\n${perguntasKO[0].pergunta}`;
      registrarEntradaSessao(sessao, "assistant", respInicio);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", respInicio, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
      return respInicio;
    }
    // Sem knockout → pedir disponibilidade direto
    sessao.aguardandoDisponibilidade = true;
    const nomeInt = primeiroNome(sessao.ultimaAnalise && sessao.ultimaAnalise.nome ? sessao.ultimaAnalise.nome : (sessao.nome || ""));
    const respInt = `Que ótimo${nomeInt ? ", " + nomeInt : ""}! 😊 Já registrei seu interesse.\n\nQue horários você teria disponibilidade para uma entrevista essa semana?`;
    registrarEntradaSessao(sessao, "assistant", respInt);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", respInt, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return respInt;
  }
  // ── DETECÇÃO: candidato sem CV que declarou não ter currículo ──────────────
  if (!sessao.curriculo && !(sessao.miniQuestionario && sessao.miniQuestionario.ativo) && !(sessao.miniQuestionario && sessao.miniQuestionario.concluido) && !sessao.preTriagem && !sessao.aguardandoDisponibilidade) {
    const histTexto = normalizarTexto((sessao.historico || []).slice(-6).map(function(h){ return h.content || ""; }).join(" "));
    const naoTemCV = ["nao tenho curriculo","não tenho currículo","nao tenho cv","não tenho cv","nao sei fazer curriculo","não sei fazer","nao vou mandar","não vou mandar","nao tenho como enviar"].some(function(p){ return histTexto.includes(p); });
    if (naoTemCV) {
      sessao.miniQuestionario = { ativo: true, indice: 0, respostas: {}, concluido: false };
      const nmSemCV = primeiroNome(sessao.nome || "");
      const respSemCV = `Sem problema${nmSemCV ? ", " + nmSemCV : ""}! 😊 Posso fazer algumas perguntas rápidas para registrar seu perfil.\n\n${MINI_QUESTIONARIO_PERGUNTAS[0].pergunta}`;
      registrarEntradaSessao(sessao, "assistant", respSemCV);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", respSemCV, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
      return respSemCV;
    }
  }

  const vagas = await buscarVagas();

  // RAIO-X: registra diagnóstico da busca de vagas para cada mensagem
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagem, sessao.historico);
  const areaDetectada = detectarAreaCandidato(normalizarTexto(mensagem + " " + (sessao.historico||[]).slice(-4).map(h=>h.content||"").join(" ")));
  const raiox = {
    ts: new Date().toISOString(),
    mensagem: mensagem.slice(0, 100),
    totalVagasDisp: vagas.length,
    vagasFiltradasQtd: vagasFiltradas.length,
    areaDetectada: areaDetectada || "nenhuma",
    vagasEncontradas: vagasFiltradas.slice(0,3).map(v => campo(v,["cargo","Cargo"]) + " / " + campo(v,["cidade","Cidade/Bairro","Cidade"]))
  };
  if (!sessao.raiox) sessao.raiox = [];
  sessao.raiox = [...sessao.raiox.slice(-9), raiox]; // guarda os 10 mais recentes
  if (vagas.length === 0) {
    console.warn(`RAIO-X VAGAS — ${telefone}: lista de vagas VAZIA ao processar mensagem. Cache: ${vagasCache.length} vagas em cache.`);
  } else if (vagasFiltradas.length === 0) {
    console.warn(`RAIO-X VAGAS — ${telefone}: ${vagas.length} vagas disponíveis mas NENHUMA filtrada. Área: ${areaDetectada||"não detectada"}`);
  }

  // Captura vaga de interesse declarada pelo candidato.
  // Só registra se: o candidato já informou o nome, ainda não tem vaga registrada,
  // e a mensagem parece ser uma declaração de interesse (não uma saudação curta).
  if (sessao.nome && !sessao.vagaInteresseDeclarado && mensagem.length > 3) {
    const textoInteresse = normalizarTexto(mensagem);
    const ehSoNome = sessao.historico.filter(h => h.role === "assistant").length <= 1;
    const pareceInteresse = areaDetectada ||
      textoInteresse.includes("vaga") || textoInteresse.includes("cargo") ||
      textoInteresse.includes("trabalh") || textoInteresse.includes("emprego") ||
      textoInteresse.includes("oportunidade") || textoInteresse.includes("interesse");
    if (!ehSoNome && pareceInteresse) {
      sessao.vagaInteresseDeclarado = mensagem.trim();
      console.log(`INTERESSE CAPTURADO — ${telefone}: "${sessao.vagaInteresseDeclarado}"`);
    }
  }

  const prompt = montarPromptConversa(sessao, mensagem, vagas);
  let resposta = await chamarClaudeTexto(prompt);

  // Se a IA falhou, tenta uma vez mais após 3 segundos antes de desistir
  if (resposta === FALLBACK_INSTABILIDADE || resposta === FALLBACK_RATE_LIMIT) {
    console.warn(`IA falhou (1ª tentativa) — ${telefone}. Aguardando 3s e tentando novamente...`);
    await sleep(3000);
    resposta = await chamarClaudeTexto(prompt);
  }

  // Se ainda falhou após retry, envia acuse de recibo neutro ao candidato e alerta Thiara
  if (resposta === FALLBACK_INSTABILIDADE || resposta === FALLBACK_RATE_LIMIT) {
    if (!sessao._alertaInstabilidadeEnviado || (Date.now() - sessao._alertaInstabilidadeEnviado) > 10 * 60 * 1000) {
      sessao._alertaInstabilidadeEnviado = Date.now();
      await enviarAlertaSimplesThiara(telefone, "🔥 FALHA AO CHAMAR A IA — LIA NÃO RESPONDEU", mensagem);
    }
    // Envia acuse de recibo neutro para o candidato não ficar sem resposta
    const respostaFallback = `Recebi sua mensagem! 😊 Em instantes te retorno. 💙`;
    registrarEntradaSessao(sessao, "assistant", respostaFallback);
    marcarConversaRespondida(sessao);
    sessao.historico = sessao.historico.slice(-500);
    await salvarMensagemSheets(telefone, "assistant", respostaFallback, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    return respostaFallback;
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
    // ══════════════════════════════════════════════════════
    // PASSO 1 — DOWNLOAD DO BINÁRIO
    // Se isso falhar, é problema real (Meta API fora). Nada pode ser feito.
    // ══════════════════════════════════════════════════════
    const { buffer: arquivoBuffer, filename: arquivoNome, mimeType, sizeBytes } = await baixarArquivo(documento.id, documento.filename, documento.mime_type || documento.mimeType);

    // ══════════════════════════════════════════════════════
    // PASSO 2 — SALVAR NO GOOGLE DRIVE IMEDIATAMENTE
    // Isso é feito ANTES de qualquer análise. É o armazenamento permanente.
    // Se falhar, tenta mais 2 vezes com delay crescente antes de desistir.
    // ══════════════════════════════════════════════════════
    let driveLink = null;
    let drivePasta = null;
    for (let tentDrive = 1; tentDrive <= 3; tentDrive++) {
      try {
        const driveInfo = await uploadCurriculoDrive(arquivoBuffer, arquivoNome || `curriculo_${telefone}`, "Currículos Recebidos", telefone, mimeType);
        if (driveInfo?.link) {
          driveLink = driveInfo.link;
          drivePasta = driveInfo.pasta;
          console.log(`✅ CV NO DRIVE (tentativa ${tentDrive}) — ${telefone} — ${driveLink}`);
          break;
        }
      } catch (e) {
        console.error(`Drive tentativa ${tentDrive}/3 falhou: ${e.message}`);
        if (tentDrive < 3) await sleep(2000 * tentDrive);
      }
    }
    if (!driveLink) {
      console.error(`⚠️ CV NÃO SALVO NO DRIVE após 3 tentativas — ${telefone} | ${arquivoNome}`);
      await enviarAlertaSimplesThiara(telefone, "🔥 CURRÍCULO NÃO FOI SALVO NO DRIVE", `Arquivo: ${arquivoNome || "desconhecido"}`);
    }

    // ══════════════════════════════════════════════════════
    // PASSO 3 — REGISTRAR NA SESSÃO E SALVAR NO SHEETS
    // Agora com driveLink já disponível. Registro permanente.
    // ══════════════════════════════════════════════════════
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
      driveLink,
      pasta: drivePasta,
      analiseStatus: driveLink ? "salvo_drive" : "drive_indisponivel"
    });
    sessao.curriculo = cvSalvo;
    console.log(`CV REGISTRADO — ${telefone} — Drive: ${driveLink ? "✅" : "❌"} — Local: ${localInfo.localPath ? "✅" : "❌"}`);

    // Salva no Sheets imediatamente com driveLink. Se o servidor reiniciar agora, o link está lá.
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");

    // ══════════════════════════════════════════════════════
    // PASSO 4 — EXTRAIR TEXTO PARA ANÁLISE (opcional)
    // Falha aqui não afeta o que já foi salvo.
    // ══════════════════════════════════════════════════════
    const textoCurriculo = await extrairTextoPdf(arquivoBuffer, arquivoNome, mimeType);

    // Se não houver texto legível, currículo está salvo no Drive — só avisa.
    if (!textoCurriculo || textoCurriculo.length < 50) {
      if (cvSalvo) cvSalvo.analiseStatus = cvSalvo.analiseStatus === "salvo_drive" ? "salvo_drive_sem_texto" : cvSalvo.analiseStatus;
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

      // Força match por área para candidatos não-RH
      if (!vagaRH) {
        const areaCv = detectarAreaCandidato(textoCurriculo);
        if (areaCv) {
          const vagaArea = buscarVagaDaArea(vagas, areaCv);
          if (vagaArea) {
            const cargoArea = campo(vagaArea, ["cargo", "Cargo", "CARGO"]);
            const cidadeArea = campo(vagaArea, ["cidade", "Cidade/Bairro", "Cidade", "Local"]);
            const idArea = campo(vagaArea, ["idVaga", "ID Vaga", "ID"]);
            const semMatch = !analise.vagaInteresse
              || normalizarTexto(analise.mensagemCandidato || "").includes("nao ha vagas")
              || normalizarTexto(analise.mensagemCandidato || "").includes("não há vagas")
              || normalizarTexto(analise.mensagemCandidato || "").includes("oportunidade em aberto");
            if (semMatch) {
              analise.vagaInteresse = cargoArea || analise.vagaInteresse;
              analise.idVaga = idArea || analise.idVaga || "";
              analise.cidade = analise.cidade || cidadeArea || "";
              analise.areaInteresse = analise.areaInteresse || areaCv;
              analise.scoreGeral = Math.max(Number(analise.scoreGeral || 0), 70);
              analise.scoreVaga = Math.max(Number(analise.scoreVaga || 0), 70);
              analise.classificacao = analise.classificacao || "Bom";
              analise.motivoMatch = analise.motivoMatch || `Aderência com a área de ${areaCv}.`;
              analise.mensagemCandidato = `😊 Olá, ${analise.nome || "tudo bem"}!\n\nAnalisei seu currículo e encontrei uma vaga com aderência ao seu perfil:\n\n📌 ${cargoArea}\n📍 ${cidadeArea || "ES"}\n\nVou registrar seu interesse e encaminhar seu perfil para avaliação. Você teria interesse em participar? 💙`;
            }
          }
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


// Apenas faz o download do arquivo. Não tenta parsear. Mais rápido e nunca bloqueia o salvamento.
async function baixarArquivo(mediaId, filenameOriginal, mimeTypeOriginal = "", tentativa = 1) {
  try {
    const mediaInfo = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` }, timeout: 15000 });
    const arquivo = await axios.get(mediaInfo.data.url, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` }, responseType: "arraybuffer", timeout: 45000 });
    const buffer = Buffer.from(arquivo.data);
    const filename = filenameOriginal || "curriculo";
    const mimeType = mimeTypeOriginal || arquivo.headers?.["content-type"] || "application/octet-stream";
    return { buffer, filename, mimeType, sizeBytes: buffer.length };
  } catch (e) {
    if (tentativa < 3) {
      console.error(`baixarArquivo tentativa ${tentativa} falhou: ${e.message} — retentando...`);
      await sleep(2000 * tentativa);
      return baixarArquivo(mediaId, filenameOriginal, mimeTypeOriginal, tentativa + 1);
    }
    throw e;
  }
}

// Extrai texto do PDF para análise. Totalmente opcional — falha aqui não afeta o salvamento.
async function extrairTextoPdf(buffer, filename, mimeType) {
  const ehPdf = /pdf/i.test(mimeType) || /\.pdf$/i.test(filename);
  if (!ehPdf) return "";
  try {
    const pdfData = await pdfParse(buffer);
    return String(pdfData.text || "").slice(0, 12000);
  } catch (e) {
    console.error("Leitura do texto do PDF falhou (arquivo já salvo no Drive):", e.message);
    return "";
  }
}

// Mantida para compatibilidade, mas processarCurriculo usa as funções separadas agora.
async function baixarELerPdf(mediaId, filenameOriginal, mimeTypeOriginal = "") {
  const { buffer, filename, mimeType, sizeBytes } = await baixarArquivo(mediaId, filenameOriginal, mimeTypeOriginal);
  const texto = await extrairTextoPdf(buffer, filename, mimeType);
  return { texto, buffer, filename, mimeType, sizeBytes };
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

// Cache de vagas — evita retornar lista vazia quando o Sheets está lento ou fora
let vagasCache = [];
let vagasCacheTs = 0;
const VAGAS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function buscarVagas() {
  // Se o cache ainda é válido, usa sem bater no Sheets
  if (vagasCache.length && (Date.now() - vagasCacheTs) < VAGAS_CACHE_TTL) {
    return vagasCache;
  }
  try {
    const vagasSheets = [];
    if (CONFIG.VAGAS_URL) {
      const r = await axios.get(CONFIG.VAGAS_URL, { timeout: 15000 });
      if (r.data?.vagas) vagasSheets.push(...r.data.vagas.filter(vagaEstaAtiva));
    }
    if (vagasSheets.length) {
      vagasCache = vagasSheets;
      vagasCacheTs = Date.now();
    }
    // Se Sheets retornou vazio mas temos cache, usa o cache (evita "não temos vagas" falso)
    return vagasSheets.length ? vagasSheets : vagasCache;
  } catch (e) {
    console.error("Erro buscarVagas:", e.message);
    return vagasCache; // usa cache antigo em vez de retornar []
  }
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
  const areaCandidato = detectarAreaCandidato(textoBusca);
  const CIDADES_ES = ["linhares", "serra", "vitoria", "vila velha", "cariacica", "guarapari",
    "colatina", "cachoeiro", "aracruz", "viana", "fundao", "fundão", "santa teresa",
    "piuma", "anchieta", "itapemirim", "marataizes", "marataízes"];
  const vagasComScore = vagas.map(vaga => {
    const textoVaga = textoDaVaga(vaga);
    let score = 0;
    textoBusca.split(/\s+/).filter(p => p.length >= 4).slice(0, 100).forEach(p => { if (textoVaga.includes(p)) score++; });
    if (areaCandidato && isVagaDaArea(vaga, areaCandidato)) {
      const boosts = { rh: 80, logistica: 60, administrativo: 50, operacional: 50, projetos: 50, alimentos: 50, limpeza: 50, vendas: 50 };
      score += boosts[areaCandidato] || 40;
    }
    CIDADES_ES.forEach(cidade => { if (textoBusca.includes(cidade) && textoVaga.includes(cidade)) score += 35; });
    return { vaga, score };
  });
  const filtradas = vagasComScore.filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(i => i.vaga);
  if (filtradas.length === 0 && areaCandidato) {
    const porArea = vagas.filter(v => isVagaDaArea(v, areaCandidato));
    if (porArea.length > 0) return porArea.slice(0, 8);
  }
  // CORREÇÃO: não retornar TODAS as vagas como fallback — isso causava sugestão de vagas
  // sem qualquer aderência (ex: vigilante para candidato de limpeza).
  // Se nenhuma vaga tem score > 0, retorna lista vazia para o prompt não forçar match.
  return filtradas;
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
  const areaDetectada = detectarAreaCandidato(textoConversa);

  // Detecta se vaga de interesse já foi declarada pelo candidato no histórico
  const vagaInteresseDeclarada = sessao.vagaInteresseDeclarado || null;
  const jaTemNome = !!(sessao.nome);
  const jaTemVagaInteresse = !!(vagaInteresseDeclarada || areaDetectada);
  const curriculoRecebido = !!(sessao.curriculo);

  const instrucaoCurriculo = ehLinhares
    ? `REGRA ESPECIAL — LINHARES / DIÁRIA DE LIMPEZA:\n- Colete APENAS: nome, se mora em Linhares, se possui experiência com limpeza ou serviços gerais\n- O currículo é opcional.\n- NÃO peça escolaridade, documentos, disponibilidade de horário ou escala.\n- Informe quando fizer sentido: diária de R$ 250,00, passagem inclusa, alimentação inclusa, local: Bairro Shell, Linhares\n- Após coletar essas informações, diga que a equipe da Effect fará contato para os próximos passos.`
    : areaDetectada
    ? `COLETA DIRECIONADA — ÁREA: ${areaDetectada.toUpperCase()}:\n- O candidato demonstrou interesse ou experiência em ${areaDetectada}.\n- Priorize vagas da área de ${areaDetectada} disponíveis na lista.\n- Colete: nome, cidade/bairro, experiência na área, escolaridade, disponibilidade e currículo.\n- Se houver vaga compatível, apresente com cargo, local, regime, remuneração, benefícios, jornada e requisitos.\n- Se o currículo já foi recebido, confirme o interesse e informe os próximos passos.`
    : `COLETA PADRÃO:\nColete aos poucos: nome, cidade/bairro, área ou vaga, experiência, escolaridade, disponibilidade e currículo.\nSe o currículo já foi recebido, siga com interesse na vaga, disponibilidade, deslocamento ou próximos passos.`

  const instrucaoFluxo = !jaTemNome
    ? `ETAPA ATUAL: Perguntar o nome.\nPergunta obrigatória antes de qualquer outra ação: "Antes de começarmos, qual é o seu nome?"`
    : !jaTemVagaInteresse && !curriculoRecebido
    ? `ETAPA ATUAL: Perguntar qual vaga o candidato busca.\nO candidato já informou o nome. AGORA pergunte: "Que tipo de vaga ou área você está buscando?"\nNÃO sugira vagas ainda. Primeiro capture o interesse declarado.`
    : vagaInteresseDeclarada
    ? `VAGA DE INTERESSE DECLARADA PELO CANDIDATO: ${vagaInteresseDeclarada}\nUse essa informação como referência principal ao sugerir vagas. Ao sugerir uma vaga diferente, explique brevemente por que ela pode ser uma boa oportunidade.`
    : ``;

  return `Você é a Lia, da Effect Pessoas e Performance.\n\nREGRAS GERAIS:\n- Nunca diga que é robô, IA, chatbot ou assistente virtual.\n- Nunca use menu numérico.\n- Faça somente uma pergunta por vez.\n- Não repita "Eu sou a Lia" se a conversa já começou.\n- Seja humana, acolhedora, organizada, profissional e leve.\n- Seja simpática, mas sem exageros.\n- NÃO diga "que nome lindo", "amei seu nome", "nome bonito" ou qualquer elogio ao nome da pessoa.\n- Use o nome do candidato de forma natural e profissional.\n- Responda curto, como WhatsApp.\n- Se o histórico indicar que o currículo já foi recebido ou analisado, NÃO peça o currículo novamente.\n- Se tiver dúvida, NÃO invente. Responda que vai confirmar com a equipe da Effect.\n\nFORMATO DE MENSAGENS — REGRA ABSOLUTA:\n- NUNCA use ###, **, *, ##, markdown de nenhum tipo.\n- WhatsApp não renderiza markdown. Tudo aparecerá como texto com símbolos feios.\n- Use apenas texto simples, emojis como 📍 📌 💼 🕐 💰 e quebras de linha.\n- Para apresentar uma vaga, use este formato EXATO (sem asteriscos, sem hashtags):\n\nVaga: [nome da vaga]\nLocal: [cidade/bairro]\nRegime: [CLT / PJ / etc]\nSalário: [valor]\nBenefícios: [lista simples]\nJornada: [horário/escala]\nRequisitos: [o que é necessário]\n\nABERTURA:\nSe for o primeiro contato e a pessoa ainda não informou o nome, responda:\n"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"\n\n${instrucaoFluxo}\n\nREGRA CRÍTICA — VAGAS:\n- Se o candidato perguntar sobre um cargo ou área e existir vaga correspondente em VAGAS DISPONÍVEIS, apresente a vaga IMEDIATAMENTE com todos os detalhes.\n- Se não houver vaga exatamente igual ao pedido, apresente as vagas similares disponíveis e diga: "No momento não temos exatamente essa vaga, mas temos essas oportunidades que podem te interessar."\n- NUNCA diga "não temos vagas" ou "não há vagas disponíveis". Se a lista estiver vazia ou sem compatibilidade, diga: "Vou verificar com a equipe Effect as vagas disponíveis para o seu perfil e te retorno em breve. 💙"\n- NUNCA invente vagas. Use apenas as que estão em VAGAS DISPONÍVEIS.\n- Se houver mais de uma vaga compatível, apresente todas de forma organizada.\n- Após apresentar a vaga, pergunte se a pessoa tem interesse.\n\n${instrucaoCurriculo}\n\nVAGAS DISPONÍVEIS:\n${JSON.stringify(vagasResumidas, null, 2)}\n\nHISTÓRICO RECENTE:\n${historicoCurto}\n\nMENSAGEM ATUAL:\n${mensagemAtual}\n\nResponda somente a próxima mensagem da Lia.`;
}

function montarPromptAnaliseEstruturada(textoCurriculo, vagas) {
  const vagasResumidas = resumirVagas(vagas);
  return `Você é a Lia, da Effect Pessoas e Performance.\n\nAnalise o currículo abaixo e compare com as vagas disponíveis.\n\nResponda SOMENTE em JSON válido, sem markdown, sem explicação fora do JSON.\n\nUse exatamente esta estrutura:\n\n{\n  "nome": "",\n  "cidade": "",\n  "areaInteresse": "",\n  "vagaInteresse": "",\n  "idVaga": "",\n  "scoreGeral": 0,\n  "scoreVaga": 0,\n  "classificacao": "",\n  "motivoMatch": "",\n  "status": "",\n  "requisitoObrigatorio": "",\n  "escolaridadeCompativel": "",\n  "experienciaCompativel": "",\n  "anosExperiencia": "",\n  "pontosFortes": "",\n  "pontosAtencao": "",\n  "analiseIA": "",\n  "transporteProprio": "",\n  "cltImediato": "",\n  "observacoes": "",\n  "mensagemCandidato": ""\n}\n\nREGRAS DE CLASSIFICAÇÃO:\n- 90 a 100: Excelente\n- 70 a 89: Bom\n- 50 a 69: Regular\n- abaixo de 50: Reprovado\n- Nunca use Excelente se faltar requisito obrigatório.\n- Não prometa contratação.\n\nREGRA CRÍTICA — REQUISITOS OBRIGATÓRIOS (HARD FILTER):\n- Cada vaga pode ter um campo "requisitoObrigatorio". Se esse campo estiver preenchido, é um requisito ELIMINATÓRIO.\n- NUNCA sugira uma vaga cujo requisitoObrigatorio não esteja comprovado no currículo.\n- Exemplos de requisitos obrigatórios e como verificar:\n  * "Curso de Vigilante" / "Curso de formação de vigilante" / "Vigilante": candidato precisa ter curso ou registro de vigilante no currículo. Se não tiver, scoreVaga = 0, classificacao = "Reprovado", vagaInteresse = "" para essa vaga.\n  * "CNH B" / "CNH": candidato precisa ter CNH mencionada no currículo.\n  * "Ensino Superior completo": candidato precisa ter graduação concluída.\n- Se nenhuma vaga adequada existir após aplicar os filtros obrigatórios, retorne vagaInteresse = "", idVaga = "", scoreVaga = 0, e mensagemCandidato = "😊 Olá, {NOME}!\\n\\nRecebi seu currículo e ele já está salvo em nosso Banco de Talentos!\\n\\nAssim que surgir uma oportunidade compatível com o seu perfil, entraremos em contato. 💙"\n- JAMAIS force um match com vaga que exige requisito obrigatório que o candidato não possui.\n\nFORMATO DA mensagemCandidato:\n😊 Olá, {NOME}!\n\nAnalisei seu currículo e identifiquei uma oportunidade que possui compatibilidade com sua experiência profissional.\n\n📍 {CARGO}\n📍 {CIDADE}\n\nOs principais pontos observados foram:\n\n• {PONTO FORTE 1}\n• {PONTO FORTE 2}\n• {PONTO FORTE 3}\n\nVocê teria interesse em participar deste processo seletivo?\n\nFico à disposição. 💙\n\nREGRAS:\n- Não mostrar score.\n- Não mostrar classificação.\n- Não falar em IA ou análise automática.\n- Não elogiar o nome.\n- Não usar textos longos.\n- Não prometer contratação.\n- NUNCA use ###, **, *, markdown de nenhum tipo na mensagemCandidato. Apenas texto simples com emojis.\n\nVAGAS:\n${JSON.stringify(vagasResumidas, null, 2)}\n\nCURRÍCULO:\n${textoCurriculo}`;
}

async function chamarClaudeTexto(prompt) { return await chamarClaude(prompt); }

async function chamarClaudeJSON(prompt) {
  const texto = await chamarClaude(prompt);
  // FIX: se a IA retornou fallback de instabilidade, não tenta parsear JSON
  if (texto === FALLBACK_INSTABILIDADE || texto === FALLBACK_RATE_LIMIT) {
    throw new Error("IA indisponível para análise de currículo");
  }
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

    if (ehRateLimit && tentativa < 3) {
      await sleep(3000 * tentativa);
      return chamarGemini(prompt, tentativa + 1);
    }
    if (ehRateLimit) return FALLBACK_RATE_LIMIT;

    if (ehTimeoutOuRede && tentativa < 4) {
      await sleep(1500 * tentativa);
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

    if (ehRateLimit && tentativa < 3) {
      await sleep(3000 * tentativa);
      return chamarClaudeOriginal(prompt, tentativa + 1);
    }
    if (ehRateLimit) return FALLBACK_RATE_LIMIT;

    if (ehTimeoutOuRede && tentativa < 4) {
      await sleep(1500 * tentativa);
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

// ═══════════════════════════════════════════════════════════════════════════════
// PRÉ-TRIAGEM + MINI-QUESTIONÁRIO + ALERTAS INTELIGENTES (Melhorias 1, 2 e 3)
// ═══════════════════════════════════════════════════════════════════════════════

const MINI_QUESTIONARIO_PERGUNTAS = [
  { campo: "areaExperiencia", pergunta: "Qual é a sua principal área de atuação? (ex: vendas, logística, administrativo, limpeza...)" },
  { campo: "anosExperiencia", pergunta: "Há quanto tempo você trabalha nessa área?" },
  { campo: "escolaridade",    pergunta: "Qual é a sua escolaridade? (ex: ensino médio completo, superior cursando, técnico...)" },
  { campo: "disponibCLT",    pergunta: "Você tem disponibilidade para trabalho em regime CLT com carteira assinada?" },
  { campo: "localidade",     pergunta: "Em qual cidade ou bairro você mora?" }
];

function montarPerguntasKnockout(analise, vagas) {
  const perguntas = [];
  const reqObrig = normalizarTexto(analise && analise.requisitoObrigatorio ? analise.requisitoObrigatorio : "");
  const cidade   = String((analise && analise.cidade) ? analise.cidade : "");
  const vaga     = (vagas || []).find(function(v) { return campo(v, ["idVaga","ID Vaga","ID"]) === (analise && analise.idVaga); });
  const escala   = vaga ? normalizarTexto(campo(vaga, ["escala","Escala","Escala/Horário"]) || "") : "";
  const reqVaga  = vaga ? normalizarTexto(campo(vaga, ["requisitos","Requisitos"]) || "") : "";

  if (reqObrig.includes("cnh") || reqObrig.includes("carteira") || reqVaga.includes("cnh"))
    perguntas.push({ campo: "temCNH", knockout: true, pergunta: "Você possui CNH válida?" });
  if (reqObrig.includes("vigilante"))
    perguntas.push({ campo: "temVigilante", knockout: true, pergunta: "Você possui o Curso de Formação de Vigilante?" });
  if (reqObrig.includes("superior") || reqObrig.includes("graduacao"))
    perguntas.push({ campo: "temSuperior", knockout: true, pergunta: "Você possui ensino superior completo?" });
  if (reqObrig.includes("ingles") || reqVaga.includes("ingles"))
    perguntas.push({ campo: "nivelIngles", knockout: false, pergunta: "Qual é o seu nível de inglês? (básico, intermediário ou avançado)" });
  if (escala.includes("6x1") || escala.includes("turno") || escala.includes("escala")) {
    var escalaLabel = vaga ? (campo(vaga, ["escala","Escala"]) || "rotativa") : "rotativa";
    perguntas.push({ campo: "aceitaEscala", knockout: true, pergunta: "A vaga trabalha em escala (" + escalaLabel + "). Você tem disponibilidade para esse regime?" });
  }
  if (cidade && !["es","espirito santo","espirito santo"].includes(normalizarTexto(cidade)))
    perguntas.push({ campo: "localidade", knockout: true, pergunta: "A vaga é em " + cidade + ". Você mora na região ou tem como se deslocar?" });
  if (reqObrig.includes("transporte") || reqVaga.includes("transporte proprio"))
    perguntas.push({ campo: "temTransporte", knockout: true, pergunta: "Você possui transporte próprio?" });

  return perguntas;
}

function ehRespostaNegativaKO(texto) {
  var t = normalizarTexto(texto.trim());
  return ["nao","não","nao tenho","não tenho","nao possuo","não possuo","nunca","negativo",
          "infelizmente nao","infelizmente não","nao moro","nao consigo","nao tenho como"].some(function(p) {
    return t === p || t.startsWith(p + " ") || t.includes(" " + p + " ") || t.endsWith(" " + p);
  });
}

function gerarPerfilSintetico(respostas, sessao) {
  return {
    nome: sessao.nome || "",
    areaExperiencia: respostas.areaExperiencia || "",
    anosExperiencia: respostas.anosExperiencia || "",
    escolaridade:    respostas.escolaridade || "",
    localidade:      respostas.localidade || "",
    disponibCLT:     respostas.disponibCLT || ""
  };
}

async function salvarDisponibilidadeNaPlanilha(telefone, disponibilidade) {
  try {
    if (!CONFIG.VAGAS_URL) return;
    var urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, { acao: "confirmarInteresse", telefone: telefone, disponibilidade: disponibilidade },
      { headers: { "Content-Type": "application/json" }, timeout: 20000 });
  } catch (e) { console.error("Erro ao salvar disponibilidade:", e.message); }
}

async function enviarAlertaFinalThiara(analise, telefone, disponibilidade, preTriagemOk, perfilSintetico) {
  try {
    var score = Number((analise && (analise.scoreVaga || analise.scoreGeral)) ? (analise.scoreVaga || analise.scoreGeral) : 0);
    var nome  = (analise && analise.nome) ? analise.nome : ((perfilSintetico && perfilSintetico.nome) ? perfilSintetico.nome : "Não identificado");
    var vaga  = (analise && analise.vagaInteresse) ? analise.vagaInteresse : "Não identificada";
    var cid   = (analise && analise.cidade) ? analise.cidade : ((perfilSintetico && perfilSintetico.localidade) ? perfilSintetico.localidade : "Não informada");
    var classif = String((analise && analise.classificacao) ? analise.classificacao : "").toLowerCase();

    // Score < 50 sem classificação boa → não alerta
    if (score < 50 && !classif.includes("bom") && !classif.includes("excelente")) {
      console.log("Alerta suprimido (score baixo):", telefone, score);
      return;
    }

    var prontoParaEntrevista = preTriagemOk && score >= 70;
    var cabecalho = prontoParaEntrevista
      ? (score >= 90 ? "⭐ CANDIDATO EXCELENTE — PRONTO PARA ENTREVISTA" : "✅ CANDIDATO QUALIFICADO — PRONTO PARA ENTREVISTA")
      : "⚠️ CANDIDATO PARA REVISAR ANTES DE CONTATAR";

    var blocoScore   = score > 0 ? "\n⭐ Score: " + score + "\n🏅 Classificação: " + (analise && analise.classificacao ? analise.classificacao : "—") : "";
    var blocoDisp    = disponibilidade ? "\n\n📅 Disponibilidade:\n" + disponibilidade : "";
    var blocoFortes  = (analise && analise.pontosFortes) ? "\n\n💼 Pontos fortes:\n" + formatarLista(analise.pontosFortes) : "";
    var blocoAtencao = (!prontoParaEntrevista && analise && analise.pontosAtencao) ? "\n\n⚠️ Pontos de atenção:\n" + formatarLista(analise.pontosAtencao) : "";
    var blocoSint    = perfilSintetico
      ? "\n\n📋 Perfil coletado sem CV:\n• Área: " + (perfilSintetico.areaExperiencia||"-") + "\n• Exp: " + (perfilSintetico.anosExperiencia||"-") + "\n• Escolaridade: " + (perfilSintetico.escolaridade||"-") + "\n• Local: " + (perfilSintetico.localidade||"-")
      : "";
    var acao = prontoParaEntrevista
      ? "\n\n👉 PRÓXIMO PASSO: Agendar entrevista"
      : "\n\n👉 PRÓXIMO PASSO: Revisar perfil antes de contatar";

    var texto = cabecalho + "\n\n👤 " + nome + "\n📌 Vaga: " + vaga + "\n📍 Cidade: " + cid + blocoScore + blocoDisp + blocoFortes + blocoAtencao + blocoSint + acao + "\n\n📱 WhatsApp: +" + telefone;
    await enviarMensagem(CONFIG.THIARA_WHATSAPP, texto);
  } catch (e) { console.error("Erro alerta final Thiara:", e.message); }
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

// Mantida para compatibilidade com Inbox manual e /inbox/encaminhar
async function enviarAlertaInteresseThiara(analise, telefone) {
  // Redireciona para o alerta final inteligente (Melhoria 3)
  await enviarAlertaFinalThiara(analise, telefone, "", true, null);
}

function formatarLista(texto) {
  if (!texto) return "Não informado";
  const partes = String(texto).split(/;|,|\n/).map(p => p.trim()).filter(Boolean).slice(0, 5);
  return partes.length === 0 ? texto : partes.map(p => `• ${p}`).join("\n");
}

async function enviarMensagem(toOriginal, body) {
  const to = limparTelefone(toOriginal);
  if (!to) return;
  try {
    const url = `https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`;
    await axios.post(url, { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body } }, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 });
    supervisor.contarMensagemEnviada();
  } catch (e) {
    const erroMeta = e.response?.data?.error;
    const msgErro = erroMeta ? `[Meta ${erroMeta.code}] ${erroMeta.message}` : e.message;
    console.error("Erro ao enviar WhatsApp:", JSON.stringify(e.response?.data || e.message));
    supervisor.registrarErroMeta(msgErro, to);
    throw new Error(msgErro); // relança para que a rota retorne ok:false com o erro real
  }
}

async function enviarTemplate(telefone, templateName = "effect_reengajamento_candidatos", languageCode = "pt_BR") {
  const to = limparTelefone(telefone);
  if (!to) return { sucesso: false, erro: "Telefone inválido" };
  try {
    const url = `https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`;
    await axios.post(url, { messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: languageCode } } }, { headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 });
    console.log(`Template ${templateName} enviado para ${to}`);
    return { sucesso: true };
  } catch (e) {
    console.error("Erro ao enviar template:", JSON.stringify(e.response?.data || e.message));
    return { sucesso: false, erro: e.message };
  }
}

async function coletarTelefonesReengajamento() {
  const agora = Date.now();
  const INATIVO_MS = 3 * 24 * 60 * 60 * 1000;
  return Object.entries(sessoes)
    .filter(([tel, s]) => s.cvSalvo && (agora - (s.ultimaMensagem || 0)) > INATIVO_MS)
    .map(([tel]) => tel);
}

app.get("/inbox/reengajamento/status", async (req, res) => {
  try {
    const telefones = await coletarTelefonesReengajamento();
    res.json({ total: telefones.length, telefones });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post("/inbox/reengajamento/disparar", async (req, res) => {
  try {
    const { templateName = "effect_reengajamento_candidatos", languageCode = "pt_BR", forceTelefones, limite } = req.body || {};
    const telefones = forceTelefones || await coletarTelefonesReengajamento();
    const lista = limite ? telefones.slice(0, Number(limite)) : telefones;
    const resultados = [];
    for (const tel of lista) {
      const r = await enviarTemplate(tel, templateName, languageCode);
      resultados.push({ telefone: tel, ...r });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    res.json({ enviados: resultados.filter(r => r.sucesso).length, total: lista.length, resultados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get("/inbox/curriculo/:telefone/pedir-reenvio", async (req, res) => {
  try {
    const tel = limparTelefone(req.params.telefone);
    const sessao = sessoes[tel] || {};
    const nome = (sessao.nome || 'Candidato').split(' ')[0];
    const msg = `Olá, ${nome}! Precisamos do seu currículo atualizado para dar continuidade ao processo seletivo. Por favor, envie seu currículo aqui pelo WhatsApp. 😊`;
    await enviarMensagem(tel, msg);
    registrarEntradaSessao(sessao, 'assistant', msg);
    salvarConversaCompletaSheets(tel, sessao.historico || [], sessao.nome || '').catch(() => {});
    res.send('<html><body style="font-family:sans-serif;padding:32px"><h3>✅ Solicitação enviada!</h3><p>Mensagem enviada pedindo reenvio do currículo.</p><p><a href="javascript:window.close()">Fechar</a></p></body></html>');
  } catch (e) {
    res.status(500).send('Erro ao enviar mensagem: ' + e.message);
  }
});

app.post("/inbox/reengajamento/enviar-um", async (req, res) => {
  try {
    const { telefone, templateName = "effect_reengajamento_candidatos", languageCode = "pt_BR" } = req.body || {};
    if (!telefone) return res.status(400).json({ erro: "telefone obrigatório" });
    const r = await enviarTemplate(telefone, templateName, languageCode);
    res.json(r);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── AGENDA: salvar entrevista no Google Calendar ─────────────────────────
app.post("/agenda/salvar", async (req, res) => {
  try {
    const { candidato, cargo, empresa, data, hora, tipo, local, telefone } = req.body || {};
    if (!candidato || !data || !hora) return res.json({ ok: false, erro: "Campos obrigatórios: candidato, data, hora" });
    const result = await calendar.criarEventoEntrevista({ candidato, cargo, empresa, data, hora, tipo, local, telefone });
    res.json(result);
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ── AGENDA: horários livres ───────────────────────────────────────────────
app.get("/agenda/disponibilidade", async (req, res) => {
  try {
    const { data } = req.query;
    if (!data) return res.json({ ok: false, erro: "Parâmetro 'data' obrigatório (YYYY-MM-DD)" });
    const result = await calendar.buscarHorariosLivres(data);
    res.json(result);
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ── FINANCEIRO ────────────────────────────────────────────────────────────
app.get("/financeiro", (req, res) => res.sendFile(path.join(__dirname, "financeiro.html")));

app.post("/financeiro/lancamento", async (req, res) => {
  try {
    const dados = req.body || {};
    if (!CONFIG.DRIVE_SCRIPT_URL) return res.json({ ok: false, erro: "DRIVE_SCRIPT_URL não configurado" });
    const urlBase = CONFIG.DRIVE_SCRIPT_URL.split("?")[0];
    const resp = await axios.post(urlBase, { acao: "salvarFinanceiro", ...dados }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
    res.json({ ok: true, data: resp.data });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

app.get("/financeiro/dados", async (req, res) => {
  try {
    const { mes, ano } = req.query;
    if (!CONFIG.DRIVE_SCRIPT_URL) return res.json({ ok: false, erro: "DRIVE_SCRIPT_URL não configurado" });
    const urlBase = CONFIG.DRIVE_SCRIPT_URL.split("?")[0];
    const resp = await axios.get(`${urlBase}?acao=listarFinanceiro&mes=${mes||""}&ano=${ano||""}`, { timeout: 15000 });
    res.json({ ok: true, data: resp.data });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ── SUPERVISOR ────────────────────────────────────────────────────────────
app.get("/supervisor/status", (req, res) => res.json(supervisor.obterStatusSupervisor()));
app.post("/supervisor/resumo", async (req, res) => { await supervisor.dispararResumoSemanal(); res.json({ ok: true }); });

supervisor.iniciarSupervisor();

// ── BANCO DE TALENTOS ─────────────────────────────────────────────────────
// GET  /sheets/banco-talentos          → lista todos os talentos
// POST /sheets/banco-talentos          → salva (cria ou edita) um talento
// DELETE /sheets/banco-talentos/:id    → remove um talento pelo id

app.get("/sheets/banco-talentos", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ talentos: [] });
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=bancoTalentos`, { timeout: 15000 });
    res.json(r.data);
  } catch (e) {
    console.error("[banco-talentos GET]", e.message);
    res.json({ talentos: [], erro: e.message });
  }
});

app.post("/sheets/banco-talentos", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ ok: false, erro: "VAGAS_URL não configurada" });
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const payload = { acao: "salvarTalento", talento: req.body };
    const r = await axios.post(urlBase, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000
    });
    res.json(r.data);
  } catch (e) {
    console.error("[banco-talentos POST]", e.message);
    res.json({ ok: false, erro: e.message });
  }
});

app.delete("/sheets/banco-talentos/:id", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ ok: false, erro: "VAGAS_URL não configurada" });
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const payload = { acao: "deletarTalento", id: req.params.id };
    const r = await axios.post(urlBase, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000
    });
    res.json(r.data);
  } catch (e) {
    console.error("[banco-talentos DELETE]", e.message);
    res.json({ ok: false, erro: e.message });
  }
});
// ──────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
