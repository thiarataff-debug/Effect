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
const nodemailer = require("nodemailer");
const compression = require("compression");
const calendar   = require("./calendar");
const supervisor = require("./supervisor");

const app = express();
// Compressão (gzip) das respostas — páginas grandes como inbox.html (~370KB) e
// dashboard.html (~190KB) estavam chegando CORTADAS no meio no navegador (efeito
// clássico de timeout de proxy/rede no meio do envio de uma resposta grande e
// não-comprimida). Comprimir reduz o tamanho real transmitido em ~70-80% para
// HTML/JS, o que evita esse corte.
app.use(compression());
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
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  RAILWAY_TOKEN: process.env.RAILWAY_TOKEN,          // opcional: para monitorar créditos
  RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID, // opcional: ID do projeto Railway
  SHEETS_ID: process.env.SHEETS_ID || "1Bqrwjjy0JwAVouppOg-LGCENrYrTsQCYrqntCBf9mSk",

  // ── Divulgação de vagas (app LIA) ─────────────────────────────────────────
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,               // chave da OpenAI, só necessária se usar o provider "chatgpt"
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",
  DIVULGACAO_AI_PADRAO: process.env.DIVULGACAO_AI_PADRAO || "gemini", // "gemini" ou "chatgpt"
  EMAIL_HOST: process.env.EMAIL_HOST,                       // ex: smtp.gmail.com
  EMAIL_PORT: process.env.EMAIL_PORT || 587,
  EMAIL_SECURE: process.env.EMAIL_SECURE === "true",        // true se a porta for 465
  EMAIL_USER: process.env.EMAIL_USER,                       // e-mail remetente
  EMAIL_PASS: process.env.EMAIL_PASS,                       // senha de app (não a senha normal)
  PARCEIRO_EMAIL: process.env.PARCEIRO_EMAIL,               // e-mail do parceiro que divulga nas redes
  PARCEIRO_NOME: process.env.PARCEIRO_NOME || "Parceiro de Divulgação",
  TEMPLATE_DIVULGACAO_VAGA: process.env.TEMPLATE_DIVULGACAO_VAGA || "effect_reengajamento_candidatos" // template aprovado na Meta p/ candidatos fora da janela de 24h
};

// ── MODO EMERGÊNCIA: desativa IA Gemini sem precisar de deploy ───────────────
let geminiAtivo = true;

// ── MONITORAMENTO DE QUOTA GEMINI ─────────────────────────────────────────────
const geminiStats = {
  totalCalls: 0,
  erros429: 0,
  ultimoErro429: null,
  quotaAlerta: false   // true quando detecta rate limit/quota recorrente
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
  // FIX: compara os DIAS no fuso de Sao Paulo. O Railway roda em UTC: usar
  // getFullYear()/getDate() locais fazia mensagem da noite (ex: 22h BRT = 01h UTC
  // do dia seguinte) cair no dia errado — "hoje" virava "Ontem" e vice-versa.
  const chaveDiaSP = d => d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const startToday = new Date(`${chaveDiaSP(now)}T00:00:00`);
  const startDate = new Date(`${chaveDiaSP(date)}T00:00:00`);
  const diffDays = Math.round((startToday - startDate) / 86400000);

  if (diffDays === 0) {
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  }
  if (diffDays === 1) return "Ontem";
  if (diffDays >= 2 && diffDays < 7) {
    const diaSemanaSP = new Date(date.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })).getDay();
    return ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][diaSemanaSP];
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

    // BUG ENCONTRADO E CORRIGIDO: o Apps Script da planilha (Conversas) guarda o
    // horário como texto formatado, mas o Google Sheets detecta esse texto como uma
    // data de verdade e converte a célula sozinho. Quando o Apps Script lê de volta
    // com getValues() e faz String(valor), o resultado não é mais "01/07/2026 14:16:00"
    // — vira o formato padrão do JavaScript, tipo "Wed Jul 01 2026 14:16:00 GMT-0300
    // (Horário Padrão de Brasília)". Isso não batia com nenhum dos formatos acima, e
    // toda mensagem que passou por esse caminho ficava com timestamp zerado (o "--:--"
    // que via na tela). Esse formato específico É seguro de reconhecer com new Date()
    // (diferente de um texto curto tipo "09:02", que o comentário abaixo evitava com
    // razão — aquilo o JS interpretava como today's date, o que é outro bug).
    if (/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.getTime();
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

  // FIX: conserta/descarta timestamps impossiveis (datas no futuro herdadas do
  // bug de dia/mes trocados do Apps Script antigo).
  ms = sanearTimestampMs(ms);

  const iso = ms ? new Date(ms).toISOString() : "";

  // Quando ms=0 (nenhum timestamp real reconhecido), NÃO reaproveita o texto antigo
  // que já estava no campo (evento?.timestamp etc.) — isso é o que fazia um valor
  // corrompido tipo a string literal "Invalid Date" (gravada no Sheets por algum bug
  // antigo) se perpetuar pra sempre, já que "" || "Invalid Date" sempre retornava
  // "Invalid Date" de novo. Sem timestamp real, os campos ficam vazios mesmo.
  return {
    ...(evento || {}),
    timestamp: iso,
    timestampISO: iso,
    timestampMs: ms,
    horario: ms ? new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "",
    horarioFormatado: ms ? formatarDataWhatsApp(ms) : ""
  };
}

// Detecta e conserta timestamps IMPOSSIVEIS (no futuro). Causa conhecida: o Apps
// Script antigo interpretava "07/12/2026" como formato AMERICANO e trocava dia/mes
// ao gravar — essas datas "do futuro" ficavam no topo da lista para sempre.
// Regra: se a data esta no futuro, tenta des-trocar dia<->mes; se cair num passado
// plausivel, usa; senao descarta (melhor sem hora do que hora errada).
function sanearTimestampMs(ms) {
  ms = Number(ms || 0);
  if (!ms || ms < 0) return 0;
  const agoraMsRef = Date.now();
  const TOL_FUTURO = 12 * 60 * 60 * 1000;                      // 12h de tolerancia
  const LIMITE_PASSADO = agoraMsRef - 3 * 365 * 24 * 60 * 60 * 1000; // 3 anos
  if (ms <= agoraMsRef + TOL_FUTURO) return ms >= LIMITE_PASSADO ? ms : 0;

  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(ms)).reduce((acc, x) => { acc[x.type] = x.value; return acc; }, {});
  const dia = Number(partes.day), mes = Number(partes.month);
  if (dia >= 1 && dia <= 12 && mes >= 1 && mes <= 12 && dia !== mes) {
    const hora = partes.hour === '24' ? '00' : partes.hour;
    const pad2s = n => String(n).padStart(2, '0');
    const trocado = new Date(`${partes.year}-${pad2s(dia)}-${pad2s(mes)}T${hora}:${partes.minute}:${partes.second}-03:00`).getTime();
    if (trocado && trocado <= agoraMsRef + TOL_FUTURO && trocado >= LIMITE_PASSADO) return trocado;
  }
  return 0;
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

// Throttle do aviso abaixo: essa função roda para CADA sessão a cada consulta
// do painel (a cada 5s) — sem throttle, quando há várias sessões sem horário
// real, isso gerava uma rajada de dezenas/centenas de linhas de log por
// segundo, estourando o limite de logs/seg do Railway e derrubando junto
// linhas de log legítimas (inclusive erros reais). Agora só loga no máximo
// 1 vez a cada 10 minutos, não importa quantas sessões estejam sem horário.
let _ultimoAvisoSemTimestampInbox = 0;

function normalizarSessaoParaInbox(telefone, sessao) {
  const historicoNormalizado = Array.isArray(sessao?.historico) ? sessao.historico.map(normalizarEventoHistorico) : [];

  // REMOVIDO: interpolação de timestampMs (média entre vizinhos) para mensagens sem
  // hora real, e a gravação desse valor "adivinhado" de volta na sessão em memória.
  // Essa era a fonte mais frequente de horários/datas errados na tela: essa função
  // roda a cada consulta do painel (a cada 5s), e o valor inventado, uma vez escrito
  // de volta em sessao.historico[i].timestampMs, ficava indistinguível de um
  // timestamp real — e depois era salvo no Sheets pelo salvamento periódico como se
  // fosse verdadeiro, corrompendo os dados de forma permanente. A pedido, o sistema
  // não deve mostrar (nem guardar) hora inventada como se fosse real: mensagem sem
  // timestamp real simplesmente fica sem horário até chegar uma mensagem nova de
  // verdade.
  if (historicoNormalizado.length && historicoNormalizado.every(m => !(Number(m.timestampMs) > 0))) {
    const agora = Date.now();
    if (agora - _ultimoAvisoSemTimestampInbox > 10 * 60 * 1000) {
      _ultimoAvisoSemTimestampInbox = agora;
      console.warn(`[timestamp] Há sessões sem nenhuma mensagem com timestamp real (ex.: ${telefone}). Aviso agrupado — só aparece 1x a cada 10min mesmo com várias sessões afetadas.`);
    }
  }

  // Ordena por timestamp real quando os DOIS lados têm; quando um dos dois (ou os
  // dois) não tem timestamp real, mantém a ordem original de chegada em vez de
  // jogar pro início da lista (0 sempre seria "menor" que qualquer hora real).
  historicoNormalizado.forEach((m, i) => { m._ordemOriginal = i; });
  historicoNormalizado.sort((a, b) => {
    const msA = Number(a.timestampMs || 0), msB = Number(b.timestampMs || 0);
    if (msA > 0 && msB > 0) return msA - msB;
    return a._ordemOriginal - b._ordemOriginal;
  });
  historicoNormalizado.forEach(m => { delete m._ordemOriginal; });

  const ultima = historicoNormalizado[historicoNormalizado.length - 1] || null;
  // FIX: se o historico voltou do Sheets sem hora nenhuma, usa o lastMessageAtMs
  // gravado na propria sessao (persistido no Volume/Sheets) — sem isso a conversa
  // ficava com ms=0, sem hora na lista e fora de ordem.
  const lastMessageAtMs = Number(ultima?.timestampMs || 0) || sanearTimestampMs(sessao?.lastMessageAtMs) || 0;
  const unreadCount = calcularUnreadSessao(sessao);

  // FIX: estilo WhatsApp de verdade — HH:MM SO se a ultima mensagem foi HOJE;
  // "Ontem", dia da semana ou dd/mm/aaaa para dias anteriores. Antes mandava sempre
  // HH:MM, entao conversa de 3 semanas atras aparecia na lista como se fosse de hoje.
  const horaFormatadaWhatsApp = lastMessageAtMs ? formatarDataWhatsApp(lastMessageAtMs) : '';

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
    dataWhatsapp: horaFormatadaWhatsApp,
    formattedLastMessageAt: horaFormatadaWhatsApp,
    unreadCount,
    semResposta: ultima?.role === "user",
    raiox: Array.isArray(sessao?.raiox) ? sessao.raiox.slice(-5) : [],
    vagaInteresseDeclarado: sessao?.vagaInteresseDeclarado || "",
    aceiteVaga: sessao?.aceiteVaga || false
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
  seguranca: [
    "vigilante", "vigilância", "vigilancia", "seguranca patrimonial", "segurança patrimonial",
    "curso de vigilante", "formacao de vigilante", "formação de vigilante",
    "agente de seguranca", "agente de segurança", "monitoramento", "ronda", "portaria armada"
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
  const areas = ["seguranca", "logistica", "administrativo", "operacional", "projetos", "alimentos", "limpeza", "vendas", "rh"];
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

// Busca automática no Drive quando o arquivo local não existe mais (ex: após
// reinício do Railway). Procura por telefone (mais confiável, sempre presente
// no nome do arquivo) e, se não achar, pelo nome do candidato.
async function buscarCurriculoNoDriveAutomaticamente(telefone, nomeCandidato) {
  const drive = getDriveClient();
  if (!drive) {
    console.error(`[Drive] Busca automática abortada para ${telefone}: getDriveClient() retornou null — verifique GOOGLE_SERVICE_ACCOUNT_JSON no Railway.`);
    return null;
  }
  // Ampliado: tenta várias variações do telefone (com/sem DDI 55, só os últimos
  // dígitos) e o primeiro nome isolado — nomes/telefones salvos em épocas
  // diferentes do sistema nem sempre batem 100% com o formato atual.
  const telLimpo = String(telefone || "").replace(/\D/g, "");
  const variacoesTel = [
    telLimpo,
    telLimpo.startsWith("55") ? telLimpo.slice(2) : null,
    telLimpo.length > 9 ? telLimpo.slice(-9) : null,
    telLimpo.length > 8 ? telLimpo.slice(-8) : null,
  ].filter(Boolean);
  const primeiroNome = nomeCandidato ? String(nomeCandidato).trim().split(/\s+/)[0] : null;
  const termos = [...new Set([...variacoesTel, nomeCandidato, primeiroNome].filter(Boolean))];

  for (const termoBruto of termos) {
    try {
      const termo = String(termoBruto).replace(/'/g, "\\'").trim();
      if (!termo || termo.length < 3) continue; // termo curto demais gera falso positivo
      const r = await drive.files.list({
        q: `name contains '${termo}' and trashed = false`,
        fields: "files(id, name, webViewLink)",
        pageSize: 5,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      const arquivo = r.data.files?.[0];
      if (arquivo) {
        return { id: arquivo.id, link: arquivo.webViewLink || `https://drive.google.com/file/d/${arquivo.id}/view`, nome: arquivo.name };
      }
    } catch (e) {
      console.error(`[Drive] Busca automática falhou pro termo "${termoBruto}" (telefone ${telefone}):`, e.message);
    }
  }
  console.warn(`[Drive] Nenhum currículo encontrado automaticamente pra ${nomeCandidato || telefone} (termos tentados: ${termos.join(", ")}).`);
  return null;
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
    const payload = JSON.stringify({ acao: "salvarConversaCompleta", telefone, nome: nome || "", historico: historico || [], modo: sessaoAtualSheets.modo || "automatico", pausado: sessaoAtualSheets.pausado || false, motivoPausa: sessaoAtualSheets.motivoPausa || "", unreadCount: Number(sessaoAtualSheets.unreadCount || 0), lastMessageAtMs: Number(sessaoAtualSheets.lastMessageAtMs || 0), curriculos: curriculosMeta, curriculo: curriculosMeta[0] || null, discResult: sessaoAtualSheets.discResult || null, timestamp: agora(), timestampISO: agoraISO(), timestampMs: Date.now() });
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
        const histBackup = (s.historico || []).map(normalizarEventoHistorico);
        sessoes[tel] = {
          historico: histBackup,
          lastMessageAtMs: Number(s.lastMessageAtMs || 0) || Number(histBackup[histBackup.length - 1]?.timestampMs || 0),
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
// ─── LEITOR DIRETO DO GOOGLE SHEETS (fallback sem Apps Script) ───
let sheetsClient = null;
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const credentials = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });
    sheetsClient = google.sheets({ version: "v4", auth });
    return sheetsClient;
  } catch(e) { console.error("getSheetsClient:", e.message); return null; }
}

async function carregarSessoesViaAPI() {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) { console.log("Sheets API: sem credenciais"); return 0; }

    // Descobre o nome da aba pelo gid
    const meta = await sheets.spreadsheets.get({ spreadsheetId: CONFIG.SHEETS_ID });
    const aba = meta.data.sheets.find(s => String(s.properties.sheetId) === "1932944674")
                 || meta.data.sheets[0];
    const nomAba = aba.properties.title;
    console.log(`[Sheets API] Lendo aba: ${nomAba}`);

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SHEETS_ID,
      range: `${nomAba}!A1:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) { console.log("[Sheets API] Planilha vazia"); return 0; }

    const headers = rows[0].map(h => (h||'').toLowerCase().trim());
    const idxTel    = headers.findIndex(h => h.includes('telefone') || h.includes('phone') || h === 'tel');
    const idxNome   = headers.findIndex(h => h.includes('nome') || h.includes('name'));
    const idxHist   = headers.findIndex(h => h.includes('historico') || h.includes('histórico') || h.includes('history'));
    const idxModo   = headers.findIndex(h => h === 'modo' || h === 'mode');
    const idxPaus   = headers.findIndex(h => h.includes('pausado') || h.includes('paused'));
    const idxMotiv  = headers.findIndex(h => h.includes('motivo') || h.includes('reason'));
    const idxDisc   = headers.findIndex(h => h.includes('disc'));
    const idxAnalise= headers.findIndex(h => h.includes('analise') || h.includes('análise'));
    const idxCurric = headers.findIndex(h => h.includes('curriculo') || h.includes('curriculos'));

    console.log(`[Sheets API] Headers: ${JSON.stringify(headers)}`);
    console.log(`[Sheets API] tel=${idxTel} nome=${idxNome} hist=${idxHist}`);

    if (idxTel < 0) { console.log("[Sheets API] Coluna telefone não encontrada"); return 0; }

    let n = 0;
    rows.slice(1).forEach(row => {
      const tel = limparTelefone(row[idxTel] || '');
      if (!tel || tel.length < 8) return;
      if (sessoes[tel]) return; // já carregado do Volume
      let historico = [];
      if (idxHist >= 0 && row[idxHist]) {
        try { historico = JSON.parse(row[idxHist]); } catch(e) {}
      }
      historico = Array.isArray(historico) ? historico.map(normalizarEventoHistorico) : [];
      let discResult = null;
      if (idxDisc >= 0 && row[idxDisc]) {
        try { discResult = JSON.parse(row[idxDisc]); } catch(e) {}
      }
      let ultimaAnalise = null;
      if (idxAnalise >= 0 && row[idxAnalise]) {
        try { ultimaAnalise = JSON.parse(row[idxAnalise]); } catch(e) {}
      }
      let curriculos = [];
      if (idxCurric >= 0 && row[idxCurric]) {
        try {
          const cv = JSON.parse(row[idxCurric]);
          curriculos = Array.isArray(cv) ? cv : (cv ? [cv] : []);
        } catch(e) {}
      }
      const modo = (idxModo >= 0 ? row[idxModo] : '') || 'automatico';
      const pausado = idxPaus >= 0 ? row[idxPaus] === 'true' || row[idxPaus] === true : false;
      sessoes[tel] = {
        historico,
        lastMessageAtMs: Number(historico[historico.length - 1]?.timestampMs || 0),
        nome: (idxNome >= 0 ? row[idxNome] : '') || null,
        modo,
        pausado,
        motivoPausa: (idxMotiv >= 0 ? row[idxMotiv] : '') || '',
        unreadCount: 0,
        discResult,
        ultimaAnalise,
        curriculos,
        curriculo: curriculos[0] || null
      };
      if (pausado) atendimentosManuais.add(tel);
      n++;
    });
    console.log(`[Sheets API] ${n} sessões carregadas diretamente`);
    return n;
  } catch(e) {
    console.error("[Sheets API] Erro:", e.message);
    return 0;
  }
}

function chaveEventoHistorico(ev) {
  return `${ev?.role || ""}|${String(ev?.content || "").trim().slice(0, 300)}`;
}

// Junta o historico em MEMORIA (timestamps reais do WhatsApp) com o da PLANILHA
// (mais completo, mas que muitas vezes volta sem hora). Regras:
// 1) Base = versao da planilha (tem o historico antigo completo).
// 2) Evento da planilha SEM hora recupera a hora da memoria apenas quando a
//    mensagem e inequivoca (mesmo role+conteudo aparecendo UMA unica vez nos dois
//    lados) — evita o bug antigo de trocar horarios entre varias msgs "oi" iguais.
// 3) Mensagens que so existem na memoria (chegaram depois do ultimo salvamento no
//    Sheets) sao preservadas em vez de descartadas pela recarga.
function mesclarHistoricos(memoria, planilha) {
  const mem = Array.isArray(memoria) ? memoria : [];
  const pla = Array.isArray(planilha) ? planilha : [];
  if (!mem.length) return pla;
  if (!pla.length) return mem;

  const contMem = new Map(), contPla = new Map();
  mem.forEach(ev => { const k = chaveEventoHistorico(ev); contMem.set(k, (contMem.get(k) || 0) + 1); });
  pla.forEach(ev => { const k = chaveEventoHistorico(ev); contPla.set(k, (contPla.get(k) || 0) + 1); });

  const horaUnicaMem = new Map();
  mem.forEach(ev => {
    const k = chaveEventoHistorico(ev);
    if (contMem.get(k) === 1 && Number(ev.timestampMs) > 0) horaUnicaMem.set(k, Number(ev.timestampMs));
  });

  const base = pla.map(ev => {
    if (Number(ev?.timestampMs) > 0) return ev;
    const k = chaveEventoHistorico(ev);
    if (contPla.get(k) === 1 && horaUnicaMem.has(k)) {
      const ms = horaUnicaMem.get(k);
      const iso = new Date(ms).toISOString();
      return { ...ev, timestampMs: ms, timestampISO: iso, timestamp: iso,
        horario: new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        horarioFormatado: formatarDataWhatsApp(ms) };
    }
    return ev;
  });

  // Preserva mensagens que so existem na memoria (ex: chegaram nos ultimos minutos)
  const usados = new Map();
  const faltantes = [];
  mem.forEach(ev => {
    const k = chaveEventoHistorico(ev);
    const u = (usados.get(k) || 0) + 1;
    usados.set(k, u);
    if (u > (contPla.get(k) || 0)) faltantes.push(ev);
  });

  const resultado = base.concat(faltantes);
  resultado.forEach((m, i) => { m._ordem = i; });
  resultado.sort((a, b) => {
    const ma = Number(a.timestampMs || 0), mb = Number(b.timestampMs || 0);
    if (ma > 0 && mb > 0 && ma !== mb) return ma - mb;
    return a._ordem - b._ordem;
  });
  resultado.forEach(m => { delete m._ordem; });
  return resultado.slice(-500);
}

async function carregarSessoesDoSheets() {
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=conversas`, { timeout: 45000, maxRedirects: 5 });
    const data = r.data;
    if (!data.sucesso || !data.sessoes) return;

    // Contador agregado (em vez de 1 console.warn por sessão sem horário — com
    // muitas sessões isso gerava uma rajada de centenas de linhas de log de uma
    // vez, estourando o limite de logs/segundo do Railway e derrubando linhas
    // de log legítimas junto — inclusive erros reais que poderiam aparecer no
    // mesmo instante).
    let _semTimestampCount = 0;
    let _semTimestampTotal = 0;

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

      // IMPORTANTE: não inventamos mais horário nenhum aqui — nem "agora", nem
      // interpolado/aproximado por posição, nem reaproveitado por "mensagem parecida"
      // (role+conteúdo). Esse reaproveitamento por conteúdo causava troca de horário
      // entre mensagens idênticas (ex: várias mensagens "oi" do mesmo candidato
      // recebiam horários errados umas das outras a cada sincronização), e o horário
      // "inventado" ficava sendo salvo de volta no Sheets como se fosse real,
      // corrompendo os dados permanentemente. Mensagem sem timestamp real definido
      // em normalizarEventoHistorico() simplesmente fica sem horário (timestampMs: 0)
      // até chegar uma mensagem nova de verdade — mostrar nada é melhor que mostrar
      // errado.
      if (historicoNorm.length && historicoNorm.every(m => !(Number(m.timestampMs) > 0))) {
        _semTimestampCount++;
        _semTimestampTotal += historicoNorm.length;
      }

      // FIX PRINCIPAL: MESCLA em vez de SUBSTITUIR. Antes, cada recarga do Sheets
      // (no deploy e a cada 30 min) jogava fora o historico em memoria — que tem os
      // timestamps REAIS do WhatsApp — e ficava so com a versao da planilha (que
      // muitas vezes volta sem hora). Era por isso que os horarios "sumiam depois
      // de cada deploy" e mensagens recentes podiam desaparecer da tela.
      const historicoMesclado = mesclarHistoricos(existente.historico || [], historicoNorm);
      const ultimoMesclado = historicoMesclado[historicoMesclado.length - 1];
      const lastMsSessao = Math.max(
        sanearTimestampMs(existente.lastMessageAtMs),
        sanearTimestampMs(sessao.lastMessageAtMs),
        Number(ultimoMesclado?.timestampMs || 0)
      ) || 0;

      sessoes[tel] = {
        historico: historicoMesclado,
        lastMessageAtMs: lastMsSessao,
        nome: sessao.nome || existente.nome || null,
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

    if (_semTimestampCount > 0) {
      console.warn(`[timestamp] ${_semTimestampCount} sessão(ões) sem nenhuma mensagem com timestamp real (${_semTimestampTotal} msgs no total). Vão aparecer sem horário até chegar msg nova com timestamp real.`);
    }

    console.log(`Sessões carregadas do Sheets: ${Object.keys(data.sessoes).length}`);
  } catch (e) {
    console.error("Erro carregarSessoesDoSheets:", e.message);
  }
}

const SESSOES_LOCAL_PATH = process.env.SESSOES_LOCAL_PATH || "/data/sessoes-local.json";

function salvarSessoesLocal() {
  try {
    const dir = require("path").dirname(SESSOES_LOCAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const compacto = {};
    Object.entries(sessoes).forEach(([tel, s]) => {
      compacto[tel] = {
        nome: s.nome,
        modo: s.modo,
        pausado: s.pausado,
        motivoPausa: s.motivoPausa,
        unreadCount: s.unreadCount || 0,
        discResult: s.discResult || null,
        ultimaAnalise: s.ultimaAnalise || null,
        lastMessageAtMs: Number(s.lastMessageAtMs || 0),
        historico: (s.historico || []).slice(-120),
        curriculos: s.curriculos || [],
        curriculo: s.curriculo || null
      };
    });
    fs.writeFileSync(SESSOES_LOCAL_PATH, JSON.stringify({ ts: Date.now(), sessoes: compacto }), "utf8");
  } catch(e) { console.error("salvarSessoesLocal:", e.message); }
}

function carregarSessoesLocal() {
  try {
    if (!fs.existsSync(SESSOES_LOCAL_PATH)) return 0;
    const raw = JSON.parse(fs.readFileSync(SESSOES_LOCAL_PATH, "utf8"));
    if (!raw.sessoes) return 0;
    let n = 0;
    Object.entries(raw.sessoes).forEach(([tel, s]) => {
      if (!sessoes[tel]) {
        const histLocal = (s.historico || []).map(normalizarEventoHistorico);
        sessoes[tel] = {
          historico: histLocal,
          lastMessageAtMs: Number(s.lastMessageAtMs || 0) || Number(histLocal[histLocal.length - 1]?.timestampMs || 0),
          nome: s.nome || null,
          modo: s.modo || "automatico",
          pausado: s.pausado || false,
          motivoPausa: s.motivoPausa || "",
          unreadCount: Number(s.unreadCount || 0),
          discResult: s.discResult || null,
          ultimaAnalise: s.ultimaAnalise || null,
          curriculos: s.curriculos || [],
          curriculo: s.curriculo || null
        };
        if (s.pausado) atendimentosManuais.add(tel);
        n++;
      }
    });
    return n;
  } catch(e) { console.error("carregarSessoesLocal:", e.message); return 0; }
}
let inboxDataCache = null;

function lerDadosInbox() {
  try {
    if (!fs.existsSync(INBOX_DATA_PATH)) return null;
    const raw = fs.readFileSync(INBOX_DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch(e) { console.error("lerDadosInbox:", e.message); return null; }
}

function gravarDadosInbox(dados) {
  try {
    // Garantir que o diretório existe
    const dir = require("path").dirname(INBOX_DATA_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INBOX_DATA_PATH, JSON.stringify(dados), "utf8");
    return true;
  } catch(e) { console.error("gravarDadosInbox:", e.message); return false; }
}

// Carregar n
// ── STARTUP: 1) Volume local (rápido) → 2) Sheets em background ──
const localCount = carregarSessoesLocal();
console.log(`[startup] Sessões carregadas do Volume local: ${localCount}`);

// Flag usada pra avisar quando uma consulta (ex: busca de currículo) acontece
// ANTES da sincronização inicial terminar — nesse intervalo, dados de sessões
// mais antigas podem estar incompletos, gerando falsos "não encontrado".
let sincronizacaoInicialCompleta = false;

carregarSessoesDoSheets().then(async () => {
  let total = Object.keys(sessoes).length;
  console.log(`Sessões carregadas do Sheets: ${total}`);
  if (total < 10) {
    console.log("Apps Script lento — tentando Sheets API direta...");
    const n = await carregarSessoesViaAPI();
    total = Object.keys(sessoes).length;
    if (total < 10) {
      console.log("Poucas sessões — tentando restaurar do backup Drive...");
      await restaurarDoUltimoBackup();
    }
  }
  // Salva no Volume logo após carregar
  if (Object.keys(sessoes).length > 0) salvarSessoesLocal();
  setTimeout(() => fazerBackup("startup"), 10 * 1000);
  sincronizacaoInicialCompleta = true;
  console.log("[startup] Sincronização inicial completa.");
}).catch(e => { console.error("Erro na inicialização:", e.message); sincronizacaoInicialCompleta = true; });
setInterval(() => fazerBackup("diario"), 2 * 60 * 60 * 1000);

// Recarga automática periódica do Sheets — antes só recarregava quando o servidor
// ligava, então qualquer correção feita na planilha/Apps Script só entrava em vigor
// depois de reiniciar o Railway ou clicar manualmente em "Recarregar do Sheets".
// Agora recarrega sozinho a cada 30 minutos, sem precisar de nenhuma ação manual.
setInterval(() => {
  console.log("[auto-sync] Recarregando sessões do Sheets automaticamente...");
  carregarSessoesDoSheets().catch(e => console.error("[auto-sync] Falha:", e.message));
}, 30 * 60 * 1000);

// Salvamento periódico — em paralelo e só para sessões com mudança desde o último ciclo.
// (antes era sequencial para TODAS as sessões, com timeout de 20s cada — sob carga isso
// sozinho ultrapassava o intervalo de 5min e sobrecarregava o servidor, derrubando
// também as chamadas à API da Claude.)
const ultimoSaveSessao = {};

// Salva sessões no Volume a cada 5 minutos (independente do Sheets)
setInterval(salvarSessoesLocal, 5 * 60 * 1000);

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
        lastMessageAtMs: Number(s.lastMessageAtMs || 0),
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

// ─── RECARREGAR SESSÕES DO SHEETS MANUALMENTE ───
// ─── LIMPEZA: apaga timestamps já gravados errado (datas futuras impossíveis /
// "Invalid Date") de conversas antigas, de antes da correção do bug de
// invenção de horário. Roda uma vez (ou quando quiser), varre TODAS as sessões
// em memória, zera qualquer timestampMs que esteja mais de 7 dias no futuro
// (tolerância de clock skew) ou que não seja um número válido, e regrava cada
// sessão já limpa de volta no Sheets — assim a lista de conversas para de
// mostrar datas absurdas tipo dezembro/2026 pra mensagens antigas. Mensagens
// que ficarem sem timestamp aparecem em branco (não errado) até uma msg nova
// de verdade chegar.
app.get("/inbox/limpar-timestamps-invalidos", async (req, res) => {
  try {
    const LIMITE_FUTURO_MS = Date.now() + 7 * 24 * 60 * 60 * 1000;
    let sessoesAfetadas = 0;
    let msgsLimpas = 0;
    const telefonesParaSalvar = [];

    for (const [tel, sessao] of Object.entries(sessoes)) {
      if (!Array.isArray(sessao.historico) || !sessao.historico.length) continue;
      let mudou = false;
      sessao.historico.forEach(m => {
        if (!m.timestampMs) return; // já sem timestamp, nada a limpar
        const ms = Number(m.timestampMs);
        const dataInvalida = !Number.isFinite(ms) || ms > LIMITE_FUTURO_MS;
        if (dataInvalida) {
          m.timestampMs = 0;
          m.timestamp = "";
          m.timestampISO = "";
          m.horario = "";
          m.horarioFormatado = "";
          mudou = true;
          msgsLimpas++;
        }
      });
      if (mudou) {
        sessoesAfetadas++;
        telefonesParaSalvar.push(tel);
      }
    }

    // Regrava no Sheets, em lotes pequenos pra não sobrecarregar o Apps Script
    for (let i = 0; i < telefonesParaSalvar.length; i += 5) {
      const lote = telefonesParaSalvar.slice(i, i + 5);
      await Promise.allSettled(lote.map(tel =>
        salvarConversaCompletaSheets(tel, sessoes[tel].historico, sessoes[tel].nome)
      ));
    }

    if (sessoesAfetadas > 0) salvarSessoesLocal();

    return res.json({
      ok: true,
      sessoesAfetadas,
      msgsLimpas,
      msg: sessoesAfetadas > 0
        ? `${msgsLimpas} mensagens com data inválida foram limpas em ${sessoesAfetadas} conversas.`
        : "Nenhuma data inválida encontrada."
    });
  } catch (e) {
    return res.json({ ok: false, erro: e.message });
  }
});

app.get("/inbox/recarregar", async (req, res) => {
  try {
    const antes = Object.keys(sessoes).length;
    await carregarSessoesDoSheets();
    let depois = Object.keys(sessoes).length;
    if (depois === 0) {
      console.log("[recarregar] Apps Script falhou — tentando Sheets API direta...");
      await carregarSessoesViaAPI();
      depois = Object.keys(sessoes).length;
    }
    if (depois === 0) {
      await restaurarDoUltimoBackup();
    }
    if (Object.keys(sessoes).length > 0) salvarSessoesLocal();
    const final = Object.keys(sessoes).length;
    return res.json({
      ok: true,
      antes,
      depois: final,
      vagasUrl: CONFIG.VAGAS_URL ? 'configurada' : 'NÃO CONFIGURADA',
      msg: final > 0 ? `${final} sessões carregadas com sucesso` : 'Nenhuma sessão carregada — verifique VAGAS_URL e o Apps Script'
    });
  } catch(e) {
    return res.json({ ok: false, erro: e.message });
  }
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
      // BUG CRÍTICO CORRIGIDO: antes, o botão "IA OFF" (geminiAtivo=false) não tinha
      // nenhum efeito aqui — o currículo era analisado pelo Gemini e a mensagem com a
      // vaga sugerida era enviada ao candidato mesmo com a IA desligada. Agora, IA OFF
      // é tratado como modo manual: o currículo é salvo, mas nada é enviado sozinho.
      const modoSilencioso = emManual || !geminiAtivo;
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

      if (!modoSilencioso) {
        await enviarMensagem(from, "Perfeito, recebi seu currículo. 💙");
      } else {
        console.log(`CURRÍCULO RECEBIDO EM MODO SILENCIOSO (manual=${emManual}, iaOff=${!geminiAtivo}) — salvando sem responder:`, from);
      }

      const resposta = await processarCurriculo(from, message.document, { silencioso: modoSilencioso, timestampMs: messageTimestampMs });
      if (!modoSilencioso && resposta) await enviarMensagem(from, resposta);
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

// Banco de Talentos: lê do Volume (statusMap persistido pelo browser) + enriquece com sessoes
app.get("/sheets/banco-talentos", (req, res) => {
  try {
    const cache = inboxDataCache || lerDadosInbox() || {};
    const statusMap = cache.statusMap || {};
    const metaDados = cache.metaDados || {};
    const notas = cache.notas || {};

    // Pega todos com status "Banco de Talentos" do Volume (fonte confiável)
    const tels = Object.entries(statusMap)
      .filter(([, st]) => st === "Banco de Talentos")
      .map(([tel]) => tel);

    const banco = tels.map(tel => {
      const s = sessoes[tel] || {};
      const m = metaDados[tel] || {};
      return {
        telefone: tel,
        nome: s.nome || s.ultimaAnalise?.nome || m.nome || "",
        cargo: s.ultimaAnalise?.vagaInteresse || s.vagaInteresse || m.cargo || "",
        cidade: s.ultimaAnalise?.cidade || s.cidade || m.cidade || "",
        driveLink: s.curriculo?.driveLink || s.ultimaAnalise?.curriculoDriveLink || m.driveLink || "",
        perfilResumido: s.ultimaAnalise?.perfilResumido || s.ultimaAnalise?.motivoMatch || m.perfil || "",
        discPrimario: s.discResult?.primario || m.disc || "",
        notaInterna: notas[tel] || "",
        dataEntrada: m.dataBanco || s.dataBanco || new Date().toLocaleDateString("pt-BR")
      };
    });

    res.json({ ok: true, total: banco.length, candidatos: banco, fonte: "volume" });
  } catch(e) {
    res.json({ ok: false, erro: e.message, candidatos: [] });
  }
});
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
  // IA OFF: o botao "Resumir" chamava o Gemini DIRETO, furando o modo emergencia.
  if (!geminiAtivo) return res.json({ ok: false, erro: "IA desligada (IA OFF) — reative a IA para gerar resumos." });
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

// ── ENVIO EM LOTE — mesma mensagem para varias conversas ────────────────────
// Roda em SEGUNDO PLANO no servidor (~1 msg/seg), registra no historico de cada
// sessao e nao depende do navegador ficar aberto.
// Acompanhe em GET /inbox/enviar-lote/status.
let loteEnvio = { rodando: false, total: 0, enviadas: 0, falhas: 0, foraJanela: 0, iniciadoEm: null, terminadoEm: null, ultimoErro: "" };

app.get("/inbox/enviar-lote/status", (req, res) => res.json({ ok: true, ...loteEnvio }));

// Motor compartilhado pelo envio em lote comum e pela Mensagem SOS.
function iniciarEnvioLote(telefones, mensagem, opts = {}) {
  loteEnvio = { rodando: true, total: telefones.length, enviadas: 0, falhas: 0, foraJanela: 0, iniciadoEm: new Date().toISOString(), terminadoEm: null, ultimoErro: "" };

  (async () => {
    for (const tel of telefones) {
      try {
        await enviarMensagem(tel, mensagem);
        const sessao = garantirSessao(tel);
        if (opts.assumirManual) {
          atendimentosManuais.add(tel);
          sessao.modo = "manual";
          sessao.pausado = true;
          sessao.motivoPausa = sessao.motivoPausa || "Atendimento assumido manualmente";
        }
        registrarEntradaSessao(sessao, "assistant", mensagem);
        marcarConversaRespondida(sessao);
        sessao.historico = sessao.historico.slice(-500);
        salvarMensagemSheets(tel, "assistant", mensagem, sessao.nome || "").catch(() => {});
        loteEnvio.enviadas++;
        if (opts.aoEnviar) { try { opts.aoEnviar(tel); } catch (_) {} }
      } catch (e) {
        // Erro 131047 da Meta = candidato fora da janela de 24h (mensagem livre
        // nao e permitida). Opcionalmente cai para o template aprovado.
        const foraJanela = String(e.message || "").includes("131047") || String(e.message || "").toLowerCase().includes("re-engagement");
        if (foraJanela) loteEnvio.foraJanela++;
        if (foraJanela && opts.templateFallback) {
          const t = await enviarTemplate(tel);
          if (t.sucesso) {
            const sessao = garantirSessao(tel);
            registrarEntradaSessao(sessao, "assistant", "[Template de reengajamento enviado]");
            sessao.historico = sessao.historico.slice(-500);
            loteEnvio.enviadas++;
            if (opts.aoEnviar) { try { opts.aoEnviar(tel); } catch (_) {} }
          } else {
            loteEnvio.falhas++;
            loteEnvio.ultimoErro = `${tel}: template falhou — ${t.erro}`;
          }
        } else {
          loteEnvio.falhas++;
          loteEnvio.ultimoErro = `${tel}: ${e.message}`;
          console.error("[enviar-lote] Falha:", tel, e.message);
        }
      }
      await sleep(1100);
    }
    loteEnvio.rodando = false;
    loteEnvio.terminadoEm = new Date().toISOString();
    console.log(`[enviar-lote] Concluído: ${loteEnvio.enviadas} enviadas, ${loteEnvio.falhas} falhas (${loteEnvio.foraJanela} fora da janela 24h) de ${loteEnvio.total}.`);
    if (opts.aoTerminar) { try { opts.aoTerminar(loteEnvio); } catch (_) {} }
  })().catch(e => {
    loteEnvio.rodando = false;
    loteEnvio.terminadoEm = new Date().toISOString();
    console.error("[enviar-lote] Erro fatal:", e.message);
  });
}

app.post("/inbox/enviar-lote", (req, res) => {
  const telefones = Array.isArray(req.body.telefones)
    ? [...new Set(req.body.telefones.map(limparTelefone).filter(t => t && t.length >= 8))]
    : [];
  const mensagem = String(req.body.mensagem || "").trim();
  if (!telefones.length || !mensagem) return res.json({ ok: false, erro: "Informe telefones e mensagem" });
  if (loteEnvio.rodando) return res.json({ ok: false, erro: `Já existe um envio em andamento (${loteEnvio.enviadas + loteEnvio.falhas}/${loteEnvio.total}). Aguarde terminar.` });

  iniciarEnvioLote(telefones, mensagem, {
    assumirManual: req.body.assumirManual === true,
    templateFallback: req.body.templateFallback === true
  });
  res.json({ ok: true, total: telefones.length });
});

// ── MENSAGEM SOS ─────────────────────────────────────────────────────────────
// Texto fixo salvo no servidor (Volume) + fila com memoria: quem ja recebeu a
// SOS NUNCA recebe de novo. Permite mandar "um pouco por dia" com seguranca —
// protege a nota de qualidade do numero na Meta.
const SOS_PATH = process.env.SOS_PATH || "/data/sos-config.json";

function lerSos() {
  try {
    if (fs.existsSync(SOS_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(SOS_PATH, "utf8"));
      return { texto: cfg.texto || "", enviados: cfg.enviados || {} };
    }
  } catch (e) { console.error("lerSos:", e.message); }
  return { texto: "", enviados: {} };
}

function gravarSos(cfg) {
  try {
    const dir = require("path").dirname(SOS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SOS_PATH, JSON.stringify(cfg), "utf8");
    return true;
  } catch (e) { console.error("gravarSos:", e.message); return false; }
}

// Estado atual: texto salvo + quantos ja receberam
app.get("/inbox/sos", (req, res) => {
  const cfg = lerSos();
  res.json({ ok: true, texto: cfg.texto, totalEnviados: Object.keys(cfg.enviados).length, loteRodando: loteEnvio.rodando });
});

// Salva/edita o texto da Mensagem SOS
app.post("/inbox/sos/salvar", (req, res) => {
  const texto = String(req.body.texto || "").trim();
  if (!texto) return res.json({ ok: false, erro: "Texto vazio" });
  const cfg = lerSos();
  cfg.texto = texto;
  res.json({ ok: gravarSos(cfg) });
});

// Dispara o lote do dia: pega ate N telefones da fila que AINDA NAO receberam
app.post("/inbox/sos/enviar", (req, res) => {
  const cfg = lerSos();
  const texto = String(req.body.texto || cfg.texto || "").trim();
  if (!texto) return res.json({ ok: false, erro: "Salve a Mensagem SOS primeiro" });
  if (loteEnvio.rodando) return res.json({ ok: false, erro: `Já existe um envio em andamento (${loteEnvio.enviadas + loteEnvio.falhas}/${loteEnvio.total}). Aguarde terminar.` });

  const quantidade = Math.max(1, Math.min(500, Number(req.body.quantidade || 50)));
  const pool = Array.isArray(req.body.telefones) && req.body.telefones.length
    ? req.body.telefones.map(limparTelefone)
    : Object.keys(sessoes);
  const fila = [...new Set(pool.filter(t => t && t.length >= 8 && !cfg.enviados[t]))];
  const doDia = fila.slice(0, quantidade);
  if (!doDia.length) return res.json({ ok: false, erro: "Ninguém pendente — todos desse grupo já receberam a Mensagem SOS." });

  cfg.texto = texto;
  gravarSos(cfg);

  iniciarEnvioLote(doDia, texto, {
    assumirManual: req.body.assumirManual === true,
    templateFallback: req.body.templateFallback === true,
    aoEnviar: (tel) => { cfg.enviados[tel] = Date.now(); gravarSos(cfg); }
  });

  res.json({ ok: true, total: doDia.length, restantes: fila.length - doDia.length, jaReceberam: Object.keys(cfg.enviados).length });
});

// Zera a memoria de quem ja recebeu (para uma campanha nova)
app.post("/inbox/sos/zerar", (req, res) => {
  const cfg = lerSos();
  cfg.enviados = {};
  res.json({ ok: gravarSos(cfg) });
});

// Função compartilhada: localiza o currículo (local, Sheets, ou busca automática no
// Drive) e devolve OU um link pra abrir OU null. Não escreve na resposta — quem
// chama decide o que fazer (redirecionar, servir o arquivo, ou responder JSON).
async function localizarCurriculo(tel, idxSolicitado) {
  let sessao = sessoes[tel];
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
    // BUG CORRIGIDO: quando não havia nada em "curriculos"/"curriculo", o código pulava
    // direto pra busca automática no Drive sem checar o link salvo em ultimaAnalise
    // (que é preenchido pela análise de IA e costuma existir mesmo quando o array de
    // curriculos não sincronizou). Isso causava falsos negativos em massa — candidatos
    // com currículo perfeitamente disponível apareciam como "não encontrado".
    const dlAnalise = sessao?.ultimaAnalise?.curriculoDriveLink || sessao?.ultimaAnalise?.linkCurriculo || "";
    if (dlAnalise) return { ok: true, tipo: "link", link: dlAnalise, nomeCandidato: sessao?.nome || tel };
    const achado = await buscarCurriculoNoDriveAutomaticamente(tel, sessao?.nome);
    if (achado) return { ok: true, tipo: "link", link: achado.link, nomeCandidato: sessao?.nome || tel };
    // Currículo recebido há pouco tempo (menos de 2 min): o upload pro Drive roda em
    // background com até 3 tentativas — pode simplesmente ainda não ter terminado.
    const ultimaMsgMs = Number(sessao?.lastMessageAtMs || 0);
    const recemChegado = ultimaMsgMs > 0 && (Date.now() - ultimaMsgMs) < 2 * 60 * 1000;
    return { ok: false, nomeCandidato: sessao?.nome || tel, podeEstarProcessando: recemChegado };
  }

  const idx = Math.max(0, Math.min(Number(idxSolicitado || 0), lista.length - 1));
  const cv = lista[idx];

  if (cv?.driveLink) return { ok: true, tipo: "link", link: cv.driveLink, nomeCandidato: sessao?.nome || tel };

  let buffer = null;
  if (cv?.base64) buffer = Buffer.from(cv.base64, "base64");
  else if (cv?.localPath && fs.existsSync(cv.localPath)) buffer = fs.readFileSync(cv.localPath);

  if (buffer) return { ok: true, tipo: "arquivo", buffer, mimeType: cv.mimeType, filename: cv.filename, nomeCandidato: sessao?.nome || tel };

  const dlFallback = sessao?.ultimaAnalise?.curriculoDriveLink || sessao?.ultimaAnalise?.linkCurriculo || "";
  if (dlFallback) return { ok: true, tipo: "link", link: dlFallback, nomeCandidato: sessao?.nome || tel };

  const achado = await buscarCurriculoNoDriveAutomaticamente(tel, sessao?.nome);
  if (achado) return { ok: true, tipo: "link", link: achado.link, nomeCandidato: sessao?.nome || tel };

  return { ok: false, nomeCandidato: sessao?.nome || tel };
}

// GET /inbox/curriculo-check/:telefone → SEMPRE responde JSON (nunca redireciona).
// BUG CORRIGIDO: o front-end verificava disponibilidade com fetch() nesta mesma
// rota que fazia redirect pro Google Drive — fetch() bate numa política de CORS
// nesse redirecionamento entre domínios e falha mesmo quando o arquivo existe
// (diferente de uma navegação normal, que não tem essa restrição). Por isso um
// currículo que abria antes passou a aparecer como "não encontrado". Agora o
// front-end consulta esta rota (sempre JSON, mesma origem, sem CORS) primeiro,
// e só então abre o link/arquivo numa navegação de verdade.
app.get("/inbox/curriculo-check/:telefone", async (req, res) => {
  try {
    const tel = limparTelefone(req.params.telefone);
    const resultado = await localizarCurriculo(tel, req.query.idx);
    if (!resultado.ok) {
      const avisoSync = !sincronizacaoInicialCompleta
        ? " ATENÇÃO: o servidor ainda está sincronizando os dados (reiniciou há pouco) — esse resultado pode ser falso negativo. Espere 1-2 minutos e tente de novo antes de pedir reenvio."
        : (resultado.podeEstarProcessando ? " Este currículo foi recebido há menos de 2 minutos — o upload pro Drive pode ainda estar em andamento. Espere ~30s e tente de novo antes de pedir reenvio." : "");
      return res.json({
        ok: false,
        nomeCandidato: resultado.nomeCandidato,
        telefone: tel,
        aindaSincronizando: !sincronizacaoInicialCompleta,
        podeEstarProcessando: !!resultado.podeEstarProcessando,
        motivo: "Currículo não encontrado localmente nem no Drive (busca automática por telefone e nome não retornou resultado)." + avisoSync
      });
    }
    if (resultado.tipo === "link") return res.json({ ok: true, tipo: "link", link: resultado.link });
    // tipo "arquivo": a própria rota /inbox/curriculo/:telefone serve o binário — o
    // front-end abre essa URL diretamente (mesma origem, sem passar por aqui de novo)
    const idx = Math.max(0, Number(req.query.idx || 0));
    return res.json({ ok: true, tipo: "arquivo", link: `/inbox/curriculo/${encodeURIComponent(tel)}?idx=${idx}&inline=1` });
  } catch (erro) {
    console.error("Erro /inbox/curriculo-check:", erro.message);
    res.status(500).json({ ok: false, motivo: erro.message });
  }
});

app.get("/inbox/curriculo/:telefone", async (req, res) => {
  try {
    const tel = limparTelefone(req.params.telefone);
    const resultado = await localizarCurriculo(tel, req.query.idx);

    if (!resultado.ok) {
      return res.status(404).json({
        ok: false,
        disponivel: false,
        nomeCandidato: resultado.nomeCandidato,
        telefone: tel,
        motivo: "Currículo não encontrado localmente nem no Drive (busca automática por telefone e nome não retornou resultado)."
      });
    }

    if (resultado.tipo === "link") return res.redirect(resultado.link);

    const inline = req.query.inline === "1" || req.query.inline === "true";
    res.set("Content-Type", resultado.mimeType || "application/octet-stream");
    res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${resultado.filename || "curriculo"}"`);
    res.send(resultado.buffer);
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
    // areaBanco: vaga/área de disponibilidade informada no momento de mover o
    // candidato para o Banco de Talentos (pergunta feita no Inbox). Quando vier
    // preenchida, tem prioridade sobre o vagaInteresse antigo da sessão.
    const areaBanco = String(req.body.areaBanco || "").trim();
    // motivoReprovacao: motivo selecionado no Inbox ao reprovar um candidato
    // (Reprovado Triagem / 1ª Etapa / Gestor) — vira dado consultável depois,
    // por exemplo pra saber quantos candidatos caem por pretensão salarial etc.
    const motivoReprovacao = String(req.body.motivoReprovacao || "").trim();
    if (!telefone) return res.json({ ok: false, erro: "Telefone não informado" });

    const sessao = garantirSessao(telefone);
    sessao.statusProcesso = status || sessao.statusProcesso || "Novo";
    if (prioritario) sessao.motivoPausa = "Prioritário";
    if (areaBanco) {
      sessao.ultimaAnalise = { ...(sessao.ultimaAnalise || {}), vagaInteresse: areaBanco };
    }
    if (motivoReprovacao) {
      sessao.ultimaAnalise = { ...(sessao.ultimaAnalise || {}), motivoReprovacao };
    }

    if (CONFIG.VAGAS_URL && status) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      await axios.post(urlBase, {
        acao: "salvarAnalise",
        telefone,
        nome: sessao.nome || sessao.ultimaAnalise?.nome || "",
        status,
        observacoes: `${status}${prioritario ? " | Prioritário" : ""}${motivoReprovacao ? ` | Motivo: ${motivoReprovacao}` : ""}`,
        motivoReprovacao,
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
          cargo: areaBanco || sessao.ultimaAnalise?.vagaInteresse || sessao.vagaInteresse || "",
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
    // BUG CORRIGIDO: este endpoint sempre gravava status "Interessado", mesmo quando
    // o Inbox mandava "Em Vaga" (clique na etapa "EM VAGA" do funil). Resultado: o
    // candidato aparecia como "Em Vaga" só no navegador (localStorage), mas a planilha
    // e o Painel de Vagas do Dashboard recebiam "Interessado" — por isso o candidato
    // não aparecia agrupado no card da vaga certa, mesmo a vaga já tendo ID.
    const statusRecebido = String(req.body.status || "").trim();
    const status = statusRecebido === "Em Vaga" ? "Em Vaga" : "Interessado";

    sessao.statusProcesso = status;
    sessao.aguardandoConfirmacaoInteresse = false;
    sessao.ultimaAnalise = {
      ...(sessao.ultimaAnalise || {}),
      idVaga,
      vagaInteresse,
      status,
      curriculoDriveLink: sessao.curriculo?.driveLink || sessao.ultimaAnalise?.curriculoDriveLink || ""
    };

    if (CONFIG.VAGAS_URL) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      const basePayload = {
        telefone,
        nome: sessao.nome || sessao.ultimaAnalise?.nome || "",
        status,
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
    return res.json({ ok: true, telefone, idVaga, vagaInteresse, status });
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

  // ── REATIVAÇÃO DO BANCO DE TALENTOS: candidato respondeu ──────────────────
  if (sessao.aguardandoReativacao) {
    const textoNorm = normalizarTexto(mensagem);
    const ehPositivo = ["sim","tenho interesse","quero","aceito","pode ser","com certeza","claro","vamos","bora","yes","interesse","quero sim","tenho sim"].some(p => textoNorm === p || textoNorm.includes(p));
    const ehNegativo = ["nao","não","agora nao","agora não","sem interesse","obrigado mas não","obrigado mas nao","não tenho interesse"].some(p => textoNorm === p || textoNorm.includes(p));

    if (ehPositivo) {
      sessao.aguardandoReativacao = false;
      const vagaReativacao = sessao.vagaReativacao || "";
      // Limpa estado antigo mantendo nome e currículo
      const nomeAnterior = sessao.nome;
      const curriculoAnterior = sessao.curriculo;
      const curriculosAnteriores = sessao.curriculos;
      const ultimaAnaliseAnterior = sessao.ultimaAnalise;
      sessao.historico = sessao.historico.slice(-10); // mantém últimas 10 msgs de contexto
      sessao.aguardandoConfirmacaoInteresse = false;
      sessao.aguardandoDisponibilidade = false;
      sessao.preTriagem = null;
      sessao.miniQuestionario = null;
      sessao.vagaReativacao = null;
      // Pré-carrega vaga de interesse declarada
      if (vagaReativacao) {
        sessao.vagaInteresseDeclarado = vagaReativacao;
        if (ultimaAnaliseAnterior) sessao.ultimaAnalise = { ...ultimaAnaliseAnterior, vagaInteresse: vagaReativacao };
      }
      const nomeCand = primeiroNome(nomeAnterior || "");
      let resposta;
      // Se tem currículo/análise → vai direto para confirmação de interesse
      if (curriculoAnterior && ultimaAnaliseAnterior) {
        sessao.aguardandoConfirmacaoInteresse = true;
        resposta = `Que ótimo${nomeCand ? ", " + nomeCand : ""}! 😊 Que bom ter você de volta!\n\nVamos retomar sua candidatura${vagaReativacao ? ` para a vaga de ${vagaReativacao}` : ""}. Seu perfil já está registrado aqui comigo.\n\nSó confirmar: você ainda tem disponibilidade para participar do processo seletivo?`;
      } else {
        // Sem currículo → recomeça coleta
        resposta = `Ótimo${nomeCand ? ", " + nomeCand : ""}! 😊 Vou retomar seu cadastro para${vagaReativacao ? ` a vaga de ${vagaReativacao}` : " essa oportunidade"}.\n\nPode me enviar seu currículo atualizado? Aceito PDF, Word ou imagem. 📄`;
      }
      registrarEntradaSessao(sessao, "assistant", resposta);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", resposta, nomeAnterior);
      await salvarConversaCompletaSheets(telefone, sessao.historico, nomeAnterior);
      console.log(`[REATIVAÇÃO] ${telefone} respondeu positivamente para vaga: ${vagaReativacao}`);
      return resposta;
    }

    if (ehNegativo) {
      sessao.aguardandoReativacao = false;
      sessao.vagaReativacao = null;
      const nomeCand = primeiroNome(sessao.nome || "");
      const resposta = `Tudo bem${nomeCand ? ", " + nomeCand : ""}! 😊 Obrigada por responder. Seu contato continua salvo no nosso Banco de Talentos.\n\nQuando surgir uma oportunidade mais alinhada com seu perfil, entro em contato novamente. 💙`;
      registrarEntradaSessao(sessao, "assistant", resposta);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);
      await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
      return resposta;
    }
    // Resposta ambígua → passa para o Gemini interpretar normalmente
  }

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
    sessao.aceiteVaga = true; // marca aceite para exibição no painel
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

  // Se ainda falhou após retry — fica em silêncio e alerta Thiara (sem enviar nada ao candidato)
  if (resposta === FALLBACK_INSTABILIDADE || resposta === FALLBACK_RATE_LIMIT) {
    if (!sessao._alertaInstabilidadeEnviado || (Date.now() - sessao._alertaInstabilidadeEnviado) > 10 * 60 * 1000) {
      sessao._alertaInstabilidadeEnviado = Date.now();
      await enviarAlertaSimplesThiara(telefone, "🔥 FALHA AO CHAMAR A IA — LIA ficou em silêncio (candidato NÃO foi avisado)", mensagem);
    }
    console.warn(`[SILÊNCIO] IA falhou para ${telefone} — nenhuma msg enviada ao candidato.`);
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

    // IA OFF (modo emergência): não chama o Gemini para analisar o currículo — o arquivo
    // já está salvo no Drive/Sheets, só a análise automática fica pendente até reativar.
    if (!geminiAtivo) {
      if (cvSalvo) cvSalvo.analiseStatus = "aguardando_ia_reativada";
      await enviarAlertaSimplesThiara(telefone, "📄 CURRÍCULO RECEBIDO COM IA DESLIGADA", "Análise automática pausada (IA OFF). Currículo salvo no Drive, aguardando reativação da IA ou avaliação manual.");
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");
      return silencioso ? null : "Recebi seu currículo com sucesso. Ele já está salvo com a nossa equipe para avaliação. 💙";
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

      const prompt = montarPromptAnaliseEstruturada(textoCurriculo, vagasFiltradas, sessao.vagaInteresseDeclarado || "");
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

            // CORREÇÃO CRÍTICA: nunca forçar vaga que tem requisito obrigatório
            // que o candidato não comprova no currículo (ex: Curso de Vigilante).
            //
            // BUG CORRIGIDO: quando a coluna "Requisito Obrigatório" da vaga estava
            // vazia na planilha, a regra antiga assumia "requisito cumprido" por
            // padrão — na prática, isso permitia forçar QUALQUER candidato cujo
            // currículo tocasse de leve em uma palavra da área (ex: "monitoramento",
            // "ronda") para a vaga de Vigilante, mesmo sem o curso obrigatório por lei.
            // Para áreas regulamentadas (hoje: segurança), a falta de requisito
            // configurado na planilha agora BLOQUEIA o encaixe automático, em vez de
            // liberá-lo — é preciso cadastrar o requisito na planilha ou avaliar manual.
            const AREAS_REGULAMENTADAS = ["seguranca"];
            const reqObrigArea = normalizarTexto(campo(vagaArea, ["requisitoObrigatorio", "Requisito Obrigatório", "Requisito Obrigatorio"]) || "");
            const candidatoAtendReq = reqObrigArea
              ? normalizarTexto(textoCurriculo).includes(reqObrigArea)
              : !AREAS_REGULAMENTADAS.includes(areaCv);

            if (semMatch && candidatoAtendReq) {
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

function montarPromptAnaliseEstruturada(textoCurriculo, vagas, vagaDeclarada = "") {
  const vagasResumidas = resumirVagas(vagas);
  const instrucaoVagaDeclarada = vagaDeclarada
    ? `\nINTERESSE DECLARADO PELO CANDIDATO: "${vagaDeclarada}"\n- PRIORIZE vagas que correspondam a esse interesse declarado.\n- Se houver uma vaga compatível com "${vagaDeclarada}" na lista, ela deve ser a primeira opção, mesmo que outra vaga tenha score levemente maior.\n- Só ignore o interesse declarado se não existir absolutamente nenhuma vaga compatível ou se o candidato não atender ao requisitoObrigatorio da vaga desejada.\n`
    : "";
  return `Você é a Lia, da Effect Pessoas e Performance.\n\nAnalise o currículo abaixo e compare com as vagas disponíveis.\n${instrucaoVagaDeclarada}\nResponda SOMENTE em JSON válido, sem markdown, sem explicação fora do JSON.\n\nUse exatamente esta estrutura:\n\n{\n  "nome": "",\n  "cidade": "",\n  "areaInteresse": "",\n  "vagaInteresse": "",\n  "idVaga": "",\n  "scoreGeral": 0,\n  "scoreVaga": 0,\n  "classificacao": "",\n  "motivoMatch": "",\n  "status": "",\n  "requisitoObrigatorio": "",\n  "escolaridadeCompativel": "",\n  "experienciaCompativel": "",\n  "anosExperiencia": "",\n  "pontosFortes": "",\n  "pontosAtencao": "",\n  "analiseIA": "",\n  "transporteProprio": "",\n  "cltImediato": "",\n  "observacoes": "",\n  "mensagemCandidato": ""\n}\n\nREGRAS DE CLASSIFICAÇÃO:\n- 90 a 100: Excelente\n- 70 a 89: Bom\n- 50 a 69: Regular\n- abaixo de 50: Reprovado\n- Nunca use Excelente se faltar requisito obrigatório.\n- Não prometa contratação.\n\nREGRA CRÍTICA — REQUISITOS OBRIGATÓRIOS (HARD FILTER):\n- Cada vaga pode ter um campo "requisitoObrigatorio". Se esse campo estiver preenchido, é um requisito ELIMINATÓRIO.\n- NUNCA sugira uma vaga cujo requisitoObrigatorio não esteja comprovado no currículo.\n- Exemplos de requisitos obrigatórios e como verificar:\n  * "Curso de Vigilante" / "Curso de formação de vigilante" / "Vigilante": candidato precisa ter curso ou registro de vigilante no currículo. Se não tiver, scoreVaga = 0, classificacao = "Reprovado", vagaInteresse = "" para essa vaga.\n  * "CNH B" / "CNH": candidato precisa ter CNH mencionada no currículo.\n  * "Ensino Superior completo": candidato precisa ter graduação concluída.\n- Se nenhuma vaga adequada existir após aplicar os filtros obrigatórios, retorne vagaInteresse = "", idVaga = "", scoreVaga = 0, e mensagemCandidato = "😊 Olá, {NOME}!\\n\\nRecebi seu currículo e ele já está salvo em nosso Banco de Talentos!\\n\\nAssim que surgir uma oportunidade compatível com o seu perfil, entraremos em contato. 💙"\n- JAMAIS force um match com vaga que exige requisito obrigatório que o candidato não possui.\n\nFORMATO DA mensagemCandidato:\n😊 Olá, {NOME}!\n\nAnalisei seu currículo e identifiquei uma oportunidade que possui compatibilidade com sua experiência profissional.\n\n📍 {CARGO}\n📍 {CIDADE}\n\nOs principais pontos observados foram:\n\n• {PONTO FORTE 1}\n• {PONTO FORTE 2}\n• {PONTO FORTE 3}\n\nVocê teria interesse em participar deste processo seletivo?\n\nFico à disposição. 💙\n\nREGRAS:\n- Não mostrar score.\n- Não mostrar classificação.\n- Não falar em IA ou análise automática.\n- Não elogiar o nome.\n- Não usar textos longos.\n- Não prometer contratação.\n- NUNCA use ###, **, *, markdown de nenhum tipo na mensagemCandidato. Apenas texto simples com emojis.\n\nVAGAS:\n${JSON.stringify(vagasResumidas, null, 2)}\n\nCURRÍCULO:\n${textoCurriculo}`;
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
  // IA OFF: bloqueio TOTAL na fonte — nenhuma chamada (e nenhum gasto) ao Gemini.
  if (!geminiAtivo) throw new Error("IA desligada (IA OFF) — chamada ao Gemini bloqueada.");
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
  // IA OFF: bloqueio TOTAL na fonte — nenhuma chamada (e nenhum gasto) ao Gemini,
  // inclusive retries e qualquer caminho novo que venha a usar esta funcao.
  if (!geminiAtivo) {
    console.warn("[IA OFF] Chamada ao Gemini bloqueada (chamarGemini).");
    return null;
  }
  try {
    if (!CONFIG.GEMINI_API_KEY) {
      console.error("chamarGemini: GEMINI_API_KEY não configurada.");
      return FALLBACK_INSTABILIDADE;
    }
    if (tentativa === 1) geminiStats.totalCalls++;

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

    if (ehRateLimit) {
      geminiStats.erros429++;
      geminiStats.ultimoErro429 = new Date().toISOString();
      if (geminiStats.erros429 >= 3) geminiStats.quotaAlerta = true;
    }

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
  // MODO EMERGÊNCIA: Gemini desativado manualmente
  if (!geminiAtivo) {
    console.warn("⚠️  Gemini desativado (modo emergência) — IA não chamada.");
    return null; // processarMensagem trata null como "não responder"
  }

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

// ============================================================
// DIVULGAÇÃO DE VAGAS — geração de texto (Gemini ou ChatGPT),
// matching de candidatos compatíveis e envio (WhatsApp + e-mail parceiro)
// ============================================================

// Chamada simples ao ChatGPT (OpenAI) — usada só para gerar texto de divulgação,
// não participa do atendimento da Lia no WhatsApp.
async function chamarChatGPT(prompt, tentativa = 1) {
  if (!CONFIG.OPENAI_API_KEY) {
    console.error("chamarChatGPT: OPENAI_API_KEY não configurada.");
    return null;
  }
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: CONFIG.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6
      },
      { headers: { Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 45000 }
    );
    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (erro) {
    const status = erro.response?.status;
    console.error(`Erro chamarChatGPT (tentativa ${tentativa}) — status: ${status || "sem status"} — msg: ${erro.message}`);
    const ehRateLimitOuRede = status === 429 || !status || erro.code === "ECONNABORTED" || erro.code === "ETIMEDOUT";
    if (ehRateLimitOuRede && tentativa < 3) {
      await sleep(2000 * tentativa);
      return chamarChatGPT(prompt, tentativa + 1);
    }
    return null;
  }
}

// Texto fixo (sem IA) — usado quando nenhum provider de IA está disponível/configurado.
function textoDivulgacaoFixo(vaga) {
  const cargo = campo(vaga, ["cargo", "Cargo", "CARGO"], "Oportunidade");
  const cidade = campo(vaga, ["cidade", "Cidade", "vaga_cidade"], "");
  const salario = campo(vaga, ["salario", "Salário", "vaga_salario"], "A combinar");
  const horario = campo(vaga, ["horario", "Horário", "vaga_horario"], "");
  const beneficios = campo(vaga, ["beneficios", "Benefícios", "vaga_beneficios"], "");
  const requisitos = campo(vaga, ["requisitos", "Requisitos", "vaga_requisitos"], "");
  return `🟢 VAGA ABERTA — ${cargo}\n\n📍 Local: ${cidade}\n💰 Salário: ${salario}${horario ? `\n🕐 Horário: ${horario}` : ""}${beneficios ? `\n🎁 Benefícios: ${beneficios}` : ""}${requisitos ? `\n📋 Requisitos: ${requisitos}` : ""}\n\nTem interesse? Envie seu currículo atualizado por aqui que a gente dá continuidade! 💙\n\nEquipe Effect Pessoas`;
}

function promptDivulgacaoVaga(vaga) {
  const cargo = campo(vaga, ["cargo", "Cargo", "CARGO"], "");
  const cidade = campo(vaga, ["cidade", "Cidade", "vaga_cidade"], "");
  const salario = campo(vaga, ["salario", "Salário", "vaga_salario"], "A combinar");
  const horario = campo(vaga, ["horario", "Horário", "vaga_horario"], "");
  const beneficios = campo(vaga, ["beneficios", "Benefícios", "vaga_beneficios"], "");
  const requisitos = campo(vaga, ["requisitos", "Requisitos", "vaga_requisitos"], "");
  const responsabilidades = campo(vaga, ["responsabilidades", "Responsabilidades", "vaga_responsabilidades"], "");
  return `Escreva um texto curto (máximo 8 linhas) para divulgar esta vaga de emprego em grupos de WhatsApp e redes sociais. Tom acolhedor e profissional, com emojis moderados (sem exagero). Não invente nenhuma informação que não esteja listada abaixo. Termine pedindo para quem tiver interesse enviar currículo atualizado. Não use markdown (sem **, sem #).

Cargo: ${cargo}
Cidade: ${cidade}
Salário: ${salario}
Horário: ${horario}
Benefícios: ${beneficios}
Requisitos: ${requisitos}
Responsabilidades: ${responsabilidades}`;
}

// Gera o texto de divulgação. provider: "gemini" (padrão) ou "chatgpt".
// Sempre cai para o texto fixo se a IA escolhida falhar ou não estiver configurada.
async function gerarTextoDivulgacao(vaga, provider) {
  const escolhido = String(provider || CONFIG.DIVULGACAO_AI_PADRAO || "gemini").toLowerCase().trim();
  const prompt = promptDivulgacaoVaga(vaga);

  if (escolhido === "chatgpt") {
    const texto = await chamarChatGPT(prompt);
    if (texto) return { texto, providerUsado: "chatgpt" };
    console.error("gerarTextoDivulgacao: ChatGPT falhou/não configurado, tentando Gemini.");
  }

  if (CONFIG.GEMINI_API_KEY && geminiAtivo) {
    const textoGemini = await chamarGemini(prompt);
    if (textoGemini && textoGemini !== FALLBACK_INSTABILIDADE && textoGemini !== FALLBACK_RATE_LIMIT) {
      return { texto: textoGemini, providerUsado: "gemini" };
    }
  }

  if (escolhido !== "chatgpt" && CONFIG.OPENAI_API_KEY) {
    const texto = await chamarChatGPT(prompt);
    if (texto) return { texto, providerUsado: "chatgpt" };
  }

  return { texto: textoDivulgacaoFixo(vaga), providerUsado: "fixo" };
}

// Candidato é compatível com a vaga se a área/cargo bater (reaproveita a mesma
// lógica de sinônimos usada no atendimento da Lia) e, quando ambos informarem
// cidade, ela também for compatível (comparação tolerante, por substring).
function candidatoCompativelComVaga(candidato, vaga) {
  const textoVaga = normalizarTexto(textoDaVagaParaArea(vaga));
  const areaCandidato = normalizarTexto(campo(candidato, ["areaInteresse", "area", "Área de interesse", "cargo", "vagaInteresse", "Cargo"], ""));
  const compativelPorArea = areaCandidato && textoVaga.includes(areaCandidato.split(" ")[0]);

  const cidadeVaga = normalizarTexto(campo(vaga, ["cidade", "Cidade", "vaga_cidade"], ""));
  const cidadeCandidato = normalizarTexto(campo(candidato, ["cidade", "Cidade"], ""));
  const cidadeOk = !cidadeVaga || !cidadeCandidato || cidadeCandidato.includes(cidadeVaga) || cidadeVaga.includes(cidadeCandidato);

  return Boolean(compativelPorArea) && cidadeOk;
}

async function buscarCandidatosCompativeis(vaga) {
  if (!CONFIG.VAGAS_URL) return [];
  try {
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=candidatos`, { timeout: 15000 });
    const candidatos = r.data?.candidatos || [];
    return candidatos.filter(c => candidatoCompativelComVaga(c, vaga));
  } catch (e) {
    console.error("buscarCandidatosCompativeis erro:", e.message);
    return [];
  }
}

// ── E-MAIL PARA O PARCEIRO DE DIVULGAÇÃO (redes sociais) ─────────────────────
let transporterEmail = null;
function getTransporterEmail() {
  if (transporterEmail) return transporterEmail;
  if (!CONFIG.EMAIL_HOST || !CONFIG.EMAIL_USER || !CONFIG.EMAIL_PASS) return null;
  transporterEmail = nodemailer.createTransport({
    host: CONFIG.EMAIL_HOST,
    port: Number(CONFIG.EMAIL_PORT) || 587,
    secure: CONFIG.EMAIL_SECURE || Number(CONFIG.EMAIL_PORT) === 465,
    auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS }
  });
  return transporterEmail;
}

async function enviarEmailParceiro(vaga, texto) {
  const transporter = getTransporterEmail();
  if (!transporter || !CONFIG.PARCEIRO_EMAIL) {
    return { ok: false, erro: "E-mail não configurado (EMAIL_HOST/EMAIL_USER/EMAIL_PASS/PARCEIRO_EMAIL)" };
  }
  const cargo = campo(vaga, ["cargo", "Cargo"], "Nova vaga");
  const cidade = campo(vaga, ["cidade", "Cidade"], "");
  try {
    await transporter.sendMail({
      from: `"Effect Pessoas e Performance" <${CONFIG.EMAIL_USER}>`,
      to: CONFIG.PARCEIRO_EMAIL,
      subject: `📢 Nova vaga para divulgar: ${cargo}${cidade ? " — " + cidade : ""}`,
      text: texto,
      html: `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;font-size:14px;color:#111">${texto.replace(/\n/g, "<br>")}</div>`
    });
    return { ok: true };
  } catch (e) {
    console.error("Erro enviarEmailParceiro:", e.message);
    return { ok: false, erro: e.message };
  }
}

// ── ENDPOINTS — DIVULGAÇÃO DE VAGAS ───────────────────────────────────────────

app.get("/divulgacao", (req, res) => res.sendFile(path.join(__dirname, "divulgacao.html")));

// Gera (ou regera) o texto de divulgação, sem enviar nada ainda.
app.post("/vagas/gerar-texto", async (req, res) => {
  try {
    const vaga = req.body.vaga || {};
    const provider = req.body.provider;
    const { texto, providerUsado } = await gerarTextoDivulgacao(vaga, provider);
    res.json({ ok: true, texto, providerUsado });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// Lista candidatos compatíveis com a vaga, para revisão antes do disparo.
app.post("/vagas/candidatos-compativeis", async (req, res) => {
  try {
    const vaga = req.body.vaga || {};
    const candidatos = await buscarCandidatosCompativeis(vaga);
    const lista = candidatos.map(c => ({
      telefone: limparTelefone(campo(c, ["telefone", "Telefone", "whatsapp"], "")),
      nome: campo(c, ["nome", "Nome"], "")
    })).filter(c => c.telefone);
    res.json({ ok: true, total: lista.length, candidatos: lista });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// Aprova e dispara a divulgação: WhatsApp em lote para os candidatos compatíveis
// (ou lista escolhida manualmente) + e-mail para o parceiro de redes sociais.
// Este é o único gatilho de disparo — nada sai automaticamente sem essa chamada,
// ou seja, o disparo só acontece depois que a vaga é aprovada no painel.
app.post("/vagas/aprovar", async (req, res) => {
  try {
    const vaga = req.body.vaga || {};
    const provider = req.body.provider;
    const enviarWhatsapp = req.body.enviarWhatsapp !== false;
    const enviarEmail = req.body.enviarEmail !== false;
    const telefonesManual = Array.isArray(req.body.telefones) ? req.body.telefones : null;

    let texto = String(req.body.texto || "").trim();
    let providerUsado = "manual";
    if (!texto) {
      const gerado = await gerarTextoDivulgacao(vaga, provider);
      texto = gerado.texto;
      providerUsado = gerado.providerUsado;
    }

    let telefones = [];
    if (telefonesManual) {
      telefones = [...new Set(telefonesManual.map(limparTelefone).filter(t => t && t.length >= 8))];
    } else if (enviarWhatsapp) {
      const candidatos = await buscarCandidatosCompativeis(vaga);
      telefones = [...new Set(candidatos.map(c => limparTelefone(campo(c, ["telefone", "Telefone", "whatsapp"], ""))).filter(t => t && t.length >= 8))];
    }

    if (enviarWhatsapp && telefones.length) {
      // Reaproveita o motor de envio em lote (1 msg/seg, cai para template
      // aprovado quando o candidato está fora da janela de 24h da Meta).
      iniciarEnvioLote(telefones, texto, { templateFallback: true });
    }

    let resultadoEmail = { ok: false, erro: "Não solicitado" };
    if (enviarEmail) {
      resultadoEmail = await enviarEmailParceiro(vaga, texto);
    }

    res.json({
      ok: true,
      texto,
      providerUsado,
      totalCandidatosWhatsapp: telefones.length,
      whatsappDisparado: enviarWhatsapp && telefones.length > 0,
      email: resultadoEmail
    });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// ── ENDPOINTS DE CONTROLE (Gemini + Railway) ──────────────────────────────────

// GET /admin/status → retorna estado atual da IA e créditos Railway
app.get("/admin/status", async (req, res) => {
  const status = {
    geminiAtivo,
    railway: null,
    gemini: {
      quotaAlerta: geminiStats.quotaAlerta,
      erros429: geminiStats.erros429,
      totalCalls: geminiStats.totalCalls,
      ultimoErro429: geminiStats.ultimoErro429,
      usageUrl: "https://aistudio.google.com/app/usage"
    }
  };
  if (CONFIG.RAILWAY_TOKEN) {
    try {
      // Verifica apenas se o token é válido — Railway não expõe saldo via API pública
      const query = `{ me { name } }`;
      const r = await fetch("https://backboard.railway.app/graphql/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.RAILWAY_TOKEN}` },
        body: JSON.stringify({ query })
      });
      const data = await r.json();
      const me = data?.data?.me;
      if (me !== null && me !== undefined) {
        status.railway = { conectado: true, nome: me.name || "Railway", billingUrl: "https://railway.app/account/billing" };
      } else {
        status.railway = { conectado: false };
      }
    } catch(e) { status.railway = { conectado: false, erro: e.message }; }
  }
  res.json(status);
});

// POST /admin/gemini-toggle → liga/desliga Gemini sem redeploy
app.post("/admin/gemini-toggle", (req, res) => {
  const { ativo } = req.body || {};
  if (typeof ativo === "boolean") {
    geminiAtivo = ativo;
  } else {
    geminiAtivo = !geminiAtivo; // toggle se não passar valor
  }
  // Ao reativar, reseta o alerta de quota (usuário recarregou créditos)
  if (geminiAtivo) {
    geminiStats.erros429 = 0;
    geminiStats.quotaAlerta = false;
    geminiStats.ultimoErro429 = null;
  }
  // Persiste estado no Volume para sobreviver a deploys
  try {
    if (!inboxDataCache) inboxDataCache = lerDadosInbox() || {};
    inboxDataCache.geminiAtivo = geminiAtivo;
    gravarDadosInbox(inboxDataCache);
    console.log(`[IA] Estado salvo no Volume: geminiAtivo = ${geminiAtivo}`);
  } catch(e) { console.error("[IA] Erro ao salvar estado no Volume:", e.message); }
  const msg = geminiAtivo
    ? "✅ Gemini ATIVADO — LIA respondendo normalmente."
    : "⚠️ Gemini DESATIVADO — LIA em silêncio. Ative novamente quando recarregar créditos.";
  console.log(msg);
  res.json({ ok: true, geminiAtivo, mensagem: msg });
});

// POST /inbox/reativar-banco → envia msg de reativação para candidatos do Banco de Talentos
app.post("/inbox/reativar-banco", async (req, res) => {
  const { cargo, mensagem, telefones } = req.body || {};
  if (!mensagem || !Array.isArray(telefones) || telefones.length === 0) {
    return res.json({ ok: false, erro: "Parâmetros inválidos" });
  }
  const resultados = [];
  for (const tel of telefones) {
    try {
      // Marca sessão como aguardando reativação
      if (!sessoes[tel]) sessoes[tel] = { historico: [], nome: null, modo: "automatico", pausado: false, motivoPausa: "" };
      sessoes[tel].aguardandoReativacao = true;
      sessoes[tel].vagaReativacao = cargo || "";
      sessoes[tel].pausado = false;
      sessoes[tel].modo = "automatico";
      atendimentosManuais.delete(tel);
      // Envia mensagem WhatsApp
      const r = await enviarMensagem(tel, mensagem);
      // Registra no histórico
      const nomeCand = sessoes[tel].nome || tel;
      registrarEntradaSessao(sessoes[tel], "assistant", mensagem);
      await salvarMensagemSheets(tel, "assistant", mensagem, nomeCand);
      resultados.push({ telefone: tel, ok: true });
    } catch(e) {
      resultados.push({ telefone: tel, ok: false, erro: e.message });
    }
  }
  const enviados = resultados.filter(r => r.ok).length;
  console.log(`[REATIVAR-BANCO] Enviado para ${enviados}/${telefones.length} candidatos — cargo: ${cargo}`);
  res.json({ ok: true, total: telefones.length, enviados, resultados });
});

// Monitoramento automático de créditos Railway a cada 6h
async function verificarCreditosRailway() {
  if (!CONFIG.RAILWAY_TOKEN) return;
  try {
    const query = `{ me { creditBalance } }`;
    const r = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.RAILWAY_TOKEN}` },
      body: JSON.stringify({ query })
    });
    const data = await r.json();
    const creditos = parseFloat(data?.data?.me?.creditBalance ?? -1);
    if (creditos >= 0 && creditos < 2.00) {
      const msg = `⚠️ *ALERTA RAILWAY*\n\nCréditos Railway baixos: *$${creditos.toFixed(2)}*\n\nA LIA pode parar de funcionar em breve. Acesse railway.app para recarregar.`;
      await enviarMensagem(CONFIG.THIARA_WHATSAPP, msg).catch(() => {});
      console.warn("⚠️ Créditos Railway baixos:", creditos);
    }
  } catch(e) { console.error("Erro ao verificar créditos Railway:", e.message); }
}

// Checar a cada 6 horas
setInterval(verificarCreditosRailway, 6 * 60 * 60 * 1000);
// Checar também 30s após startup
setTimeout(verificarCreditosRailway, 30000);

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

// Evita pedir reenvio de currículo repetidas vezes pro mesmo candidato em pouco tempo
const PEDIDOS_REENVIO_CV = {}; // { telefone: timestampMs do último pedido }
const INTERVALO_MIN_REENVIO_MS = 24 * 60 * 60 * 1000; // 24h

app.get("/inbox/curriculo/:telefone/pedir-reenvio", async (req, res) => {
  try {
    const tel = limparTelefone(req.params.telefone);
    const sessao = sessoes[tel] || {};

    // BUG CORRIGIDO: não existia nenhum limite — cada clique (ou clique duplo)
    // mandava uma mensagem nova pro candidato pedindo o currículo de novo. Agora,
    // se já foi pedido nas últimas 24h, avisa em vez de mandar outra mensagem.
    const ultimoPedido = PEDIDOS_REENVIO_CV[tel] || 0;
    const agora = Date.now();
    if (agora - ultimoPedido < INTERVALO_MIN_REENVIO_MS) {
      const horasRestantes = Math.ceil((INTERVALO_MIN_REENVIO_MS - (agora - ultimoPedido)) / (60 * 60 * 1000));
      return res.json({ ok: true, jaSolicitado: true, mensagem: `Já foi pedido reenvio pra este candidato recentemente. Aguarde ~${horasRestantes}h antes de pedir de novo (evita mandar a mesma mensagem repetida).` });
    }

    const nome = (sessao.nome || 'Candidato').split(' ')[0];
    const msg = `Olá, ${nome}! Precisamos do seu currículo atualizado para dar continuidade ao processo seletivo. Por favor, envie seu currículo aqui pelo WhatsApp. 😊`;
    await enviarMensagem(tel, msg);
    registrarEntradaSessao(sessao, 'assistant', msg);
    salvarConversaCompletaSheets(tel, sessao.historico || [], sessao.nome || '').catch(() => {});
    PEDIDOS_REENVIO_CV[tel] = agora;
    res.json({ ok: true, jaSolicitado: false, mensagem: 'Mensagem enviada pedindo reenvio do currículo.' });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
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

// ── AGENDA SYNC: persiste entrevistas, lembretes, status e config no Volume ──
// (o inbox.html chama essas rotas para sincronizar dados entre dispositivos e
// sobreviver a deploys — antes essa rota não existia e o sync falhava em silêncio)
app.get("/inbox/agenda-sync", (req, res) => {
  try {
    const cache = inboxDataCache || lerDadosInbox() || {};
    res.json({ ok: true, dados: cache.agendaSync || {} });
  } catch (e) {
    res.json({ ok: false, erro: e.message, dados: {} });
  }
});

app.post("/inbox/agenda-sync", (req, res) => {
  try {
    if (!inboxDataCache) inboxDataCache = lerDadosInbox() || {};
    inboxDataCache.agendaSync = { ...(req.body || {}), _syncEm: new Date().toISOString() };
    const persistido = gravarDadosInbox(inboxDataCache);
    res.json({ ok: true, persistido });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// ── FINANCEIRO ────────────────────────────────────────────────────────────
app.get("/financeiro", (req, res) => res.sendFile(path.join(__dirname, "financeiro.html")));
app.get("/avaliacao", (req, res) => res.sendFile(path.join(__dirname, "avaliacao.html")));

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

// ══════════════════════════════════════════════════════════════════════════════
// SYNC DE DADOS DO INBOX NO GOOGLE DRIVE
// Persiste entrevistas, status, pipeline, notas — sobrevive a deploys e trocas de dispositivo
// ══════════════════════════════════════════════════════════════════════════════
// ── INBOX PERSISTENCE (Railway Volume) ──────────────────────────────────────
// Dados do Inbox são salvos em /data/inbox-data.json (Railway Volume persistente).
// O Volume sobrevive a qualquer deploy. Configure em Railway → seu serviço → Volumes
// e monte em /data. Sem Volume, o arquivo fica em /tmp e dura apenas a sessão atual.
const INBOX_DATA_PATH = process.env.INBOX_DATA_PATH || "/data/inbox-data.json";

// ── RESTAURA geminiAtivo DO VOLUME AO LIGAR O SERVIDOR ──────────────────────
// BUG CRÍTICO CORRIGIDO: geminiAtivo era sempre resetado para `true` a cada
// deploy/restart do Railway, mesmo quando o estado salvo no Volume era `false`.
// Isso fazia a Lia voltar a responder sozinha depois de qualquer redeploy,
// mesmo com o botão "IA OFF" marcado (o botão mostrava o último estado salvo
// no navegador, mas o servidor já tinha voltado a chamar o Gemini normalmente).
try {
  const dadosSalvos = lerDadosInbox();
  if (dadosSalvos && typeof dadosSalvos.geminiAtivo === "boolean") {
    geminiAtivo = dadosSalvos.geminiAtivo;
    inboxDataCache = dadosSalvos;
    console.log(`[IA] Estado restaurado do Volume ao iniciar: geminiAtivo = ${geminiAtivo}`);
  }
} catch (e) {
  console.error("[IA] Erro ao restaurar geminiAtivo do Volume:", e.message);
}

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
