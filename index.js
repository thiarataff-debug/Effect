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
const nfRoutes = require("./nf-routes");
const finRoutes = require("./financeiro-routes");
const { criarStoreCacheado } = require("./drive-json-store");

const app = express();
// Desliga o ETag automático do Express — ele é o que fazia o navegador (e
// qualquer proxy no meio do caminho) achar que a página "não mudou" e devolver
// 304 (cópia antiga) mesmo depois de um deploy novo com conteúdo diferente.
app.set("etag", false);
// Compressão (gzip) das respostas — páginas grandes como inbox.html (~370KB) e
// dashboard.html (~190KB) estavam chegando CORTADAS no meio no navegador (efeito
// clássico de timeout de proxy/rede no meio do envio de uma resposta grande e
// não-comprimida). Comprimir reduz o tamanho real transmitido em ~70-80% para
// HTML/JS, o que evita esse corte.
app.use(compression());
app.use(express.json({ limit: "20mb" }));
app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); if (req.method === "OPTIONS") return res.sendStatus(200); next(); });
// Proíbe qualquer cache (navegador, proxy, CDN) nas páginas HTML servidas
// dinamicamente (/inbox, /dashboard, /sheets, /financeiro, /meu-app etc.).
// SEM isso, o navegador (ou um proxy no meio do caminho) reaproveita uma cópia
// antiga da página com "304 Not Modified" mesmo depois de um deploy novo — foi
// exatamente isso que causou as funções "não definidas" mesmo com o código
// certo publicado: a página nem chegava a ser buscada de novo de verdade.
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/webhook")) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});
app.use(nfRoutes);
app.use(finRoutes);
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

  // ── REDIRECIONAMENTO TOTAL DE ATENDIMENTO ──────────────────────────────────
  // Quando ativo, a Lia PARA de conduzir qualquer fluxo (vagas, currículo,
  // pré-triagem etc.) e responde toda mensagem recebida apenas com um convite
  // para continuar a conversa no novo número de WhatsApp abaixo.
  // Para voltar ao atendimento normal da Lia, basta trocar para false.
  REDIRECIONAMENTO_ATIVO: true,
  NUMERO_REDIRECIONAMENTO: "5527995175557", // (27) 99517-5557
  MENSAGEM_REDIRECIONAMENTO:
    "Oi! 😊 Estamos com um novo número de atendimento.\n\nPra continuar sua conversa e dar andamento à sua candidatura, me chama por aqui:\n\n📲 https://wa.me/5527995175557\n\nAté já! 💙",
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
  TEMPLATE_DIVULGACAO_VAGA: process.env.TEMPLATE_DIVULGACAO_VAGA || "effect_reengajamento_candidatos", // template aprovado na Meta p/ candidatos fora da janela de 24h
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "https://effect-production.up.railway.app",

  // ── Dados da própria Effect (CONTRATADA), usados na minuta de contrato ─────
  // Preencha via variável de ambiente no Railway (ou direto aqui) com os dados
  // reais da empresa. Enquanto não preenchidos, a minuta sai com placeholders
  // visíveis para não passar informação errada por engano.
  CONTRATADA_NOME_FANTASIA:  process.env.CONTRATADA_NOME_FANTASIA  || "EFFECT – Pessoas & Performance",
  CONTRATADA_RAZAO:          process.env.CONTRATADA_RAZAO          || "THIARA AVELINO FREIRE FERREIRA",
  CONTRATADA_CNPJ:           process.env.CONTRATADA_CNPJ           || "52.745.316/0001-06",
  CONTRATADA_ENDERECO:       process.env.CONTRATADA_ENDERECO       || "Rua Pinho, nº 95, Colina de Laranjeiras, Serra/ES, CEP 29167-142",
  CONTRATADA_EMAIL:          process.env.CONTRATADA_EMAIL          || "effectpessoas@gmail.com",
  CONTRATADA_TELEFONE:       process.env.CONTRATADA_TELEFONE       || "(27) 99792-5288",
  CONTRATADA_FORO_CIDADE:    process.env.CONTRATADA_FORO_CIDADE    || "Serra",
  CONTRATADA_FORO_UF:        process.env.CONTRATADA_FORO_UF        || "Espírito Santo",
  CONTRATO_DIAS_GARANTIA:      process.env.CONTRATO_DIAS_GARANTIA      || "30",
  CONTRATO_DIAS_AVISO_RESCISAO: process.env.CONTRATO_DIAS_AVISO_RESCISAO || "30",
  CONTRATO_MULTA_PCT:           process.env.CONTRATO_MULTA_PCT           || "10"
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
    discSolidesResult: sessao?.discSolidesResult || null,
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

// ── REDIRECIONAMENTO TOTAL: responde qualquer mensagem recebida apenas com o
// convite para o novo número de WhatsApp, sem rodar o fluxo normal da Lia
// (sem chamar IA, sem perguntar vaga/currículo etc.). Controlado por
// CONFIG.REDIRECIONAMENTO_ATIVO — ver comentário junto da config.
async function tratarRedirecionamentoTotal(telefoneOriginal, conteudoRecebido, messageTimestampMs) {
  const telefone = limparTelefone(telefoneOriginal);
  const sessao = garantirSessao(telefone);

  registrarEntradaSessao(sessao, "user", conteudoRecebido, messageTimestampMs);
  marcarMensagemRecebida(sessao, messageTimestampMs);
  sessao.historico = sessao.historico.slice(-500);
  await salvarMensagemSheets(telefone, "user", conteudoRecebido, sessao.nome || "", messageTimestampMs);

  const resposta = CONFIG.MENSAGEM_REDIRECIONAMENTO;
  registrarEntradaSessao(sessao, "assistant", resposta);
  marcarConversaRespondida(sessao);
  sessao.historico = sessao.historico.slice(-500);
  await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome || "");
  await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome || "");

  await enviarMensagem(telefone, resposta);
  console.log(`[REDIRECIONAMENTO TOTAL] ${telefone} → ${CONFIG.NUMERO_REDIRECIONAMENTO}`);
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
          discResult: s.discResult || null, discSolidesResult: s.discSolidesResult || null
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
        discResult: s.discResult || null, discSolidesResult: s.discSolidesResult || null,
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
          discResult: s.discResult || null, discSolidesResult: s.discSolidesResult || null,
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

// Persistência do Inbox: Google Drive (pasta "Inbox"), não mais disco local —
// disco local some em hospedagens gratuitas a cada deploy/hibernação. Na
// primeira execução com este código, se ainda existir o arquivo antigo do
// Volume do Railway (INBOX_DATA_PATH), ele é migrado automaticamente pro
// Drive uma única vez, sem perder nada do que já estava salvo.
// lerDadosInbox()/gravarDadosInbox() continuam com a MESMA assinatura de
// antes (síncronas) — só o armazenamento por baixo mudou — então nenhuma das
// rotas que já usam essas funções precisou ser alterada.
const inboxDriveStore = criarStoreCacheado({
  nomeArquivo: "inbox-data.json",
  pastaNome: "Inbox",
  valorPadrao: null,
  migrarDeArquivoLocal: process.env.INBOX_DATA_PATH || "/data/inbox-data.json"
});

function lerDadosInbox() {
  return inboxDriveStore.ler();
}

function gravarDadosInbox(dados) {
  return inboxDriveStore.gravar(dados);
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
// OBS: o backup periódico real fica só na definição logo abaixo de fazerBackup()
// (mais adiante neste arquivo). Havia uma SEGUNDA chamada idêntica de
// setInterval(fazerBackup("diario")) duplicada aqui, rodando a cada 2h em vez
// de 1x por dia como o nome sugere — isso dobrava as chamadas ao Google Apps
// Script (o mesmo serviço que salva currículos no Drive) sem necessidade,
// provavelmente contribuindo para estourar a cota diária do Drive mais rápido.
// Removida para eliminar a duplicidade.

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
        discSolidesResult: s.discSolidesResult,
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

// Backup diário — executa a cada 24h (estava rodando a cada 2h por engano, e
// ainda duplicado em outro ponto do arquivo — juntos, isso multiplicava as
// chamadas ao Google Apps Script bem além do necessário e ajudava a estourar
// a cota diária de Drive daquela conta, que é a mesma usada como reserva para
// salvar currículos. Corrigido para o intervalo real de 24h.)
setInterval(() => fazerBackup("diario"), 24 * 60 * 60 * 1000);

// Backup semanal — executa a cada 7 dias
setInterval(() => fazerBackup("semanal"), 7 * 24 * 60 * 60 * 1000);

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

// Menu principal — 4 áreas (Pessoal · Financeiro · Avaliação de Candidatos · Dashboard).
// Ver CHANGELOG_FASE4_MENU_PRINCIPAL.md para o motivo de ter virado uma página nova
// (menu.html) em vez de reaproveitar um "shell" que, na prática, não existia.
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "menu.html")));

// Endpoint simples de diagnóstico — o texto que antes vivia em "/".
app.get("/status", (req, res) => {
  res.send("Lia Effect rodando — modo supervisor + Linhares via planilha ✅");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ── ALARME DE ENTREGA ────────────────────────────────────────────────────────
// A Meta envia neste mesmo webhook o STATUS de cada mensagem enviada (sent,
// delivered, read, failed). Antes o código ignorava tudo isso — quando uma
// entrega falhava (janela 24h, número sem WhatsApp, limite da Meta etc.), a
// falha era invisível: aparecia como "enviada" no Inbox e ninguém ficava
// sabendo. Agora, toda falha dispara alarme no WhatsApp da Thiara e registra
// aviso na conversa do candidato.
const ERROS_META_EXPLICACAO = {
  131047: "Fora da janela de 24h — só é possível enviar template aprovado",
  131026: "Mensagem não entregável — número pode não ter WhatsApp ou bloqueou o contato",
  131048: "Limite de spam atingido — qualidade do número em risco",
  131049: "Meta limitou o envio para proteger o engajamento do usuário",
  130472: "Usuário faz parte de experimento da Meta — envio bloqueado",
  131053: "Falha no upload de mídia",
  100: "Parâmetro inválido no envio (verificar template/telefone)"
};
const ALERTAS_FALHA_ENVIADOS = {}; // { telefone: timestampMs } — evita spam de alarme
const INTERVALO_MIN_ALERTA_FALHA_MS = 30 * 60 * 1000; // no máx. 1 alarme por candidato a cada 30min

async function tratarStatusEntrega(st) {
  try {
    if (!st || st.status !== "failed") return;
    const tel = limparTelefone(st.recipient_id || "");
    if (!tel) return;
    const erros = Array.isArray(st.errors) ? st.errors : [];
    const detalhes = erros.map(e => {
      const explicacao = ERROS_META_EXPLICACAO[e.code] || e.error_data?.details || e.message || e.title || "";
      return `[${e.code}] ${e.title || ""}${explicacao ? " — " + explicacao : ""}`.trim();
    }).join("\n") || "Motivo não informado pela Meta";

    console.error(`[ENTREGA FALHOU] ${tel}: ${detalhes}`);
    try { supervisor.registrarErroMeta(`Entrega falhou: ${detalhes}`, tel); } catch (_) {}

    // Registra o aviso DENTRO da conversa do candidato (visível no Inbox)
    const sessao = garantirSessao(tel);
    registrarEntradaSessao(sessao, "assistant", `⚠️ [ALERTA DO SISTEMA] A última mensagem NÃO FOI ENTREGUE a este candidato.\nMotivo: ${detalhes}`);
    sessao.unreadCount = Number(sessao.unreadCount || 0) + 1; // destaca a conversa como não lida
    salvarMensagemSheets(tel, "assistant", `[FALHA DE ENTREGA] ${detalhes}`, sessao.nome || "").catch(() => {});

    // Alarme no WhatsApp da Thiara (com trava anti-spam por candidato)
    const agora = Date.now();
    if (agora - (ALERTAS_FALHA_ENVIADOS[tel] || 0) > INTERVALO_MIN_ALERTA_FALHA_MS) {
      ALERTAS_FALHA_ENVIADOS[tel] = agora;
      const nome = sessao.nome || "Nome não identificado";
      const alerta = `🚨 *MENSAGEM NÃO ENTREGUE*\n\n👤 Candidato: ${nome}\n📱 +${tel}\n\n❌ Motivo:\n${detalhes}\n\n👉 Abra o Inbox e verifique esta conversa.`;
      await enviarMensagem(CONFIG.THIARA_WHATSAPP, alerta).catch(e => console.error("Erro ao enviar alarme de entrega:", e.message));
    }
  } catch (e) {
    console.error("Erro em tratarStatusEntrega:", e.message);
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    // Eventos de STATUS de entrega (sent/delivered/read/failed)
    const statuses = req.body.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (Array.isArray(statuses) && statuses.length) {
      for (const st of statuses) await tratarStatusEntrega(st);
      return;
    }

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    if (message.id && mensagensProcessadas.has(message.id)) return;
    if (message.id) { mensagensProcessadas.add(message.id); if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear(); }
    if (!message.text?.body && !message.document && !message.audio) return;
    const from = limparTelefone(message.from);
    const sessaoAtual = garantirSessao(from);
    const messageTimestampMs = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();

    // ── REDIRECIONAMENTO TOTAL: se ativo, ignora todo o fluxo normal da Lia
    // (texto, áudio ou documento) e responde só com o convite pro novo número.
    if (CONFIG.REDIRECIONAMENTO_ATIVO) {
      const conteudoRecebido = message.text?.body
        ? message.text.body
        : message.audio
        ? "[Áudio recebido]"
        : "[Documento/Currículo recebido]";
      await tratarRedirecionamentoTotal(from, conteudoRecebido, messageTimestampMs);
      return;
    }

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
app.get("/nf-upload.html", (req, res) => res.sendFile(path.join(__dirname, "nf-upload.html")));

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
    const nivel = String(req.body.nivel || 'administrativo').trim().toLowerCase();
    const percentuaisNatural = req.body.percentuaisNatural || {};
    const percentuaisAdaptado = req.body.percentuaisAdaptado || {};
    const primarioNatural = req.body.primarioNatural || '';
    const primarioAdaptado = req.body.primarioAdaptado || '';
    const secundarioNatural = req.body.secundarioNatural || null;
    const relatorioRH = req.body.relatorioRH || null;
    const relatorioGestor = req.body.relatorioGestor || null;

    const resultado = {
      respondidoEm: new Date().toISOString(),
      nome, vaga, nivel,
      percentuaisNatural,
      percentuaisAdaptado,
      primario: primarioNatural,          // compatibilidade com inbox
      primarioNatural,
      primarioAdaptado,
      secundario: secundarioNatural,
      secundarioNatural,
      relatorioRH,
      relatorioGestor
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
  const NIVEL_LABEL = {operacional:'Operacional', administrativo:'Administrativo', estrategico:'Estratégico'};
  const nivelLabel = NIVEL_LABEL[d.nivel || rh?.nivel] || '';

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
    const insights = [m.nota, m.tend].filter(Boolean);
    return `<div style="background:#f0fdf4;border:1.5px solid ${cor};border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <div style="font-size:28px;font-weight:800;color:${cor}">${m.score}%</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:${cor}">${emoji} ${m.lbl||'Compatibilidade'} com a vaga</div>
          <div style="font-size:11px;color:#6b7280">${rh.vaga||'vaga não especificada'}</div>
        </div>
      </div>
      ${insights.length?insights.map(i=>`<div style="font-size:12px;color:#374151;margin-bottom:4px">• ${i}</div>`).join(''):''}
    </div>`;
  })() : '';

  const aderenciaBloco = rh?.aderenciaNivel ? (() => {
    const a = rh.aderenciaNivel;
    const cor = a.score >= 80 ? '#16a34a' : a.score >= 60 ? '#1fa5f0' : a.score >= 40 ? '#d97706' : '#dc2626';
    return `<div style="background:#f8fafc;border:1.5px solid ${cor};border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:24px;font-weight:800;color:${cor}">${a.score}%</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:${cor}">${a.label} ao nível ${a.nivelLabel||''}</div>
          <div style="font-size:11px;color:#6b7280">Leitura auxiliar comparando o perfil natural com o perfil DISC típico esperado para cargos deste nível — não substitui a avaliação da vaga específica.</div>
        </div>
      </div>
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
        <div style="font-size:12px;color:#a1a1aa;margin-top:2px">${data} · ${d.vaga||'Vaga não informada'}${nivelLabel?' · Nível '+nivelLabel:''}</div>
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

  ${aderenciaBloco}
  ${matchBloco}
  ${tensaoBloco}
  ${comboBloco}
  ${rhBloco}

  <button onclick="window.print()" style="background:#2a2a2b;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:24px;width:100%">🖨️ Imprimir / Salvar PDF</button>
  </body></html>`;
  res.send(html);
});

// Relatório para o GESTOR — diferente do relatório de RH: aqui o foco é
// "como gerenciar essa pessoa no dia a dia" (comunicação, delegação,
// onboarding, motivação, sinais de alerta), não critérios de contratação.
app.get("/disc/resultado-gestor/:telefone", (req, res) => {
  const tel = limparTelefone(req.params.telefone);
  const sessao = sessoes[tel];
  if (!sessao?.discResult) return res.send('<h3>Sem resultado DISC para este candidato.</h3>');
  const d = sessao.discResult;
  const g = d.relatorioGestor || null;
  const nome = d.nome || sessao.nome || tel;
  const CORES = {D:'#dc2626',I:'#d97706',S:'#16a34a',C:'#2563eb'};
  const NOMES = {D:'Dominante',I:'Influente',S:'Estável',C:'Criterioso'};
  const EMOJIS = {D:'🔴',I:'🟡',S:'🟢',C:'🔵'};
  const pctN = d.percentuaisNatural || d.percentuais || {};
  const data = new Date(d.respondidoEm||Date.now()).toLocaleDateString('pt-BR');
  const NIVEL_LABEL = {operacional:'Operacional', administrativo:'Administrativo', estrategico:'Estratégico'};
  const nivelLabel = NIVEL_LABEL[d.nivel || g?.nivel] || '';

  if (!g) {
    return res.send('<h3>Este candidato respondeu o teste antes da versão com relatório do gestor. Peça para refazer o teste para gerar esta visão.</h3>');
  }

  function barras(pct) {
    return ['D','I','S','C'].map(k=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="font-size:11px;font-weight:800;color:${CORES[k]};width:12px">${k}</div>
      <div style="flex:1;background:#e8ecf1;border-radius:999px;height:11px;overflow:hidden">
        <div style="width:${pct[k]||0}%;height:100%;background:${CORES[k]};border-radius:999px"></div></div>
      <div style="font-size:11px;font-weight:700;color:#6b7280;width:28px;text-align:right">${pct[k]||0}%</div>
    </div>`).join('');
  }

  function bloco(emoji, titulo, texto, cor='#1e3a5f') {
    if (!texto) return '';
    return `<div class="card">
      <div style="font-size:12.5px;font-weight:800;color:${cor};margin-bottom:8px">${emoji} ${titulo}</div>
      <p style="font-size:12.5px;color:#374151;line-height:1.6">${texto}</p>
    </div>`;
  }

  const aderenciaBloco = g.aderenciaNivel ? (() => {
    const a = g.aderenciaNivel;
    const cor = a.score >= 80 ? '#16a34a' : a.score >= 60 ? '#1fa5f0' : a.score >= 40 ? '#d97706' : '#dc2626';
    return `<div style="background:#f8fafc;border:1.5px solid ${cor};border-radius:12px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:24px;font-weight:800;color:${cor}">${a.score}%</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:${cor}">${a.label} ao nível ${a.nivelLabel||''}</div>
          <div style="font-size:11px;color:#6b7280">Comparação do perfil natural com o perfil DISC típico esperado para cargos deste nível.</div>
        </div>
      </div>
    </div>`;
  })() : '';

  const perguntasBloco = (g.perguntasAlinhamento||[]).length ? `
    <div class="card">
      <div style="font-size:12.5px;font-weight:800;color:#1e3a5f;margin-bottom:10px">💬 Perguntas para usar nas primeiras conversas 1:1</div>
      ${g.perguntasAlinhamento.map((p,i)=>`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:800;color:#a1a1aa;margin-bottom:3px">PERGUNTA ${i+1}</div><p style="font-size:12.5px;color:#374151;line-height:1.5">${p}</p></div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>DISC Gestor — ${nome}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Montserrat',sans-serif;background:#f5f7fa;padding:24px 16px;max-width:680px;margin:0 auto}
    .card{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 1px 5px rgba(0,0,0,.08);margin-bottom:14px}
    .logo{font-size:14px;font-weight:800;color:#2a2a2b;margin-bottom:18px}.logo span{color:#8ed1b2}
    @media print{body{background:#fff;padding:10px}.card{box-shadow:none;border:1px solid #e5e7eb;break-inside:avoid}}
  </style></head><body>
  <div class="logo">Effect <span>Pessoas</span> · Guia para o Gestor</div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <div>
        <div style="font-size:18px;font-weight:800;color:#2a2a2b">${EMOJIS[d.primarioNatural||d.primario]||''} ${nome}</div>
        <div style="font-size:12px;color:#a1a1aa;margin-top:2px">${data} · ${d.vaga||'Vaga não informada'}${nivelLabel?' · Nível '+nivelLabel:''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:700;color:${CORES[d.primarioNatural||d.primario]||'#374151'}">${NOMES[d.primarioNatural||d.primario]||''}${d.secundarioNatural?' / '+NOMES[d.secundarioNatural]:''}</div>
        <div style="font-size:11px;color:#a1a1aa">Perfil predominante</div>
      </div>
    </div>
    <div style="margin-bottom:10px">${barras(pctN)}</div>
    <p style="font-size:12.5px;color:#374151;line-height:1.6">${g.resumo||''}</p>
  </div>

  ${aderenciaBloco}
  ${bloco('👔','Como gerenciar no dia a dia', g.comoGerenciar)}
  ${bloco('💬','Como se comunicar melhor com essa pessoa', g.comoComunicar)}
  ${bloco('📋','Como delegar tarefas', g.comoDelegar)}
  ${bloco('🚀','Primeiros dias / onboarding', g.primeirosDias)}
  ${bloco('🎯','O que motiva essa pessoa', g.gatilhosMotivacao,'#16a34a')}
  ${bloco('⚠️','Sinais de alerta para acompanhar', g.sinaisAlerta,'#dc2626')}
  ${perguntasBloco}

  <button onclick="window.print()" style="background:#2a2a2b;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:24px;width:100%">🖨️ Imprimir / Salvar PDF</button>
  </body></html>`;
  res.send(html);
});

// ═══════════════════════════════════════════════════════════════════════
// DISC SÓLIDES — formato separado (marcação de adjetivos em lista única),
// guarda o resultado em discSolidesResult para não conflitar com o
// teste clássico (discResult) do disc.html
// ═══════════════════════════════════════════════════════════════════════
app.get("/disc-solides/:telefone", (req, res) => res.sendFile(path.join(__dirname, "disc-solides.html")));

app.post("/disc-solides/submit", async (req, res) => {
  try {
    const telefone = limparTelefone(req.body.telefone || '');
    const nome = String(req.body.nome || '').trim();
    const vaga = String(req.body.vaga || '').trim();
    const nivel = String(req.body.nivel || 'administrativo').trim().toLowerCase();
    const percentuaisNatural = req.body.percentuaisNatural || {};
    const percentuaisMeio = req.body.percentuaisMeio || {};
    const primario = req.body.primario || '';
    const secundario = req.body.secundario || null;
    const relatorioRH = req.body.relatorioRH || null;
    const relatorioGestor = req.body.relatorioGestor || null;
    const palavrasNatural = req.body.palavrasNatural || [];
    const palavrasMeio = req.body.palavrasMeio || [];

    const resultado = {
      respondidoEm: new Date().toISOString(),
      nome, vaga, nivel,
      percentuaisNatural, percentuaisMeio,
      primario, secundario,
      palavrasNatural, palavrasMeio,
      relatorioRH, relatorioGestor
    };

    if (telefone && sessoes[telefone]) {
      sessoes[telefone].discSolidesResult = resultado;
      if (nome && !sessoes[telefone].nome) sessoes[telefone].nome = nome;
    }

    await salvarDiscNoDrive(telefone, nome, resultado, 'solides').catch(e => console.error('Erro DISC Sólides Drive:', e.message));

    if (telefone) {
      const nomeFirst = (nome || 'Candidato').split(' ')[0];
      const perfisDesc = { D: 'Executor', I: 'Comunicador', S: 'Planejador', C: 'Analista' };
      const descPrimario = perfisDesc[primario] || primario || '';
      const msgConfirm = `✅ ${nomeFirst}, recebemos seu questionário comportamental!\n\nSeu perfil predominante é *${primario}${descPrimario ? ' — ' + descPrimario : ''}*. Nossa equipe irá considerar essas informações na avaliação do seu perfil. 💙`;
      enviarMensagem(telefone, msgConfirm).catch(e => console.error('Erro ao notificar DISC Sólides:', e.message));
      if (sessoes[telefone]) {
        salvarConversaCompletaSheets(telefone, sessoes[telefone].historico, sessoes[telefone].nome || nome || '').catch(()=>{});
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('Erro /disc-solides/submit:', e.message);
    return res.json({ ok: false, erro: e.message });
  }
});

app.get("/disc-solides/resultado/:telefone", (req, res) => {
  const tel = limparTelefone(req.params.telefone);
  const sessao = sessoes[tel];
  if (!sessao?.discSolidesResult) return res.json({ ok: false });
  return res.json({ ok: true, resultado: sessao.discSolidesResult });
});

app.get("/disc-solides/resultado-view/:telefone", (req, res) => {
  const tel = limparTelefone(req.params.telefone);
  const sessao = sessoes[tel];
  if (!sessao?.discSolidesResult) return res.send('<h3>Sem resultado do Profiler para este candidato.</h3>');
  const d = sessao.discSolidesResult;
  const rh = d.relatorioRH || null;
  const nome = d.nome || sessao.nome || tel;
  const CORES = {D:'#dc2626',I:'#d97706',S:'#16a34a',C:'#2563eb'};
  const NOMES = {D:'Executor',I:'Comunicador',S:'Planejador',C:'Analista'};
  const pctN = d.percentuaisNatural || {};
  const data = new Date(d.respondidoEm||Date.now()).toLocaleDateString('pt-BR');
  const NIVEL_LABEL = {operacional:'Operacional', administrativo:'Administrativo', estrategico:'Estratégico'};
  const nivelLabel = NIVEL_LABEL[d.nivel || rh?.nivel] || '';

  if (!rh) return res.send('<h3>Relatório de RH indisponível para este resultado.</h3>');

  function barras(pct) {
    return ['D','I','S','C'].map(k=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="font-size:10.5px;font-weight:800;color:${CORES[k]};width:74px">${NOMES[k]}</div>
      <div style="flex:1;background:#e8ecf1;border-radius:999px;height:11px;overflow:hidden">
        <div style="width:${pct[k]||0}%;height:100%;background:${CORES[k]};border-radius:999px"></div></div>
      <div style="font-size:11px;font-weight:700;color:#6b7280;width:28px;text-align:right">${pct[k]||0}%</div>
    </div>`).join('');
  }
  function lista(arr, cor='#374151') {
    if (!arr||!arr.length) return '<p style="color:#a1a1aa;font-size:12px">—</p>';
    return arr.map(i=>`<div style="display:flex;gap:8px;margin-bottom:5px"><span style="color:${cor};font-size:13px">•</span><span style="font-size:12.5px;color:#374151;line-height:1.5">${i}</span></div>`).join('');
  }
  function sec(titulo) { return `<div style="font-size:10px;font-weight:800;color:#a1a1aa;text-transform:uppercase;letter-spacing:.07em;margin:18px 0 8px">${titulo}</div>`; }

  const aderenciaBloco = rh.aderenciaNivel ? (() => {
    const a = rh.aderenciaNivel;
    const cor = a.score >= 80 ? '#16a34a' : a.score >= 60 ? '#1fa5f0' : a.score >= 40 ? '#d97706' : '#dc2626';
    return `<div style="background:#faf5ff;border:1.5px solid ${cor};border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:24px;font-weight:800;color:${cor}">${a.score}%</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:${cor}">${a.label} ao nível ${a.nivelLabel||''}</div>
          <div style="font-size:11px;color:#6b7280">Comparação do perfil natural com o perfil típico esperado para cargos deste nível.</div>
        </div>
      </div>
    </div>`;
  })() : '';

  const matchBloco = rh.match ? `
    <div style="background:#f0fdf4;border:1.5px solid #16a34a;border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:24px;font-weight:800;color:#16a34a">${rh.match.score}%</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:#16a34a">${rh.match.lbl} — ${rh.match.vagaLbl||rh.vaga}</div>
          <div style="font-size:11px;color:#6b7280">${rh.match.nota||''}</div>
        </div>
      </div>
    </div>` : '';

  const indicadoresBloco = (rh.indicadores||[]).map(it => `
    <div style="margin-bottom:9px">
      <div style="font-size:11.5px;font-weight:700;color:#374151">${it.nome} — <span style="color:#6d28d9">${it.faixa}</span></div>
      <div style="background:#ece7fb;border-radius:99px;height:7px;overflow:hidden;margin-top:3px"><div style="width:${it.score}%;height:100%;background:#6d28d9"></div></div>
    </div>`).join('');

  const competenciasBloco = (rh.competencias||[]).map(c => `
    <div style="display:flex;gap:8px;margin-bottom:6px;font-size:12px"><span style="color:#a1a1aa;width:16px">${c.num}</span><span style="flex:1;color:#374151">${c.nome}</span><span style="font-weight:800;color:#6d28d9">${c.faixa}</span></div>`).join('');

  const talentosBloco = (rh.talentos||[]).map(t => `
    <div style="display:flex;gap:8px;margin-bottom:6px;font-size:12px"><span style="color:#a1a1aa;width:16px">${t.num}</span><span style="flex:1;color:#374151">${t.nome}</span><span style="font-weight:800;color:#6d28d9">${t.faixa}</span></div>`).join('');

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Profiler RH — ${nome}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Montserrat',sans-serif;background:#f5f3ff;padding:24px 16px;max-width:680px;margin:0 auto}
    .card{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 1px 5px rgba(0,0,0,.08);margin-bottom:14px}
    .logo{font-size:14px;font-weight:800;color:#2a2a2b;margin-bottom:18px}.logo span{color:#8ed1b2}
    @media print{body{background:#fff;padding:10px}.card{box-shadow:none;border:1px solid #e5e7eb;break-inside:avoid}}
  </style></head><body>
  <div class="logo">Effect <span>Pessoas</span> · Relatório de Seleção (Profiler)</div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:16px">
      <div>
        <div style="font-size:18px;font-weight:800;color:#2a2a2b">${nome}</div>
        <div style="font-size:12px;color:#a1a1aa;margin-top:2px">${data} · ${d.vaga||'Vaga não informada'}${nivelLabel?' · Nível '+nivelLabel:''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:700;color:${CORES[d.primario]||'#374151'}">${NOMES[d.primario]||''}${d.secundario?' / '+NOMES[d.secundario]:''}</div>
        <div style="font-size:11px;color:#a1a1aa">Perfil predominante</div>
      </div>
    </div>
    ${barras(pctN)}
  </div>

  ${aderenciaBloco}
  ${matchBloco}

  <div class="card">
    <div style="font-size:13px;font-weight:800;color:#4c1d95;margin-bottom:14px">📋 ANÁLISE PARA SELEÇÃO</div>
    ${sec('Resumo do perfil')}
    <p style="font-size:12.5px;color:#374151;line-height:1.6;margin-bottom:8px">${rh.resumoRH||''}</p>
    ${sec('Ambientes com fit')}
    ${lista(rh.ambientesFit,'#16a34a')}
    ${sec('Ambientes de risco')}
    ${lista(rh.ambientesRisco,'#dc2626')}
    ${sec('Liderança ideal')}
    <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.liderancaFit||''}</p>
    ${sec('Conflito')} <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.conflito||''}</p>
    ${sec('Motivação')} <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.motivacao||''}</p>
    ${sec('Retenção')} <p style="font-size:12.5px;color:#374151;line-height:1.5">${rh.retencao||''}</p>
  </div>

  <div class="card">
    <div style="font-size:13px;font-weight:800;color:#4c1d95;margin-bottom:12px">Indicadores situacionais</div>
    <div style="font-size:11px;color:#9ca3af;line-height:1.5;margin-bottom:10px">Fatores que mostram como o candidato se comporta neste momento (energia, autoconfiança, flexibilidade etc.), calculados pela proporção de respostas positivas x negativas marcadas em cada perfil.</div>
    ${indicadoresBloco}
  </div>

  <div class="card">
    <div style="font-size:13px;font-weight:800;color:#4c1d95;margin-bottom:12px">Competências</div>
    <div style="font-size:11px;color:#9ca3af;line-height:1.5;margin-bottom:10px">Estimativa de 20 competências comportamentais a partir da combinação dos 4 perfis (D/I/S/C) — não são perguntas respondidas separadamente, e sim uma leitura derivada do perfil geral.</div>
    ${competenciasBloco}
  </div>

  <div class="card">
    <div style="font-size:13px;font-weight:800;color:#4c1d95;margin-bottom:12px">Área de talentos</div>
    <div style="font-size:11px;color:#9ca3af;line-height:1.5;margin-bottom:10px">Áreas em que a energia do candidato tende a fluir com mais naturalidade, cruzando Emoção x Razão e Extroversão x Introversão. Indica afinidade, não performance garantida.</div>
    ${talentosBloco}
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
    <div style="font-size:13px;font-weight:800;color:#4c1d95;margin-bottom:12px">❓ Perguntas sugeridas para entrevista</div>
    ${(rh.perguntasEntrevista||[]).map((p,i)=>`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:800;color:#a1a1aa;margin-bottom:3px">PERGUNTA ${i+1}</div><p style="font-size:12.5px;color:#374151;line-height:1.5">${p}</p></div>`).join('')}
  </div>

  <button onclick="window.print()" style="background:#2a2a2b;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:24px;width:100%">🖨️ Imprimir / Salvar PDF</button>
  </body></html>`;
  res.send(html);
});

app.get("/disc-solides/resultado-gestor/:telefone", (req, res) => {
  const tel = limparTelefone(req.params.telefone);
  const sessao = sessoes[tel];
  if (!sessao?.discSolidesResult) return res.send('<h3>Sem resultado do Profiler para este candidato.</h3>');
  const d = sessao.discSolidesResult;
  const g = d.relatorioGestor || null;
  const nome = d.nome || sessao.nome || tel;
  const CORES = {D:'#dc2626',I:'#d97706',S:'#16a34a',C:'#2563eb'};
  const NOMES = {D:'Executor',I:'Comunicador',S:'Planejador',C:'Analista'};
  const pctN = d.percentuaisNatural || {};
  const data = new Date(d.respondidoEm||Date.now()).toLocaleDateString('pt-BR');
  const NIVEL_LABEL = {operacional:'Operacional', administrativo:'Administrativo', estrategico:'Estratégico'};
  const nivelLabel = NIVEL_LABEL[d.nivel || g?.nivel] || '';

  if (!g) return res.send('<h3>Este candidato respondeu o teste antes da versão com relatório do gestor.</h3>');

  function barras(pct) {
    return ['D','I','S','C'].map(k=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="font-size:10.5px;font-weight:800;color:${CORES[k]};width:74px">${NOMES[k]}</div>
      <div style="flex:1;background:#e8ecf1;border-radius:999px;height:11px;overflow:hidden">
        <div style="width:${pct[k]||0}%;height:100%;background:${CORES[k]};border-radius:999px"></div></div>
      <div style="font-size:11px;font-weight:700;color:#6b7280;width:28px;text-align:right">${pct[k]||0}%</div>
    </div>`).join('');
  }
  function bloco(emoji, titulo, texto, cor='#4c1d95') {
    if (!texto) return '';
    return `<div class="card"><div style="font-size:12.5px;font-weight:800;color:${cor};margin-bottom:8px">${emoji} ${titulo}</div><p style="font-size:12.5px;color:#374151;line-height:1.6">${texto}</p></div>`;
  }

  const aderenciaBloco = g.aderenciaNivel ? (() => {
    const a = g.aderenciaNivel;
    const cor = a.score >= 80 ? '#16a34a' : a.score >= 60 ? '#1fa5f0' : a.score >= 40 ? '#d97706' : '#dc2626';
    return `<div style="background:#faf5ff;border:1.5px solid ${cor};border-radius:12px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="font-size:24px;font-weight:800;color:${cor}">${a.score}%</div>
        <div><div style="font-size:13px;font-weight:700;color:${cor}">${a.label} ao nível ${a.nivelLabel||''}</div></div>
      </div>
    </div>`;
  })() : '';

  const perguntasBloco = (g.perguntasAlinhamento||[]).length ? `
    <div class="card">
      <div style="font-size:12.5px;font-weight:800;color:#4c1d95;margin-bottom:10px">💬 Perguntas para usar nas primeiras conversas 1:1</div>
      ${g.perguntasAlinhamento.map((p,i)=>`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:800;color:#a1a1aa;margin-bottom:3px">PERGUNTA ${i+1}</div><p style="font-size:12.5px;color:#374151;line-height:1.5">${p}</p></div>`).join('')}
    </div>` : '';

  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Profiler Gestor — ${nome}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Montserrat',sans-serif;background:#f5f3ff;padding:24px 16px;max-width:680px;margin:0 auto}
    .card{background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 1px 5px rgba(0,0,0,.08);margin-bottom:14px}
    .logo{font-size:14px;font-weight:800;color:#2a2a2b;margin-bottom:18px}.logo span{color:#8ed1b2}
    @media print{body{background:#fff;padding:10px}.card{box-shadow:none;border:1px solid #e5e7eb;break-inside:avoid}}
  </style></head><body>
  <div class="logo">Effect <span>Pessoas</span> · Guia para o Gestor (Profiler)</div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:14px">
      <div>
        <div style="font-size:18px;font-weight:800;color:#2a2a2b">${nome}</div>
        <div style="font-size:12px;color:#a1a1aa;margin-top:2px">${data} · ${d.vaga||'Vaga não informada'}${nivelLabel?' · Nível '+nivelLabel:''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:700;color:${CORES[d.primario]||'#374151'}">${NOMES[d.primario]||''}${d.secundario?' / '+NOMES[d.secundario]:''}</div>
        <div style="font-size:11px;color:#a1a1aa">Perfil predominante</div>
      </div>
    </div>
    ${barras(pctN)}
    <p style="font-size:12.5px;color:#374151;line-height:1.6;margin-top:10px">${g.resumo||''}</p>
  </div>

  ${aderenciaBloco}
  ${bloco('👔','Como gerenciar no dia a dia', g.comoGerenciar)}
  ${bloco('💬','Como se comunicar melhor com essa pessoa', g.comoComunicar)}
  ${bloco('📋','Como delegar tarefas', g.comoDelegar)}
  ${bloco('🚀','Primeiros dias / onboarding', g.primeirosDias)}
  ${bloco('🎯','O que motiva essa pessoa', g.gatilhosMotivacao,'#16a34a')}
  ${bloco('⚠️','Sinais de alerta para acompanhar', g.sinaisAlerta,'#dc2626')}
  ${perguntasBloco}

  <button onclick="window.print()" style="background:#2a2a2b;color:#fff;border:none;border-radius:10px;padding:12px 24px;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:24px;width:100%">🖨️ Imprimir / Salvar PDF</button>
  </body></html>`;
  res.send(html);
});

async function salvarDiscNoDrive(telefone, nome, resultado, tipo) {
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
  const prefixo = tipo === 'solides' ? 'DISC-Solides' : 'DISC';
  const nomeArq = `${prefixo}-${(nome||telefone).replace(/\s+/g,'-')}-${telefone}-${ts}.json`;
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
// Página HTML (imprimível/salvável em PDF pelo navegador) com os dados de
// contrato de uma solicitação específica.
app.get("/cliente/contrato/:id", (req, res) => {
  const lista = lerContratos();
  const d = lista.find(x => x.contratoId === req.params.id);
  if (!d) return res.status(404).send("<p style='font-family:sans-serif;padding:40px'>Contrato não encontrado (ou o link expirou).</p>");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(paginaContrato(d));
});

// Lista de todas as solicitações recebidas, com link para cada contrato —
// útil caso a mensagem de WhatsApp com o link individual se perca.
app.get("/cliente/contratos", (req, res) => {
  const lista = lerContratos();
  const linhas = lista.map(d => `<tr>
    <td>${escapeHtml(d.criadoEm ? new Date(d.criadoEm).toLocaleString('pt-BR') : '')}</td>
    <td>${escapeHtml(d.empresa_nome)}</td>
    <td>${escapeHtml(Array.isArray(d.vagas) && d.vagas.length ? d.vagas.map(v => v.cargo).filter(Boolean).join(', ') : d.vaga_cargo)}</td>
    <td>${escapeHtml(d.contrato_valor)}</td>
    <td><a href="/cliente/contrato/${escapeHtml(d.contratoId)}" target="_blank">Abrir ↗</a></td>
  </tr>`).join('');
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<title>Contratos recebidos — Effect</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
body{font-family:'Montserrat',sans-serif;background:#f5f7fa;color:#2a2a2b;padding:32px}
h1{color:#1a2a4a;font-size:20px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.06)}
th,td{text-align:left;padding:12px 14px;font-size:13px;border-bottom:1px solid #eef0f3}
th{background:#1a2a4a;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
tr:last-child td{border-bottom:none}
a{color:#1fa5ff;font-weight:700;text-decoration:none}
</style></head><body>
<h1>Solicitações recebidas — dados de contrato</h1>
<table><thead><tr><th>Data</th><th>Empresa</th><th>Cargo</th><th>Valor</th><th></th></tr></thead>
<tbody>${linhas || '<tr><td colspan="5">Nenhuma solicitação ainda.</td></tr>'}</tbody></table>
</body></html>`);
});

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

    let msgEnviada = false;
    let erroOriginal = null;
    let usouTemplate = false;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // BUG CORRIGIDO: antes só caía para template se a Meta RECUSASSE o envio
    // na hora. Mas a Meta muitas vezes aceita (200) e descarta depois — a
    // mensagem aparecia como enviada no Inbox e o candidato nunca recebia.
    // Agora verifica a janela de 24h ANTES: se a última mensagem do candidato
    // foi há mais de 24h, envia direto o template aprovado.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const janelaFechada = foraDaJanela24h(sessoes[resolverTelefoneCanonico(telefone)] || sessao);
    try {
      if (janelaFechada) throw new Error("[131047] Janela de 24h fechada (verificação proativa)");
      await enviarMensagem(telefone, mensagem);
      msgEnviada = true;
      console.log(`[ENVIAR] ✅ Mensagem livre enviada: ${telefone}`);
    } catch (e) {
      erroOriginal = e.message;

      // Se falhar com erro 131047 (fora da janela 24h), tentar TEMPLATE
      const foraJanela = String(e.message || "").includes("131047") ||
                        String(e.message || "").toLowerCase().includes("re-engagement");

      if (foraJanela) {
        console.log(`[ENVIAR] ⚠️  Fora da janela 24h, tentando template...`);

        const resultTemplate = await enviarTemplate(
          telefone,
          CONFIG.TEMPLATE_DIVULGACAO_VAGA || "effect_reengajamento_candidatos",
          "pt_BR"
        );

        if (resultTemplate.sucesso) {
          msgEnviada = true;
          usouTemplate = true;
          console.log(`[ENVIAR] ✅ Enviado via TEMPLATE: ${telefone}`);
        } else {
          console.error(`[ENVIAR] ❌ Template falhou: ${resultTemplate.erro}`);
          return res.json({
            ok: false,
            erro: `Não foi possível enviar: ${resultTemplate.erro}`,
            detalhes: `Mensagem livre falhou: ${erroOriginal} | Template também falhou`
          });
        }
      } else {
        // Erro não é "fora da janela", é outro erro
        return res.json({ ok: false, erro: erroOriginal });
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Se conseguiu enviar (livre ou template), registrar no histórico
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (msgEnviada) {
      const textoRegistro = usouTemplate
        ? `[Enviado via Template - fora da janela 24h]\n\n${mensagem}`
        : mensagem;

      const eventoSalvo = registrarEntradaSessao(sessao, "assistant", textoRegistro);
      marcarConversaRespondida(sessao);
      sessao.historico = sessao.historico.slice(-500);

      await salvarMensagemSheets(telefone, "assistant", textoRegistro, sessao.nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

      return res.json({
        ok: true,
        telefone,
        modo: "manual",
        pausado: true,
        mensagem: eventoSalvo,
        historicoLength: sessao.historico.length,
        metodo: usouTemplate ? "template" : "mensagem_livre",
        status: "✅ Enviado com sucesso"
      });
    }

    return res.json({ ok: false, erro: "Falha desconhecida ao enviar" });

  } catch (erro) {
    console.error(`[ENVIAR] Erro: ${erro.message}`);
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

// Verifica se um buffer recuperado de memória/disco realmente é o arquivo (e não
// um pedaço truncado/corrompido). Causa real do "Falha ao carregar o documento
// PDF" recorrente: quando o processo reinicia (ex.: um novo deploy no Railway),
// a sessão em memória é perdida e o currículo pode ser recuperado do Sheets —
// mas células do Sheets têm limite de ~50.000 caracteres, então um PDF em
// base64 (normalmente bem maior que isso) chega cortado ao meio. Sem essa
// checagem, o servidor mandava esse pedaço truncado pro navegador como se
// fosse o PDF inteiro, e o visualizador de PDF do Chrome falhava ao abrir.
function bufferDeCurriculoValido(buffer, mimeType, filename) {
  if (!buffer || !buffer.length) return false;
  const nomeLower = String(filename || "").toLowerCase();
  const ehPdf = String(mimeType || "").includes("pdf") || nomeLower.endsWith(".pdf");
  if (!ehPdf) return true; // só validamos a assinatura de PDF; outros tipos passam direto
  return buffer.slice(0, 5).toString("latin1") === "%PDF-";
}

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

  if (buffer && !bufferDeCurriculoValido(buffer, cv.mimeType, cv.filename)) {
    console.error(`⚠️ Currículo truncado/corrompido em memória — ${sessao?.nome || tel} — ${cv.filename} — ignorando e tentando Drive.`);
    buffer = null;
  }

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

// ── Rota de emergência: reenvia pro Drive currículos que ficaram presos só em
// memória/local (base64 ou arquivo em /tmp) porque o upload original falhou —
// por exemplo, quando o armazenamento do Drive estava cheio. Esses arquivos
// não sobrevivem a um reinício do Railway (/tmp é apagado), então rode esta
// rota manualmente (POST) assim que o problema no Drive for resolvido, antes
// de fazer qualquer novo deploy/restart, pra não perdê-los de vez.
app.post("/inbox/curriculos/retentar-drive", async (req, res) => {
  const resultado = { tentados: 0, sucesso: 0, falha: 0, semArquivo: 0, detalhes: [] };
  for (const [tel, sessao] of Object.entries(sessoes)) {
    const lista = Array.isArray(sessao?.curriculos) ? sessao.curriculos : [];
    let algumAtualizado = false;
    for (const cv of lista) {
      if (cv.driveLink) continue; // já está salvo, não precisa reenviar

      let buffer = null;
      if (cv.base64) buffer = Buffer.from(cv.base64, "base64");
      else if (cv.localPath && fs.existsSync(cv.localPath)) buffer = fs.readFileSync(cv.localPath);
      if (!buffer || !buffer.length) { resultado.semArquivo++; continue; }

      resultado.tentados++;
      try {
        const info = await uploadCurriculoDrive(buffer, cv.filename || `curriculo_${tel}`, "Currículos Recebidos", tel, cv.mimeType);
        if (info?.link) {
          cv.driveLink = info.link;
          cv.pasta = info.pasta;
          cv.analiseStatus = "salvo_drive";
          algumAtualizado = true;
          resultado.sucesso++;
          resultado.detalhes.push({ telefone: tel, nome: sessao.nome || null, filename: cv.filename, ok: true });
        } else {
          resultado.falha++;
          resultado.detalhes.push({ telefone: tel, nome: sessao.nome || null, filename: cv.filename, ok: false, erro: "upload retornou sem link" });
        }
      } catch (e) {
        resultado.falha++;
        resultado.detalhes.push({ telefone: tel, nome: sessao.nome || null, filename: cv.filename, ok: false, erro: e.message });
      }
    }
    if (algumAtualizado) {
      await salvarConversaCompletaSheets(tel, sessao.historico, sessao.nome || "").catch(() => {});
    }
  }
  res.json({ ok: true, ...resultado });
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

// Dados de contrato ficam salvos no Google Drive (pasta "Contratos"), não
// mais em disco local — hospedagens gratuitas apagam o disco a cada deploy.
// Se já existir /data/contratos.json (Volume antigo do Railway), o conteúdo é
// migrado pro Drive automaticamente na primeira execução com este código.
const contratosDriveStore = criarStoreCacheado({
  nomeArquivo: "contratos.json",
  pastaNome: "Contratos",
  valorPadrao: [],
  migrarDeArquivoLocal: process.env.CONTRATOS_PATH || "/data/contratos.json"
});

function lerContratos() {
  return contratosDriveStore.ler() || [];
}

function salvarContrato(registro) {
  try {
    const lista = lerContratos();
    lista.unshift(registro);
    contratosDriveStore.gravar(lista.slice(0, 500));
  } catch (e) { console.error("Erro salvando contrato:", e.message); }
}

// ============================================================
// AVALIAÇÃO DE CANDIDATOS — link independente (não depende mais da Lia/WhatsApp)
// ============================================================
// Mesmo padrão de persistência dos contratos: JSON no Google Drive, com
// migração automática de um arquivo local antigo (Volume do Railway), caso exista.
const avaliacoesDriveStore = criarStoreCacheado({
  nomeArquivo: "avaliacoes.json",
  pastaNome: "Avaliacoes",
  valorPadrao: [],
  migrarDeArquivoLocal: process.env.AVALIACOES_PATH || "/data/avaliacoes.json"
});

function lerAvaliacoes() {
  return avaliacoesDriveStore.ler() || [];
}

function gravarAvaliacoes(lista) {
  try {
    avaliacoesDriveStore.gravar(lista.slice(0, 1000));
  } catch (e) { console.error("Erro salvando avaliações:", e.message); }
}

function gerarTokenAvaliacao() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function extenso(v, fallback) {
  const s = (v ?? '').toString().trim();
  return s ? escapeHtml(s) : `<span class="vazio">${escapeHtml(fallback || '[a definir]')}</span>`;
}

function dataPorExtenso(iso) {
  try {
    const dt = iso ? new Date(iso) : new Date();
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (e) { return ''; }
}

function dataCurta(iso) {
  try {
    const dt = iso ? new Date(iso) : new Date();
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) { return '__/__/____'; }
}

function dataMaisMeses(iso, meses) {
  try {
    const dt = iso ? new Date(iso) : new Date();
    dt.setMonth(dt.getMonth() + meses);
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) { return '__/__/____'; }
}

// Extrai um número de um texto de salário em formato BRL (ex.: "R$ 2.500,00").
// Retorna null se não conseguir interpretar (ex.: "A combinar").
function parseValorBRL(s) {
  if (!s) return null;
  let cleaned = String(s).replace(/[^\d,.]/g, '');
  if (!cleaned) return null;
  if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes('.')) {
    const partes = cleaned.split('.');
    if (partes.length > 1 && partes[partes.length - 1].length === 3) cleaned = partes.join('');
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Aplica a tabela de honorários da Cláusula 13 sobre o salário-base da vaga.
function faixaHonorarios(salario) {
  const v = parseValorBRL(salario);
  if (v == null) return 'A definir conforme tabela da Cláusula 13, com base no salário-base efetivamente pactuado.';
  const pct = v < 2000 ? 60 : (v < 4000 ? 50 : 40);
  return `${pct}% do salário-base — equivalente a R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} × ${pct}% (conforme Cláusula 13)`;
}

const brm = (s) => `<p class="clausula-titulo">${escapeHtml(s)}</p>`;                        // título de cláusula
const brp = (s) => `<p>${s}</p>`;                                                             // parágrafo comum
const bri = (rom, s) => `<p class="item"><strong>${rom} –</strong> ${s}</p>`;                 // item I, II, III...
const brb = (s) => `<p class="bullet">• ${s}</p>`;                                            // bullet simples
const brpar = (rot, s) => `<p class="paragrafo"><strong>Parágrafo ${rot}.</strong> ${s}</p>`;  // Parágrafo Único/Primeiro...
const brparte = (s) => `<p class="parte-titulo">${escapeHtml(s)}</p>`;                        // PARTE 1 – ...

// Minuta de contrato de prestação de serviços de Recrutamento, Seleção e
// Consultoria em Gestão de Pessoas, com o texto revisado e aprovado pela
// Effect. O corpo das cláusulas (1 a 32) é padronizado — só o cabeçalho da
// CONTRATANTE, o Anexo I (condições comerciais) e a data/local de assinatura
// são preenchidos automaticamente a partir do formulário do cliente. Ainda
// assim, é um modelo — vale revisão de um advogado antes do uso oficial.
function textoMinutaContrato(d) {
  return `
<p class="centro"><strong>CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE RECRUTAMENTO, SELEÇÃO E CONSULTORIA EM GESTÃO DE PESSOAS</strong></p>

<p>Pelo presente instrumento particular, de um lado,</p>

<p class="clausula-titulo">CONTRATANTE</p>
<p>Razão Social: ${extenso(d.contrato_razao)}</p>
<p>CNPJ: ${extenso(d.contrato_cnpj)}</p>
<p>Endereço: ${extenso(d.contrato_endereco)}</p>
<p>Representante Legal: ${extenso(d.responsavel_nome)}</p>
<p>Cargo: ${extenso(d.responsavel_cargo)}</p>
<p>E-mail: ${extenso(d.responsavel_email)}</p>
<p>Telefone: ${extenso(d.responsavel_whatsapp)}</p>
<p>doravante denominada simplesmente <strong>CONTRATANTE</strong>;</p>

<p>e, de outro lado,</p>

<p class="clausula-titulo">CONTRATADA</p>
<p>${escapeHtml(CONFIG.CONTRATADA_NOME_FANTASIA)}</p>
<p>Razão Social: ${escapeHtml(CONFIG.CONTRATADA_RAZAO)}</p>
<p>CNPJ: ${escapeHtml(CONFIG.CONTRATADA_CNPJ)}</p>
<p>Endereço: ${escapeHtml(CONFIG.CONTRATADA_ENDERECO)}</p>
<p>E-mail: ${escapeHtml(CONFIG.CONTRATADA_EMAIL)}</p>
<p>Telefone: ${escapeHtml(CONFIG.CONTRATADA_TELEFONE)}</p>
<p>doravante denominada simplesmente <strong>CONTRATADA</strong>,</p>

<p>têm entre si justo e contratado o presente Contrato de Prestação de Serviços de Recrutamento, Seleção e Consultoria em Gestão de Pessoas, que será regido pelas cláusulas e condições seguintes.</p>

${brm('CLÁUSULA 1 – DAS DEFINIÇÕES')}
<p>Para fins deste contrato, os termos abaixo terão os seguintes significados:</p>
${bri('I', 'Candidato Apresentado: toda pessoa indicada, encaminhada, entrevistada, recomendada ou cujo currículo tenha sido disponibilizado pela CONTRATADA à CONTRATANTE, independentemente da etapa em que se encontre o processo seletivo.')}
${bri('II', 'Processo Seletivo: conjunto de atividades desenvolvidas pela CONTRATADA para identificação, avaliação e indicação de profissionais aderentes ao perfil solicitado pela CONTRATANTE.')}
${bri('III', 'Contratação: qualquer forma de utilização profissional do candidato apresentado pela CONTRATADA, incluindo, mas não se limitando a:')}
${brb('registro em carteira de trabalho (CLT);')}
${brb('contrato de experiência;')}
${brb('contratação temporária;')}
${brb('contrato de prestação de serviços;')}
${brb('contrato como pessoa jurídica (PJ);')}
${brb('trabalho intermitente;')}
${brb('freelancer;')}
${brb('diária;')}
${brb('contrato de estágio;')}
${brb('jovem aprendiz;')}
${brb('cooperativa;')}
${brb('terceirização;')}
${brb('qualquer outra modalidade que resulte na prestação de serviços em benefício da CONTRATANTE.')}
${bri('IV', 'Admissão: considera-se ocorrida a admissão na data em que o candidato iniciar efetivamente suas atividades em favor da CONTRATANTE, ainda que o registro formal ocorra posteriormente.')}
${bri('V', 'Proposta Comercial: documento emitido pela CONTRATADA contendo valores, prazos, condições comerciais, modalidades de contratação e demais especificações do serviço contratado, integrando este contrato para todos os efeitos legais.')}
${bri('VI', 'Garantia Effect: benefício concedido pela CONTRATADA consistente na realização de um novo processo seletivo, sem cobrança de novos honorários, observadas as condições previstas neste contrato.')}
${bri('VII', 'Briefing da Vaga: conjunto de informações fornecidas pela CONTRATANTE contendo, entre outras, descrição do cargo, requisitos técnicos, competências desejadas, remuneração, benefícios, jornada, local de trabalho e demais características necessárias ao recrutamento.')}

${brm('CLÁUSULA 2 – DO OBJETO')}
<p>O presente contrato tem por objeto a prestação de serviços especializados de Recrutamento, Seleção e Consultoria em Gestão de Pessoas, compreendendo, conforme necessidade da CONTRATANTE:</p>
${bri('I', 'alinhamento técnico do perfil da vaga;')}
${bri('II', 'elaboração de estratégia de recrutamento;')}
${bri('III', 'divulgação de oportunidades em canais apropriados;')}
${bri('IV', 'hunting ativo de profissionais;')}
${bri('V', 'triagem curricular;')}
${bri('VI', 'entrevistas individuais presenciais ou remotas;')}
${bri('VII', 'entrevistas por competências;')}
${bri('VIII', 'aplicação de testes técnicos, comportamentais ou psicológicos, quando contratados e legalmente permitidos;')}
${bri('IX', 'elaboração de pareceres técnicos;')}
${bri('X', 'apresentação de candidatos;')}
${bri('XI', 'acompanhamento das etapas do processo seletivo;')}
${bri('XII', 'apoio consultivo durante a tomada de decisão;')}
${bri('XIII', 'formação de banco de talentos;')}
${bri('XIV', 'executive search, quando contratado;')}
${bri('XV', 'demais atividades relacionadas ao recrutamento e seleção de pessoas.')}
${brpar('Primeiro', 'Os serviços serão executados com autonomia técnica e metodológica pela CONTRATADA, utilizando processos próprios de avaliação profissional.')}
${brpar('Segundo', 'A CONTRATADA poderá utilizar plataformas digitais, sistemas de recrutamento, redes profissionais, banco de currículos e demais ferramentas que considerar adequadas para a execução dos serviços.')}

${brm('CLÁUSULA 3 – DA NATUREZA DOS SERVIÇOS')}
<p>Os serviços prestados possuem natureza consultiva e técnica, caracterizando obrigação de meio, e não obrigação de resultado.</p>
<p>Em razão disso, a CONTRATADA compromete-se a empregar diligência, conhecimento técnico, metodologia adequada e boas práticas de recrutamento e seleção, não assumindo obrigação de garantir:</p>
${bri('I', 'a contratação de candidatos;')}
${bri('II', 'a aceitação de propostas pelos candidatos;')}
${bri('III', 'a permanência do profissional contratado;')}
${bri('IV', 'o desempenho funcional do candidato após sua admissão;')}
${bri('V', 'resultados financeiros ou operacionais decorrentes da contratação.')}
${brpar('Único', 'A decisão final acerca da contratação, remuneração, benefícios, jornada, admissão, desligamento ou qualquer outra condição relativa ao vínculo profissional será sempre de exclusiva responsabilidade da CONTRATANTE.')}

${brm('CLÁUSULA 4 – DA VIGÊNCIA')}
<p>O presente contrato terá vigência de 06 (seis) meses, iniciando-se em ${dataCurta(d.criadoEm)} e encerrando-se em ${dataMaisMeses(d.criadoEm, 6)}, podendo ser renovado mediante acordo escrito entre as partes.</p>
<p>A renovação poderá ocorrer por termo aditivo ou por manifestação expressa das partes, mantendo-se as demais cláusulas deste instrumento.</p>

${brparte('PARTE 2 – EXECUÇÃO DOS SERVIÇOS')}

${brm('CLÁUSULA 5 – DO INÍCIO DOS SERVIÇOS')}
<p>Os serviços terão início após o atendimento cumulativo dos seguintes requisitos:</p>
${bri('I', 'assinatura deste contrato;')}
${bri('II', 'aprovação da Proposta Comercial, quando houver;')}
${bri('III', 'recebimento do briefing completo da vaga;')}
${bri('IV', 'definição do perfil profissional pretendido;')}
${bri('V', 'disponibilização das informações necessárias à execução do processo seletivo.')}
${brpar('Primeiro', 'Considera-se briefing completo aquele que contenha, no mínimo: a) cargo; b) descrição das atividades; c) remuneração; d) benefícios; e) jornada de trabalho; f) local de trabalho; g) requisitos técnicos; h) competências comportamentais; i) modalidade de contratação.')}
${brpar('Segundo', 'Enquanto qualquer das informações acima permanecer pendente, os prazos previstos neste contrato permanecerão suspensos, sem qualquer responsabilidade da CONTRATADA.')}

${brm('CLÁUSULA 6 – DO FLUXO DO PROCESSO SELETIVO')}
<p>Após o recebimento do briefing completo, a CONTRATADA iniciará as atividades de recrutamento utilizando metodologia própria, podendo compreender:</p>
${bri('I', 'divulgação da vaga;')}
${bri('II', 'busca ativa de candidatos (Hunting);')}
${bri('III', 'triagem curricular;')}
${bri('IV', 'entrevistas;')}
${bri('V', 'aplicação de avaliações;')}
${bri('VI', 'elaboração de parecer técnico;')}
${bri('VII', 'encaminhamento dos candidatos considerados aderentes ao perfil solicitado.')}
${brpar('Primeiro', 'A CONTRATADA poderá deixar de apresentar candidatos que, a seu critério técnico, não atendam aos requisitos mínimos da vaga.')}
${brpar('Segundo', 'A apresentação de candidatos não obriga a CONTRATANTE à contratação, nem caracteriza recomendação absoluta de contratação.')}

${brm('CLÁUSULA 7 – DOS PRAZOS')}
<p>A CONTRATADA compromete-se a iniciar os trabalhos em até 02 (dois) dias úteis após o recebimento de todas as informações necessárias.</p>
<p>Entretanto, o prazo para apresentação de candidatos poderá variar conforme:</p>
${bri('I', 'complexidade da vaga;')}
${bri('II', 'nível de especialização exigido;')}
${bri('III', 'escassez de profissionais no mercado;')}
${bri('IV', 'localização da vaga;')}
${bri('V', 'remuneração oferecida;')}
${bri('VI', 'urgência da contratação;')}
${bri('VII', 'sazonalidade do mercado.')}
${brpar('Único', 'A CONTRATADA compromete-se a manter a CONTRATANTE informada sobre o andamento do processo seletivo sempre que solicitado ou quando houver fatos relevantes.')}

${brm('CLÁUSULA 8 – DAS OBRIGAÇÕES DA CONTRATADA')}
<p>Constituem obrigações da CONTRATADA:</p>
${bri('I', 'conduzir os processos seletivos com ética, imparcialidade e profissionalismo;')}
${bri('II', 'empregar metodologia técnica compatível com o perfil da vaga;')}
${bri('III', 'manter absoluto sigilo sobre todas as informações recebidas;')}
${bri('IV', 'apresentar candidatos que, segundo sua avaliação técnica, possuam aderência ao perfil solicitado;')}
${bri('V', 'manter comunicação clara com a CONTRATANTE durante toda a execução dos serviços;')}
${bri('VI', 'cumprir a legislação vigente, especialmente a Lei Geral de Proteção de Dados (LGPD);')}
${bri('VII', 'preservar a imagem institucional da CONTRATANTE durante o processo seletivo;')}
${bri('VIII', 'agir sempre com boa-fé, diligência e zelo profissional.')}
${brpar('Único', 'A CONTRATADA possui autonomia técnica para definir a metodologia de recrutamento e seleção utilizada em cada processo.')}

${brm('CLÁUSULA 9 – DAS OBRIGAÇÕES DA CONTRATANTE')}
<p>Constituem obrigações da CONTRATANTE:</p>
${bri('I', 'fornecer informações completas e verdadeiras sobre a vaga;')}
${bri('II', 'informar corretamente remuneração, benefícios, jornada e demais condições da contratação;')}
${bri('III', 'designar um responsável para comunicação com a CONTRATADA;')}
${bri('IV', 'fornecer feedback acerca dos candidatos apresentados;')}
${bri('V', 'cumprir os prazos de pagamento;')}
${bri('VI', 'respeitar as condições comerciais estabelecidas neste contrato;')}
${bri('VII', 'comunicar imediatamente qualquer alteração referente à vaga.')}
${brpar('Primeiro', 'A ausência de informações ou a prestação de informações incorretas poderá comprometer o processo seletivo, não podendo tal fato ser imputado à CONTRATADA.')}
${brpar('Segundo', 'A CONTRATANTE compromete-se a comunicar formalmente a contratação de qualquer candidato apresentado pela CONTRATADA, informando a data de admissão e a remuneração efetivamente praticada.')}

${brm('CLÁUSULA 10 – DO PRAZO PARA FEEDBACK')}
<p>A CONTRATANTE deverá fornecer retorno acerca dos candidatos apresentados, sempre que possível, no prazo máximo de 05 (cinco) dias úteis.</p>
${brpar('Primeiro', 'O atraso no fornecimento de feedback poderá impactar diretamente o interesse e a disponibilidade dos candidatos, não podendo a CONTRATADA ser responsabilizada pela eventual perda desses profissionais.')}
${brpar('Segundo', 'Na hipótese de ausência de retorno superior a 15 (quinze) dias corridos, o processo seletivo poderá ser considerado suspenso até manifestação da CONTRATANTE.')}

${brm('CLÁUSULA 11 – DAS ALTERAÇÕES DA VAGA')}
<p>Após iniciado o processo seletivo, qualquer alteração substancial nas condições inicialmente informadas será considerada novo alinhamento da vaga.</p>
<p>Consideram-se alterações substanciais, entre outras:</p>
${bri('I', 'alteração da remuneração;')}
${bri('II', 'alteração dos benefícios;')}
${bri('III', 'mudança da jornada de trabalho;')}
${bri('IV', 'alteração do local de trabalho;')}
${bri('V', 'mudança do cargo;')}
${bri('VI', 'alteração das atividades principais;')}
${bri('VII', 'alteração da escolaridade exigida;')}
${bri('VIII', 'alteração dos requisitos técnicos;')}
${bri('IX', 'inclusão de novas competências obrigatórias.')}
${brpar('Primeiro', 'Ocorrendo qualquer das hipóteses acima, a CONTRATADA poderá reiniciar o processo seletivo, reiniciando-se também os prazos operacionais.')}
${brpar('Segundo', 'Caso as alterações impliquem aumento significativo da complexidade do recrutamento, as partes poderão revisar os honorários mediante acordo formal.')}

${brm('CLÁUSULA 12 – DA SUSPENSÃO DOS SERVIÇOS')}
<p>A CONTRATADA poderá suspender temporariamente o processo seletivo quando ocorrer qualquer das seguintes situações:</p>
${bri('I', 'ausência de informações indispensáveis;')}
${bri('II', 'atraso superior a 15 (quinze) dias no pagamento de valores devidos;')}
${bri('III', 'ausência de feedback da CONTRATANTE;')}
${bri('IV', 'solicitação expressa da CONTRATANTE;')}
${bri('V', 'fatos que inviabilizem a continuidade dos trabalhos.')}
${brpar('Único', 'Durante o período de suspensão ficarão igualmente suspensos todos os prazos previstos neste contrato, retomando sua contagem após a regularização da situação.')}

${brparte('PARTE 3 – CONDIÇÕES COMERCIAIS')}

${brm('CLÁUSULA 13 – DOS HONORÁRIOS')}
<p>Pelos serviços prestados, a CONTRATANTE pagará à CONTRATADA honorários de sucesso ("Success Fee"), devidos exclusivamente em caso de efetiva contratação de candidato apresentado pela CONTRATADA.</p>
<p>Os honorários serão calculados sobre o salário-base mensal bruto da vaga, conforme a tabela abaixo:</p>
<table class="tabela-honorarios">
  <thead><tr><th>Faixa Salarial</th><th>Honorários</th></tr></thead>
  <tbody>
    <tr><td>De R$ 1.000,00 até R$ 1.999,99</td><td><strong>60% do salário-base</strong></td></tr>
    <tr><td>De R$ 2.000,00 até R$ 3.999,99</td><td><strong>50% do salário-base</strong></td></tr>
    <tr><td>Igual ou superior a R$ 4.000,00</td><td><strong>40% do salário-base</strong></td></tr>
  </tbody>
</table>
${brpar('Primeiro', 'Para fins deste contrato, considera-se salário-base o valor da remuneração fixa mensal pactuada para o cargo, excluídos benefícios, comissões, premiações, bônus, ajuda de custo, participação nos lucros e demais verbas variáveis.')}
${brpar('Segundo', 'Caso a remuneração seja alterada antes da admissão do candidato, os honorários serão calculados com base no salário efetivamente contratado.')}
<p class="nota-anexo">→ O percentual aplicável a esta contratação específica está calculado no <strong>Anexo I</strong>, ao final deste contrato.</p>

${brm('CLÁUSULA 14 – DO FATO GERADOR DOS HONORÁRIOS')}
<p>Os honorários serão considerados devidos quando ocorrer qualquer forma de contratação ou utilização profissional de candidato apresentado pela CONTRATADA.</p>
<p>Para fins deste contrato, equiparam-se à contratação:</p>
${bri('I', 'registro em carteira de trabalho (CLT);')}
${bri('II', 'contrato de experiência;')}
${bri('III', 'contratação como Pessoa Jurídica (PJ);')}
${bri('IV', 'contratação temporária;')}
${bri('V', 'contrato intermitente;')}
${bri('VI', 'estágio;')}
${bri('VII', 'jovem aprendiz;')}
${bri('VIII', 'terceirização;')}
${bri('IX', 'contratação por cooperativa;')}
${bri('X', 'prestação de serviços como freelancer;')}
${bri('XI', 'contratação por diária;')}
${bri('XII', 'qualquer modalidade que resulte na prestação de serviços em benefício da CONTRATANTE.')}
${brpar('Único', 'Os honorários também serão devidos caso a contratação ocorra por empresa pertencente ao mesmo grupo econômico, empresa coligada, controladora, controlada ou por terceiros indicados pela CONTRATANTE.')}

${brm('CLÁUSULA 15 – DA AVALIAÇÃO PRÁTICA PRÉ-ADMISSIONAL')}
<p>A CONTRATANTE poderá realizar avaliação prática destinada exclusivamente à verificação da aptidão técnica do candidato.</p>
<p>A avaliação prática deverá observar, cumulativamente, os seguintes limites:</p>
${bri('I', 'máximo de 03 (três) escalas por candidato;')}
${bri('II', 'realização em período não superior a 07 (sete) dias corridos.')}
${brpar('Primeiro', 'A avaliação prática deverá possuir caráter exclusivamente avaliativo, não podendo ser utilizada para suprir necessidades permanentes de mão de obra da CONTRATANTE.')}
${brpar('Segundo', 'Caso o candidato permaneça prestando serviços além dos limites previstos nesta cláusula, ainda que sob qualquer nomenclatura, inclusive freelancer, diarista, temporário, experiência, teste, prestação eventual ou equivalente, considerar-se-á caracterizada a utilização efetiva da mão de obra apresentada pela CONTRATADA, tornando imediatamente exigíveis os honorários previstos neste contrato, independentemente da data da formalização da admissão.')}
${brpar('Terceiro', 'A remuneração do candidato durante a avaliação prática será de inteira responsabilidade da CONTRATANTE.')}
${brpar('Quarto', 'A CONTRATADA não possui qualquer responsabilidade pela gestão, pagamento, encargos, segurança do trabalho ou obrigações decorrentes da realização das avaliações práticas.')}

${brm('CLÁUSULA 16 – DO PAGAMENTO')}
<p>Após a confirmação da contratação, a CONTRATADA emitirá a competente Nota Fiscal.</p>
<p>O pagamento deverá ocorrer no prazo de até 07 (sete) dias contados da emissão da Nota Fiscal, mediante PIX, boleto ou transferência eletrônica.</p>
${brpar('Único', 'A CONTRATANTE compromete-se a informar imediatamente à CONTRATADA a efetiva contratação de qualquer candidato apresentado.')}

${brm('CLÁUSULA 17 – DO INADIMPLEMENTO')}
<p>O atraso no pagamento acarretará:</p>
${bri('I', 'multa moratória de 2% (dois por cento);')}
${bri('II', 'juros de mora de 1% (um por cento) ao mês, calculados pro rata die;')}
${bri('III', 'atualização monetária pelo índice legal aplicável.')}
${brpar('Primeiro', 'Persistindo a inadimplência por período superior a 15 (quinze) dias, a CONTRATADA poderá suspender quaisquer processos seletivos em andamento.')}
${brpar('Segundo', 'Os custos decorrentes de cobrança judicial ou extrajudicial, inclusive honorários advocatícios, serão suportados pela parte inadimplente, na forma da legislação vigente.')}

${brm('CLÁUSULA 18 – DA CONTRATAÇÃO POSTERIOR')}
<p>Os candidatos apresentados pela CONTRATADA permanecerão vinculados ao presente contrato pelo prazo de 12 (doze) meses contados da data de sua apresentação.</p>
<p>Caso qualquer desses candidatos seja contratado durante esse período, ainda que após o encerramento do processo seletivo ou por iniciativa da CONTRATANTE, serão integralmente devidos os honorários previstos neste contrato.</p>
${brpar('Primeiro', 'A presente cláusula aplica-se inclusive quando: I – houver contratação direta pelo proprietário, sócios ou administradores; II – ocorrer contratação por empresa do mesmo grupo econômico; III – a vaga originalmente trabalhada tenha sido cancelada; IV – o candidato seja contratado para cargo diverso daquele inicialmente divulgado.')}
${brpar('Segundo', 'A simples alegação de que o candidato foi localizado posteriormente pela CONTRATANTE não afastará a incidência desta cláusula quando houver comprovação de apresentação prévia realizada pela CONTRATADA.')}

${brm('CLÁUSULA 19 – DO PROGRAMA GARANTIA EFFECT')}
<p>Como diferencial comercial, a CONTRATADA concede à CONTRATANTE o Programa Garantia Effect, consistente na realização de um novo processo seletivo para a mesma vaga, sem cobrança de novos honorários, caso o candidato contratado seja desligado no prazo de até ${escapeHtml(CONFIG.CONTRATO_DIAS_GARANTIA)} (trinta) dias corridos contados da data de admissão.</p>
${brpar('Primeiro', 'A garantia compreende exclusivamente uma única reposição, limitada à mesma vaga originalmente contratada.')}
${brpar('Segundo', 'A garantia consiste exclusivamente na realização de novo processo seletivo, não implicando devolução de valores pagos.')}

${brm('CLÁUSULA 20 – DAS HIPÓTESES DE PERDA DA GARANTIA')}
<p>A Garantia Effect perderá automaticamente sua validade quando ocorrer qualquer das seguintes hipóteses:</p>
${bri('I', 'atraso no pagamento dos honorários;')}
${bri('II', 'alteração da remuneração originalmente informada;')}
${bri('III', 'alteração dos benefícios;')}
${bri('IV', 'alteração da jornada de trabalho;')}
${bri('V', 'alteração do local de trabalho;')}
${bri('VI', 'alteração das atribuições do cargo;')}
${bri('VII', 'alteração do perfil profissional solicitado;')}
${bri('VIII', 'encerramento da vaga;')}
${bri('IX', 'desligamento decorrente de reestruturação interna da empresa;')}
${bri('X', 'descumprimento, pela CONTRATANTE, da legislação trabalhista ou previdenciária;')}
${bri('XI', 'prática de assédio moral, assédio sexual, discriminação ou qualquer conduta ilícita que tenha contribuído para o desligamento do candidato;')}
${bri('XII', 'pedido de desligamento motivado por condições de trabalho substancialmente diferentes daquelas informadas durante o processo seletivo.')}
${brpar('Único', 'Verificada qualquer das hipóteses acima, eventual reposição será considerada novo processo seletivo, sujeito à cobrança dos honorários normalmente aplicáveis.')}

${brparte('PARTE 4 – DISPOSIÇÕES JURÍDICAS FINAIS')}

${brm('CLÁUSULA 21 – DA CONFIDENCIALIDADE')}
<p>As partes comprometem-se a manter absoluto sigilo sobre todas as informações, documentos, dados, estratégias, processos, metodologias, documentos comerciais, informações financeiras e demais conteúdos obtidos em razão da execução deste contrato.</p>
<p>Consideram-se confidenciais, entre outros:</p>
${bri('I', 'currículos;')}
${bri('II', 'pareceres técnicos;')}
${bri('III', 'avaliações;')}
${bri('IV', 'testes;')}
${bri('V', 'informações salariais;')}
${bri('VI', 'estrutura organizacional;')}
${bri('VII', 'banco de candidatos;')}
${bri('VIII', 'documentos internos;')}
${bri('IX', 'dados estratégicos da CONTRATANTE;')}
${bri('X', 'metodologia empregada pela CONTRATADA.')}
${brpar('Primeiro', 'Nenhuma informação poderá ser divulgada, reproduzida ou compartilhada sem autorização expressa da outra parte, salvo quando exigido por lei ou determinação judicial.')}
${brpar('Segundo', 'A obrigação de confidencialidade permanecerá vigente por 05 (cinco) anos após o encerramento deste contrato.')}

${brm('CLÁUSULA 22 – DA LEI GERAL DE PROTEÇÃO DE DADOS (LGPD)')}
<p>As partes comprometem-se a observar integralmente as disposições da Lei nº 13.709/2018 (Lei Geral de Proteção de Dados – LGPD), bem como toda legislação correlata.</p>
${brpar('Primeiro', 'Os dados pessoais tratados em razão deste contrato serão utilizados exclusivamente para a execução dos processos seletivos contratados.')}
${brpar('Segundo', 'Cada parte será responsável pelo tratamento dos dados pessoais sob sua guarda, respondendo individualmente por eventuais danos decorrentes de tratamento irregular.')}
${brpar('Terceiro', 'A CONTRATANTE compromete-se a utilizar os dados dos candidatos exclusivamente para fins relacionados à vaga contratada, sendo vedada qualquer utilização diversa sem fundamento legal.')}
${brpar('Quarto', 'Encerrado o processo seletivo, a CONTRATANTE deverá eliminar ou anonimizar os dados pessoais dos candidatos não contratados, salvo obrigação legal de conservação.')}

${brm('CLÁUSULA 23 – DA PROPRIEDADE INTELECTUAL')}
<p>Todos os métodos, formulários, entrevistas estruturadas, pareceres técnicos, avaliações, materiais, documentos, apresentações, relatórios, modelos, fluxos de recrutamento, banco de talentos e demais conteúdos produzidos pela CONTRATADA constituem sua propriedade intelectual exclusiva.</p>
${brpar('Primeiro', 'A contratação dos serviços não implica cessão de propriedade intelectual.')}
${brpar('Segundo', 'É vedada a reprodução, distribuição, comercialização, compartilhamento ou utilização desses materiais para quaisquer outras finalidades sem autorização expressa da CONTRATADA.')}

${brm('CLÁUSULA 24 – DOS CURRÍCULOS E DOS CANDIDATOS APRESENTADOS')}
<p>Os currículos encaminhados pela CONTRATADA destinam-se exclusivamente ao preenchimento da vaga objeto deste contrato.</p>
<p>É vedado à CONTRATANTE:</p>
${bri('I', 'compartilhar currículos com terceiros;')}
${bri('II', 'encaminhar candidatos para empresas parceiras;')}
${bri('III', 'utilizar candidatos apresentados para processos seletivos de terceiros;')}
${bri('IV', 'divulgar informações pessoais dos candidatos sem autorização.')}
${brpar('Primeiro', 'Caso a CONTRATANTE tenha interesse em aproveitar candidato apresentado para vaga diversa daquela originalmente contratada, deverá comunicar previamente a CONTRATADA.')}
${brpar('Segundo', 'A utilização de candidato apresentado para outra vaga não afasta a incidência dos honorários previstos neste contrato.')}

${brm('CLÁUSULA 25 – DAS COMUNICAÇÕES')}
<p>Serão consideradas válidas todas as comunicações realizadas por:</p>
${bri('I', 'e-mail;')}
${bri('II', 'WhatsApp;')}
${bri('III', 'plataformas eletrônicas de gestão de processos;')}
${bri('IV', 'assinatura eletrônica;')}
${bri('V', 'qualquer outro meio eletrônico habitualmente utilizado entre as partes.')}
${brpar('Primeiro', 'As partes reconhecem a validade jurídica das comunicações eletrônicas para fins de aprovações, solicitações, envio de currículos, aceite de propostas, notificações e demais atos relacionados à execução deste contrato.')}
${brpar('Segundo', 'As assinaturas eletrônicas possuem plena validade jurídica, produzindo os mesmos efeitos das assinaturas físicas, nos termos da legislação brasileira.')}

${brm('CLÁUSULA 26 – DA NÃO EXCLUSIVIDADE')}
<p>O presente contrato não estabelece qualquer obrigação de exclusividade entre as partes.</p>
<p>A CONTRATADA poderá prestar serviços a outras empresas, inclusive concorrentes da CONTRATANTE, desde que preservadas a confidencialidade e a ética profissional.</p>
<p>Da mesma forma, a CONTRATANTE poderá contratar outras consultorias de recrutamento e seleção.</p>

${brm('CLÁUSULA 27 – DA ANTICORRUPÇÃO E COMPLIANCE')}
<p>As partes declaram conhecer e cumprir a legislação brasileira relativa ao combate à corrupção, fraude, lavagem de dinheiro e demais normas aplicáveis.</p>
<p>Comprometem-se, ainda, a não oferecer, prometer, autorizar ou conceder vantagem indevida a agentes públicos ou privados em razão deste contrato.</p>
<p>O descumprimento desta cláusula autorizará a rescisão imediata do contrato, independentemente de aviso prévio.</p>

${brm('CLÁUSULA 28 – DO CASO FORTUITO E DA FORÇA MAIOR')}
<p>Nenhuma das partes responderá por atrasos ou impossibilidade de cumprimento das obrigações quando decorrentes de caso fortuito ou força maior.</p>
<p>Consideram-se, entre outros:</p>
${bri('I', 'desastres naturais;')}
${bri('II', 'enchentes;')}
${bri('III', 'pandemias;')}
${bri('IV', 'greves gerais;')}
${bri('V', 'interrupção de energia elétrica;')}
${bri('VI', 'indisponibilidade prolongada de sistemas;')}
${bri('VII', 'ataques cibernéticos;')}
${bri('VIII', 'atos governamentais que impeçam a continuidade dos serviços.')}
${brpar('Único', 'Enquanto perdurar o evento de força maior, ficarão suspensas as obrigações afetadas, sem incidência de penalidades.')}

${brm('CLÁUSULA 29 – DA RESCISÃO')}
<p>O presente contrato poderá ser rescindido:</p>
${bri('I', 'por comum acordo entre as partes;')}
${bri('II', `mediante aviso prévio escrito de ${escapeHtml(CONFIG.CONTRATO_DIAS_AVISO_RESCISAO)} (trinta) dias;`)}
${bri('III', 'imediatamente, em caso de descumprimento contratual;')}
${bri('IV', 'imediatamente, em caso de inadimplência superior a 15 (quinze) dias;')}
${bri('V', 'por violação das cláusulas de confidencialidade ou LGPD;')}
${bri('VI', 'por prática de ato ilícito relacionado à execução deste contrato.')}
${brpar('Primeiro', 'A rescisão não prejudicará os honorários já devidos em razão de candidatos apresentados antes do encerramento da relação contratual.')}
${brpar('Segundo', 'Os candidatos encaminhados pela CONTRATADA antes da rescisão permanecerão vinculados à cláusula de contratação posterior prevista neste contrato.')}
${brpar('Terceiro', `O descumprimento de qualquer obrigação prevista neste contrato sujeitará a parte infratora ao pagamento de multa não compensatória correspondente a ${escapeHtml(CONFIG.CONTRATO_MULTA_PCT)}% (${CONFIG.CONTRATO_MULTA_PCT === '10' ? 'dez por cento' : escapeHtml(CONFIG.CONTRATO_MULTA_PCT) + ' por cento'}) sobre o valor dos honorários devidos ou, na ausência destes, sobre o valor da Proposta Comercial vigente, sem prejuízo da apuração de perdas e danos e da exigibilidade do cumprimento da obrigação principal.`)}

${brm('CLÁUSULA 30 – DA INEXISTÊNCIA DE VÍNCULO EMPREGATÍCIO')}
<p>O presente contrato possui natureza exclusivamente civil e comercial.</p>
<p>Nenhuma disposição deste instrumento poderá ser interpretada como constituição de vínculo empregatício, sociedade, representação comercial, associação, mandato ou qualquer outra relação além da prestação de serviços ora contratada.</p>
<p>Os profissionais eventualmente utilizados pela CONTRATADA permanecerão sob sua exclusiva direção, coordenação e responsabilidade.</p>

${brm('CLÁUSULA 31 – DAS DISPOSIÇÕES GERAIS')}
<p>Este contrato constitui o acordo integral celebrado entre as partes, substituindo quaisquer entendimentos anteriores, escritos ou verbais.</p>
${brpar('Primeiro', 'Qualquer alteração deste contrato somente produzirá efeitos mediante termo aditivo escrito e assinado pelas partes.')}
${brpar('Segundo', 'A eventual tolerância quanto ao descumprimento de qualquer cláusula não implicará renúncia de direitos ou novação contratual.')}
${brpar('Terceiro', 'A eventual nulidade de qualquer cláusula não prejudicará a validade das demais disposições contratuais.')}
${brpar('Quarto', 'A Proposta Comercial, Ordens de Serviço, Aditivos Contratuais e demais documentos assinados pelas partes passam a integrar este contrato para todos os efeitos legais.')}

${brm('CLÁUSULA 32 – DO FORO')}
<p>As partes elegem o Foro da Comarca de ${escapeHtml(CONFIG.CONTRATADA_FORO_CIDADE)}, Estado do ${escapeHtml(CONFIG.CONTRATADA_FORO_UF)}, com renúncia expressa de qualquer outro, por mais privilegiado que seja, para dirimir quaisquer controvérsias oriundas deste contrato.</p>

<p><strong>E, POR ESTAREM JUSTAS E CONTRATADAS,</strong></p>
<p>Firmam o presente instrumento em duas vias de igual teor e forma, juntamente com duas testemunhas.</p>

<p class="assinatura-local">${escapeHtml(CONFIG.CONTRATADA_FORO_CIDADE)}/${escapeHtml((CONFIG.CONTRATADA_FORO_UF||'').split(' ').map(w=>w[0]).join('') || 'ES')}, ${dataPorExtenso(d.criadoEm)}.</p>

<div class="assinaturas">
  <div class="linha-assinatura">
    <div class="tra"></div>
    <span><strong>CONTRATANTE</strong><br>Razão Social: ${extenso(d.contrato_razao)}<br>Representante: ${extenso(d.responsavel_nome)}<br>Cargo: ${extenso(d.responsavel_cargo)}<br>Assinatura: ____________________________</span>
  </div>
  <div class="linha-assinatura">
    <div class="tra"></div>
    <span><strong>CONTRATADA</strong><br>${escapeHtml(CONFIG.CONTRATADA_RAZAO)}<br>${escapeHtml(CONFIG.CONTRATADA_NOME_FANTASIA)}<br>CNPJ: ${escapeHtml(CONFIG.CONTRATADA_CNPJ)}<br>Assinatura: ____________________________</span>
  </div>
  <div class="linha-assinatura">
    <div class="tra"></div>
    <span><strong>TESTEMUNHA 1</strong><br>Nome: ______________________________<br>CPF: ______________________________<br>Assinatura: ____________________________</span>
  </div>
  <div class="linha-assinatura">
    <div class="tra"></div>
    <span><strong>TESTEMUNHA 2</strong><br>Nome: ______________________________<br>CPF: ______________________________<br>Assinatura: ____________________________</span>
  </div>
</div>

${brparte('ANEXO I – CONDIÇÕES COMERCIAIS DESTA CONTRATAÇÃO')}
<p>As condições comerciais desta contratação, detalhadas a seguir, integram este contrato para todos os fins de direito e prevalecem sobre as condições gerais apenas quanto aos aspectos comerciais aqui especificados. Cada cargo abaixo é tratado como uma contratação independente para fins de honorários (Cláusula 13).</p>
${(Array.isArray(d.vagas) && d.vagas.length ? d.vagas : [{ cargo: d.vaga_cargo, quantidade: d.vaga_quantidade, salario: d.vaga_salario, beneficios: d.vaga_beneficios }]).map((v, i, arr) => `
<p class="clausula-titulo" style="margin-top:${i === 0 ? '0' : '18px'};font-size:13px">${arr.length > 1 ? `Cargo ${i + 1} de ${arr.length}` : 'Cargo'}</p>
${brb(`Cargo: ${extenso(v.cargo)}`)}
${brb(`Quantidade de vagas: ${extenso(v.quantidade, '1')}`)}
${brb(`Salário-base informado: ${extenso(v.salario, 'a definir')}`)}
${brb(`Percentual de honorários aplicável: ${faixaHonorarios(v.salario)}`)}
${brb(`Benefícios: ${extenso(v.beneficios, 'não informado')}`)}`).join('\n')}
${brb(`Tipo de serviço contratado: ${extenso(d.contrato_servico)}`)}
${brb(`Condições de pagamento: ${extenso(d.contrato_pagamento, 'a combinar')}`)}
${d.contrato_valor ? brb(`Resumo dos honorários calculados: ${extenso(d.contrato_valor)}`) : ''}
${brb(`Responsável pelo projeto (Contratante): ${extenso(d.responsavel_nome)}`)}
${brb(`Observações específicas: ${extenso(d.contrato_obs, 'nenhuma')}`)}
<p class="nota-anexo">Recebido via Portal do Cliente em ${escapeHtml(d.criadoEm ? new Date(d.criadoEm).toLocaleString('pt-BR') : '')} · ID ${escapeHtml(d.contratoId)}.</p>`;
}

function paginaContrato(d) {
  const linha = (rotulo, valor, destaque) => `<div class="linha${destaque ? ' destaque' : ''}"><span class="rotulo">${escapeHtml(rotulo)}</span><span class="valor">${escapeHtml(valor) || '<span class="vazio">—</span>'}</span></div>`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Contrato — ${escapeHtml(d.empresa_nome || 'Effect')}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&family=Merriweather:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#1a2a4a;--white:#ffffff;--bg:#f5f7fa;--muted:#a1a1aa;--green:#8ed1b2;--text:#2a2a2b;--warn:#b45309;--warn-bg:#fff7ed}
body{font-family:'Montserrat',sans-serif;background:var(--bg);color:var(--text);padding:32px}
.folha{max-width:800px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 2px 20px rgba(0,0,0,.06);overflow:hidden}
.topo{background:var(--navy);color:#fff;padding:28px 36px}
.topo .logo{font-weight:800;font-size:15px;letter-spacing:.5px}.topo .logo span{color:var(--green)}
.topo h1{font-size:22px;font-weight:800;margin-top:10px}
.topo .sub{font-size:12.5px;color:rgba(255,255,255,.6);margin-top:4px}
.aviso{background:var(--warn-bg);color:var(--warn);border-bottom:1px solid #fde3b6;padding:14px 36px;font-size:12.5px;font-weight:600;line-height:1.5}
.abas{display:flex;gap:0;border-bottom:2px solid #eef0f3;padding:0 36px}
.aba{padding:14px 18px;font-size:12.5px;font-weight:700;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px}
.aba.ativa{color:var(--navy);border-color:var(--green)}
.corpo{padding:32px 36px}
.painel{display:none}
.painel.ativa{display:block}
/* Minuta do contrato */
.minuta{font-family:'Merriweather',serif;font-size:12.5px;line-height:1.8;text-align:justify;color:#1c1c1c}
.minuta p{margin-bottom:10px}
.minuta p.centro{text-align:center;margin-bottom:20px;font-size:14px}
.minuta p.parte-titulo{text-align:center;text-transform:uppercase;font-weight:800;letter-spacing:.5px;margin-top:36px;margin-bottom:16px;color:var(--navy);border-top:2px solid var(--navy);border-bottom:2px solid var(--navy);padding:8px 0}
.minuta p.clausula-titulo{font-weight:800;margin-top:22px;margin-bottom:8px;color:var(--navy)}
.minuta p.item{margin-left:18px;margin-bottom:6px}
.minuta p.bullet{margin-left:30px;margin-bottom:5px}
.minuta p.paragrafo{margin-left:0;margin-bottom:8px;font-size:12px;color:#333}
.minuta .vazio{color:#b91c1c;font-style:italic;font-weight:700}
.minuta .assinatura-local{margin-top:28px}
.minuta .nota-anexo{font-size:11.5px;color:#555;font-style:italic}
.minuta table.tabela-honorarios{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}
.minuta table.tabela-honorarios th,.minuta table.tabela-honorarios td{border:1px solid #ccc;padding:7px 10px;text-align:left}
.minuta table.tabela-honorarios th{background:var(--navy);color:#fff}
.assinaturas{margin-top:40px;display:flex;flex-direction:column;gap:28px}
.linha-assinatura .tra{border-top:1px solid #555;width:320px;margin-bottom:8px}
.linha-assinatura span{font-size:11.5px;line-height:1.7}
/* Resumo em tabela */
.grupo{margin-bottom:28px}
.grupo:last-child{margin-bottom:0}
.grupo-titulo{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--green);background:rgba(142,209,178,.12);display:inline-block;padding:4px 10px;border-radius:6px;margin-bottom:14px}
.linha{display:flex;gap:16px;padding:9px 0;border-bottom:1px solid #eef0f3;font-size:13.5px}
.linha:last-child{border-bottom:none}
.linha.destaque{background:rgba(142,209,178,.08);margin:0 -10px;padding:9px 10px;border-radius:8px;border-bottom:none;font-weight:700}
.rotulo{flex:0 0 190px;font-weight:700;color:var(--navy)}
.valor{flex:1;white-space:pre-wrap;word-break:break-word}
.vazio{color:var(--muted);font-weight:400}
.rodape{padding:20px 36px 32px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.rodape small{color:var(--muted);font-size:11px}
.btn{background:var(--green);color:var(--navy);padding:10px 22px;border-radius:8px;border:none;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer}
@media print{
  body{background:#fff;padding:0}
  .folha{box-shadow:none;border-radius:0}
  .rodape .btn, .abas{display:none}
  .painel{display:block !important}
  .painel + .painel{page-break-before:always}
}
</style>
</head>
<body>
<div class="folha">
  <div class="topo">
    <div class="logo">Effect <span>Pessoas & Performance</span></div>
    <h1>Contrato — ${escapeHtml(d.empresa_nome || '')}</h1>
    <div class="sub">Recebido em ${escapeHtml(d.criadoEm ? new Date(d.criadoEm).toLocaleString('pt-BR') : '')} · Origem: ${escapeHtml(d.origem || 'Portal do Cliente')}</div>
  </div>
  <div class="corpo">
    <div class="minuta">${textoMinutaContrato(d)}</div>
  </div>
  <div class="rodape">
    <small>ID: ${escapeHtml(d.contratoId)} · Effect Pessoas &amp; Performance</small>
    <button class="btn" onclick="window.print()">🖨️ Salvar como PDF</button>
  </div>
</div>
</body>
</html>`;
}

app.post("/cliente/solicitar", async (req, res) => {
  try {
    const d = req.body;
    // Normaliza a lista de vagas: formulários novos mandam d.vagas (array,
    // um item por cargo); formulários antigos (cache do navegador) mandam só
    // os campos singulares vaga_* — nesse caso montamos um array de 1 item
    // pra tudo (mensagem, planilha, contrato) funcionar igual.
    const vagas = Array.isArray(d.vagas) && d.vagas.length ? d.vagas : [{
      cargo: d.vaga_cargo, quantidade: d.vaga_quantidade, cidade: d.vaga_cidade, salario: d.vaga_salario,
      horario: d.vaga_horario, beneficios: d.vaga_beneficios, beneficios_outros: d.vaga_beneficios_outros,
      responsabilidades: d.vaga_responsabilidades, requisitos: d.vaga_requisitos
    }];

    const contratoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const registro = { ...d, vagas, contratoId, criadoEm: new Date().toISOString() };
    salvarContrato(registro);
    const linkContrato = `${CONFIG.PUBLIC_BASE_URL}/cliente/contrato/${contratoId}`;

    const blocoVagas = vagas.map((v, i) => `💼 VAGA${vagas.length > 1 ? ' ' + (i + 1) : ''}
• Cargo: ${v.cargo || ''} (${v.quantidade || '1'} vaga(s))
• Cidade: ${v.cidade || ''}
• Salário: ${v.salario || 'A combinar'}
• Horário: ${v.horario || ''}
• Benefícios: ${v.beneficios || ''}${v.beneficios_outros ? ', ' + v.beneficios_outros : ''}
• Responsabilidades: ${v.responsabilidades || ''}
• Requisitos: ${v.requisitos || ''}`).join('\n\n');

    const msg = `🆕 NOVA SOLICITAÇÃO DE VAGA — Effect

🏢 EMPRESA
• Nome: ${d.empresa_nome || ''}
• Responsável: ${d.responsavel_nome || ''} ${d.responsavel_cargo ? '('+d.responsavel_cargo+')' : ''}
• WhatsApp: ${d.responsavel_whatsapp || ''}
• E-mail: ${d.responsavel_email || ''}
• Segmento: ${d.segmento || ''}

${blocoVagas}

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
• Honorários: ${d.contrato_valor || 'A definir'}
• Pagamento: ${d.contrato_pagamento || ''}
${d.contrato_obs ? '• Obs: '+d.contrato_obs : ''}

📎 Minuta de contrato (gerada automaticamente) + dados brutos: ${linkContrato}`;

    // Se o WhatsApp falhar (ex.: janela de 24h da Meta), NAO interrompe:
    // o contrato ja foi salvo e a planilha ainda precisa ser alimentada.
    let avisoWhats = null;
    try { await enviarMensagem(CONFIG.THIARA_WHATSAPP, msg); }
    catch (e) { avisoWhats = e.message; console.error("Falha ao avisar Thiara via WhatsApp:", e.message); }

    if (CONFIG.VAGAS_URL) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];
      // Uma linha na planilha por cargo, mantendo o mesmo formato de sempre.
      for (const v of vagas) {
        try {
          await axios.post(urlBase, { acao: "salvarAnalise", cargo: v.cargo, cliente: d.empresa_nome, cidade: v.cidade, salario: v.salario, horario: v.horario, beneficios: v.beneficios, responsabilidades: v.responsabilidades, requisitos: v.requisitos, escolaridade: d.perfil_escolaridade, experiencia: d.perfil_experiencia, contato: d.responsavel_whatsapp, origem: "Portal do Cliente" }, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
        } catch(e) { console.error("Erro salvar vaga cliente:", e.message); }
      }
    }

    res.json({ ok: true, contratoId, link: linkContrato, avisoWhats });
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
// ROTAS — CONSULTA DE CONTRATOS DE CLIENTES
// ============================================================

app.get("/contratos", (req, res) => res.sendFile(path.join(__dirname, "contratos.html")));

app.get("/contratos/lista", (req, res) => {
  try {
    const contratos = lerContratos();
    res.json({ ok: true, contratos });
  } catch (e) {
    console.error("Erro ao listar contratos:", e.message);
    res.json({ ok: false, erro: e.message });
  }
});

app.get("/visualizador-vagas", (req, res) => res.sendFile(path.join(__dirname, "visualizador-vagas-rapido.html")));

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
      // Guarda o arquivo em base64 na memória só quando o Drive falhou — é a rede de
      // segurança pra não perder o currículo (ver rota /inbox/curriculos/retentar-drive).
      // Quando o Drive já tem o link, manter os bytes do PDF em RAM pra sempre em cada
      // sessão é o que estava enchendo os 512MB do servidor e derrubando o serviço.
      base64: driveLink ? "" : arquivoBuffer.toString("base64"),
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
// Segue o template padrão: Título / Atribuições / Requisitos / Remuneração e Benefícios.
function textoDivulgacaoFixo(vaga) {
  const cargo = campo(vaga, ["cargo", "Cargo", "CARGO"], "Oportunidade");
  const cidade = campo(vaga, ["cidade", "Cidade", "vaga_cidade"], "");
  const salario = campo(vaga, ["salario", "Salário", "vaga_salario"], "A combinar");
  const horario = campo(vaga, ["horario", "Horário", "vaga_horario"], "");
  const beneficios = campo(vaga, ["beneficios", "Benefícios", "vaga_beneficios"], "");
  const requisitos = campo(vaga, ["requisitos", "Requisitos", "vaga_requisitos"], "");
  const responsabilidades = campo(vaga, ["responsabilidades", "Responsabilidades", "vaga_responsabilidades"], "");

  let txt = `📢 VAGA ABERTA\n\n🔹 Título: ${cargo}`;
  if (cidade) txt += `\n📍 Local: ${cidade}`;
  if (responsabilidades) txt += `\n\n🔹 Atribuições:\n${responsabilidades}`;
  if (requisitos) txt += `\n\n🔹 Requisitos:\n${requisitos}`;
  txt += `\n\n🔹 Remuneração e Benefícios:\n💰 Salário: ${salario}`;
  if (horario) txt += `\n🕐 Horário: ${horario}`;
  if (beneficios) txt += `\n🎁 Benefícios: ${beneficios}`;
  txt += `\n\nTem interesse? Envie seu currículo atualizado por aqui que a gente dá continuidade! 💙\n\nEquipe Effect Pessoas`;
  return txt;
}

function promptDivulgacaoVaga(vaga) {
  const cargo = campo(vaga, ["cargo", "Cargo", "CARGO"], "");
  const cidade = campo(vaga, ["cidade", "Cidade", "vaga_cidade"], "");
  const salario = campo(vaga, ["salario", "Salário", "vaga_salario"], "A combinar");
  const horario = campo(vaga, ["horario", "Horário", "vaga_horario"], "");
  const beneficios = campo(vaga, ["beneficios", "Benefícios", "vaga_beneficios"], "");
  const requisitos = campo(vaga, ["requisitos", "Requisitos", "vaga_requisitos"], "");
  const responsabilidades = campo(vaga, ["responsabilidades", "Responsabilidades", "vaga_responsabilidades"], "");
  return `Escreva um anúncio de vaga de emprego pronto para divulgar em grupos de WhatsApp e redes sociais, seguindo EXATAMENTE esta estrutura e nesta ordem (omita uma seção inteira se não houver nenhuma informação pra ela):

📢 VAGA ABERTA

🔹 Título: [cargo]
📍 Local: [cidade, se houver]

🔹 Atribuições:
[principais atividades — use o que foi informado em "Responsabilidades" abaixo; se estiver vazio, pode descrever de forma genérica e razoável as atividades típicas do cargo]

🔹 Requisitos:
[copie/organize o que foi informado em "Requisitos" abaixo — NUNCA invente um requisito que não esteja listado]

🔹 Remuneração e Benefícios:
💰 Salário: [salário informado]
🕐 Horário: [horário, se houver]
🎁 Benefícios: [benefícios informados — NUNCA invente um benefício que não esteja listado]

Termine com uma chamada calorosa pedindo para quem tiver interesse enviar currículo atualizado, seguida de "Equipe Effect Pessoas".

Regras importantes:
- Nunca invente salário, benefícios ou requisitos que não estejam nos dados abaixo.
- Tom acolhedor e profissional, emojis moderados (sem exagero).
- Não use markdown (sem **, sem #, sem listas com traço).

Cargo: ${cargo}
Cidade: ${cidade}
Salário: ${salario}
Horário: ${horario}
Benefícios: ${beneficios}
Requisitos: ${requisitos}
Responsabilidades: ${responsabilidades}`;
}

// ── FOTO DO PROFISSIONAL (IA) — usada no cartaz de divulgação (seção 5) ──────
// Gera uma foto realista via DALL-E 3 (OpenAI) a partir do cargo digitado.
// É sempre disparada manualmente (botão "Gerar foto com IA"), nunca automática
// a cada tecla digitada — evita gastar gerações à toa enquanto o cargo ainda
// está sendo ajustado.
async function gerarFotoProfissional(cargo) {
  if (!CONFIG.OPENAI_API_KEY) {
    return { ok: false, erro: "OPENAI_API_KEY não configurada no servidor." };
  }
  const prompt = `Fotografia profissional realista de um(a) ${cargo} trabalhando em ambiente corporativo condizente com a função. Estilo fotografia de RH/institucional, iluminação natural, foco nítido, pessoa real e diversa, sem texto, sem logotipos, sem marca d'água, sem elementos gráficos sobrepostos.`;
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/images/generations",
      { model: "dall-e-3", prompt, n: 1, size: "1024x1024", quality: "standard", response_format: "b64_json" },
      { headers: { Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 60000 }
    );
    const b64 = response.data?.data?.[0]?.b64_json;
    if (!b64) return { ok: false, erro: "IA não retornou imagem." };
    return { ok: true, imagemBase64: b64 };
  } catch (erro) {
    const status = erro.response?.status;
    const corpo = erro.response?.data;
    console.error(`Erro gerarFotoProfissional — status: ${status || "sem status"} — msg: ${erro.message} — corpo: ${JSON.stringify(corpo)}`);
    const msg = corpo?.error?.message || erro.message || "Erro desconhecido ao gerar imagem.";
    return { ok: false, erro: msg };
  }
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

// ── EMPRESAS CLIENTES (marca/cores/logo/contato por cliente) ─────────────────
// Guardado num arquivo JSON simples no Volume (mesmo padrão do SOS_PATH /
// INBOX_DATA_PATH abaixo), pra ficar salvo no servidor e compartilhado entre
// quem usa a Divulgação de Vagas — em vez de ficar preso ao navegador de uma
// pessoa só (localStorage). O mesmo cadastro de empresa cliente (nome, CNPJ
// se vier a ser adicionado, cores, logo, contato) serve tanto pra montar o
// anúncio de vaga quanto, futuramente, pra emissão de contrato.
// Persistência no Google Drive (pasta "Vagas"), migrando automaticamente do
// Volume antigo do Railway (VAGAS_EMPRESAS_PATH) se existir — ver drive-json-store.js.
const empresasVagasDriveStore = criarStoreCacheado({
  nomeArquivo: "vagas-empresas.json",
  pastaNome: "Vagas",
  valorPadrao: [],
  migrarDeArquivoLocal: process.env.VAGAS_EMPRESAS_PATH || "/data/vagas-empresas.json"
});

function lerEmpresasVagas() {
  const lista = empresasVagasDriveStore.ler();
  return Array.isArray(lista) ? lista : [];
}

function gravarEmpresasVagas(lista) {
  return empresasVagasDriveStore.gravar(lista);
}

// Lista todas as empresas clientes cadastradas (nome, cores, logo, contato).
app.get("/vagas/empresas", (req, res) => {
  res.json({ ok: true, empresas: lerEmpresasVagas() });
});

// Salva a lista inteira de empresas clientes (o painel manda o array completo
// já com a edição aplicada — mais simples do que endpoints separados de
// criar/editar/excluir, e evita corrida entre abas).
app.post("/vagas/empresas", (req, res) => {
  const lista = Array.isArray(req.body.empresas) ? req.body.empresas : null;
  if (!lista) return res.json({ ok: false, erro: "Envie { empresas: [...] }" });
  const salvo = gravarEmpresasVagas(lista);
  res.json({ ok: salvo, erro: salvo ? undefined : "Não foi possível salvar no servidor" });
});

// ── VAGAS SALVAS + CONTADOR DE DIVULGAÇÕES ───────────────────────────────────
// Permite dar um nome pra uma vaga (ex: "Vigilante Intermitente — Julho 2026")
// e registrar, com data/hora, cada vez que ela foi divulgada (postada em
// grupo, Instagram, etc.). Mesmo padrão de arquivo JSON no Volume das
// empresas clientes acima — salvo no servidor, compartilhado pelo time.
const vagasDivulgacaoDriveStore = criarStoreCacheado({
  nomeArquivo: "vagas-divulgacoes.json",
  pastaNome: "Vagas",
  valorPadrao: [],
  migrarDeArquivoLocal: process.env.VAGAS_DIVULGACOES_PATH || "/data/vagas-divulgacoes.json"
});

function lerVagasDivulgacao() {
  const lista = vagasDivulgacaoDriveStore.ler();
  return Array.isArray(lista) ? lista : [];
}

function gravarVagasDivulgacao(lista) {
  return vagasDivulgacaoDriveStore.gravar(lista);
}

// Lista todas as vagas salvas (nome, cargo, empresa vinculada, histórico de divulgações).
app.get("/vagas/divulgacoes", (req, res) => {
  res.json({ ok: true, vagas: lerVagasDivulgacao() });
});

// Salva a lista inteira (cria/renomeia/exclui vaga) — mesmo padrão simples do
// endpoint de empresas: o painel manda o array completo já com a edição.
app.post("/vagas/divulgacoes", (req, res) => {
  const lista = Array.isArray(req.body.vagas) ? req.body.vagas : null;
  if (!lista) return res.json({ ok: false, erro: "Envie { vagas: [...] }" });
  const salvo = gravarVagasDivulgacao(lista);
  res.json({ ok: salvo, erro: salvo ? undefined : "Não foi possível salvar no servidor" });
});

// Registra UMA divulgação agora (data/hora) pra uma vaga salva específica.
// Rota separada (em vez de reenviar a lista inteira) pra ser um clique rápido
// e não correr risco de duas pessoas sobrescreverem a lista uma da outra.
app.post("/vagas/divulgacoes/:id/registrar", (req, res) => {
  const lista = lerVagasDivulgacao();
  const vaga = lista.find(v => v.id === req.params.id);
  if (!vaga) return res.json({ ok: false, erro: "Vaga salva não encontrada" });
  if (!Array.isArray(vaga.divulgacoes)) vaga.divulgacoes = [];
  const registro = { ts: Date.now(), canal: (req.body && req.body.canal) || "" };
  vaga.divulgacoes.push(registro);
  const salvo = gravarVagasDivulgacao(lista);
  res.json({ ok: salvo, total: vaga.divulgacoes.length, registro });
});

// ── CRONOGRAMA DE DIVULGAÇÃO ──────────────────────────────────────────────────
// Guarda em quais dias da semana (0=Domingo … 6=Sábado) cada canal cadastrado
// no painel /divulgacao deve ser usado — plano fixo de postagem, salvo no
// servidor e visível/editável por todo o time. Mesmo padrão de JSON no Volume
// dos blocos de empresas e vagas acima. Formato: { "Nome do Canal": [0,2,4] }.
const vagasCronogramaDriveStore = criarStoreCacheado({
  nomeArquivo: "vagas-cronograma.json",
  pastaNome: "Vagas",
  valorPadrao: {},
  migrarDeArquivoLocal: process.env.VAGAS_CRONOGRAMA_PATH || "/data/vagas-cronograma.json"
});

function lerVagasCronograma() {
  const obj = vagasCronogramaDriveStore.ler();
  return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
}

function gravarVagasCronograma(obj) {
  return vagasCronogramaDriveStore.gravar(obj);
}

// Lista o cronograma inteiro (canal -> dias da semana em que deve ser usado).
app.get("/vagas/cronograma", (req, res) => {
  res.json({ ok: true, cronograma: lerVagasCronograma() });
});

// Salva o cronograma inteiro — o painel manda o objeto completo já com a
// edição aplicada, mesmo padrão simples dos outros endpoints de /vagas.
app.post("/vagas/cronograma", (req, res) => {
  const cronograma = (req.body && typeof req.body.cronograma === "object" && req.body.cronograma && !Array.isArray(req.body.cronograma))
    ? req.body.cronograma : null;
  if (!cronograma) return res.json({ ok: false, erro: "Envie { cronograma: {...} }" });
  const salvo = gravarVagasCronograma(cronograma);
  res.json({ ok: salvo, erro: salvo ? undefined : "Não foi possível salvar no servidor" });
});

// ── TEMPLATES DE ARTE (Divulgação de Vagas) ──────────────────────────────────
// Designs prontos salvos pelo time no painel /divulgacao: cada template guarda
// os 4 formatos (Feed, Retrato, Stories, LinkedIn) sem a foto da vaga.
// Mesmo padrão de JSON no Volume dos dois blocos acima.
const vagasTemplatesDriveStore = criarStoreCacheado({
  nomeArquivo: "vagas-templates.json",
  pastaNome: "Vagas",
  valorPadrao: [],
  migrarDeArquivoLocal: process.env.VAGAS_TEMPLATES_PATH || "/data/vagas-templates.json"
});

function lerVagasTemplates() {
  const lista = vagasTemplatesDriveStore.ler();
  return Array.isArray(lista) ? lista : [];
}

function gravarVagasTemplates(lista) {
  return vagasTemplatesDriveStore.gravar(lista);
}

app.get("/vagas/templates", (req, res) => {
  res.json({ ok: true, templates: lerVagasTemplates() });
});

app.post("/vagas/templates", (req, res) => {
  const lista = Array.isArray(req.body.templates) ? req.body.templates : null;
  if (!lista) return res.json({ ok: false, erro: "Envie { templates: [...] }" });
  const salvo = gravarVagasTemplates(lista);
  res.json({ ok: salvo, erro: salvo ? undefined : "Não foi possível salvar no servidor" });
});

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

// Gera uma foto de profissional via IA (DALL-E 3) a partir do cargo — usada no
// cartaz de divulgação (seção 5). Disparo sempre manual (botão), nunca automático.
app.post("/vagas/gerar-foto", async (req, res) => {
  try {
    const cargo = String(req.body.cargo || "").trim();
    if (!cargo) return res.json({ ok: false, erro: "Informe o cargo antes de gerar a foto." });
    const resultado = await gerarFotoProfissional(cargo);
    res.json(resultado);
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
      // Envia mensagem WhatsApp.
      // BUG CORRIGIDO: candidatos inativos estão fora da janela de 24h da Meta,
      // então mensagem livre falha com erro 131047 e eles nunca recebiam nada.
      // Agora, se a mensagem livre falhar por janela fechada, cai para o
      // template aprovado (mesmo comportamento do /inbox/enviar).
      let usouTemplate = false;
      try {
        // Verificação PROATIVA: candidato inativo = janela de 24h fechada.
        // A Meta aceita mensagem livre e descarta em silêncio, então nem tenta.
        if (foraDaJanela24h(sessoes[resolverTelefoneCanonico(tel)] || sessoes[tel])) throw new Error("[131047] Janela de 24h fechada (verificação proativa)");
        await enviarMensagem(tel, mensagem);
      } catch (e) {
        const foraJanela = String(e.message || "").includes("131047") ||
                           String(e.message || "").toLowerCase().includes("re-engagement");
        if (!foraJanela) throw e;
        const t = await enviarTemplate(tel, CONFIG.TEMPLATE_DIVULGACAO_VAGA || "effect_reengajamento_candidatos", "pt_BR");
        if (!t.sucesso) throw new Error(`Fora da janela 24h e template falhou: ${t.erro}`);
        usouTemplate = true;
      }
      // Registra no histórico
      const nomeCand = sessoes[tel].nome || tel;
      const textoRegistro = usouTemplate ? `[Enviado via Template - fora da janela 24h]\n\n${mensagem}` : mensagem;
      registrarEntradaSessao(sessoes[tel], "assistant", textoRegistro);
      await salvarMensagemSheets(tel, "assistant", textoRegistro, nomeCand);
      resultados.push({ telefone: tel, ok: true, metodo: usouTemplate ? "template" : "mensagem_livre" });
    } catch(e) {
      resultados.push({ telefone: tel, ok: false, erro: e.message });
    }
    // Pausa entre envios para não estourar rate limit da Meta
    await new Promise(r => setTimeout(r, 1100));
  }
  const enviados = resultados.filter(r => r.ok).length;
  const falhas = resultados.filter(r => !r.ok);
  console.log(`[REATIVAR-BANCO] Enviado para ${enviados}/${telefones.length} candidatos — cargo: ${cargo}${falhas.length ? ` — ${falhas.length} falha(s): ${falhas[0].erro}` : ""}`);
  res.json({ ok: true, total: telefones.length, enviados, falhas: falhas.length, resultados });
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

// ── PROBLEMA DO 9º DÍGITO BRASILEIRO ─────────────────────────────────────────
// A Meta registra números BR às vezes SEM o 9 extra (ex.: 552796556776) enquanto
// planilhas/currículos trazem COM o 9 (5527996556776). Para a Meta são números
// DIFERENTES: enviar para a variante que nunca mandou mensagem cai "fora da
// janela de 24h" (erro 131047) mesmo com o candidato ativo. Antes de enviar,
// escolhe a variante que tem mensagem RECEBIDA do candidato (wa_id real).
function resolverTelefoneCanonico(telOriginal) {
  const t = limparTelefone(telOriginal);
  if (!t.startsWith("55") || (t.length !== 12 && t.length !== 13)) return t;
  const com9 = t.length === 13 ? t : t.slice(0, 4) + "9" + t.slice(4);
  const sem9 = t.length === 12 ? t : (t[4] === "9" ? t.slice(0, 4) + t.slice(5) : t);
  const variantes = [...new Set([t, com9, sem9])];
  let melhor = t, melhorTs = -1;
  for (const v of variantes) {
    const s = (typeof sessoes !== "undefined") ? sessoes[v] : null;
    if (!s || !Array.isArray(s.historico)) continue;
    for (let i = s.historico.length - 1; i >= 0; i--) {
      const ev = s.historico[i];
      if (ev && ev.role === "user") {
        const ts = Number(ev.timestampMs || 0);
        if (ts > melhorTs) { melhorTs = ts; melhor = v; }
        break;
      }
    }
  }
  if (melhor !== t) console.log(`[TELEFONE] Corrigido 9º dígito: ${t} → ${melhor} (wa_id real do candidato)`);
  return melhor;
}

async function enviarMensagem(toOriginal, body) {
  const to = resolverTelefoneCanonico(toOriginal);
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
  const to = resolverTelefoneCanonico(telefone);
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

// Verifica PROATIVAMENTE se o candidato está fora da janela de 24h da Meta.
// Necessário porque a Meta muitas vezes ACEITA o envio de mensagem livre na API
// (retorna 200) e só falha depois, via webhook de status — ou seja, o try/catch
// no envio não pega o erro 131047 e a mensagem "some" sem ninguém perceber.
// Olha a última mensagem RECEBIDA do candidato (role user) no histórico.
function foraDaJanela24h(sessao) {
  const JANELA_MS = 24 * 60 * 60 * 1000;
  const historico = (sessao && sessao.historico) || [];
  let ultimaDoCandidato = 0;
  for (let i = historico.length - 1; i >= 0; i--) {
    if (historico[i] && historico[i].role === "user") {
      ultimaDoCandidato = Number(historico[i].timestampMs || 0);
      break;
    }
  }
  // Sem mensagem do candidato registrada = não há janela aberta
  if (!ultimaDoCandidato) return true;
  return (Date.now() - ultimaDoCandidato) > JANELA_MS;
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

// ── AGENDA PESSOAL (Meu App) — lê/escreve direto no Google Calendar real ────
// Mesmo calendário usado pelas entrevistas (calendar.js), então tudo aparece
// junto: entrevistas marcadas pela Lia + compromissos pessoais da Thiara.
app.get("/api/agenda-pessoal/eventos", async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    if (!inicio || !fim) return res.status(400).json({ ok: false, erro: "Parâmetros 'inicio' e 'fim' obrigatórios (YYYY-MM-DD)" });
    const result = await calendar.listarEventos(inicio, fim);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, erro: e.message, eventos: [] }); }
});

app.post("/api/agenda-pessoal/eventos", async (req, res) => {
  try {
    const { titulo, data } = req.body || {};
    if (!titulo || !data) return res.status(400).json({ ok: false, erro: "Campos obrigatórios: titulo, data" });
    const result = await calendar.criarEventoPessoal(req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.put("/api/agenda-pessoal/eventos/:id", async (req, res) => {
  try {
    const result = await calendar.editarEvento(req.params.id, req.body || {});
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

app.delete("/api/agenda-pessoal/eventos/:id", async (req, res) => {
  try {
    const result = await calendar.excluirEvento(req.params.id);
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
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

// ── AVALIAÇÃO DE CANDIDATOS (link independente, sem depender da Lia) ──────
app.get("/roteiro-entrevista", (req, res) => res.sendFile(path.join(__dirname, "roteiro-entrevista.html")));
app.get("/templates-cargos.js", (req, res) => res.sendFile(path.join(__dirname, "templates-cargos.js")));
app.get("/avaliacoes", (req, res) => res.sendFile(path.join(__dirname, "avaliacoes-painel.html")));
app.get("/avaliacao-resultado/:token", (req, res) => res.sendFile(path.join(__dirname, "avaliacao-resultado.html")));
app.get("/avaliar/:token", (req, res) => res.sendFile(path.join(__dirname, "avaliar.html")));

// Recrutadora gera um novo link para um candidato/vaga.
app.post("/api/avaliacoes/criar", (req, res) => {
  try {
    const nome = String(req.body.nome || "").trim();
    const vaga = String(req.body.vaga || "").trim();
    const nivel = String(req.body.nivel || "administrativo").trim().toLowerCase();
    const cargo = String(req.body.cargo || "outro").trim().toLowerCase();
    const telefone = req.body.telefone ? limparTelefone(req.body.telefone) : "";
    if (!nome) return res.json({ ok: false, erro: "Informe o nome do candidato" });

    const token = gerarTokenAvaliacao();
    const registro = {
      token, nome, vaga, nivel, cargo, telefone,
      status: "pendente",
      criadoEm: new Date().toISOString(),
      respondidoEm: null,
      disc: null,
      valores: null,
      situacional: null,
      pratico: null,
      resiliencia: null,
      estabilidade: null,
      disponibilidade: null
    };

    const lista = lerAvaliacoes();
    lista.unshift(registro);
    gravarAvaliacoes(lista);

    const query = new URLSearchParams();
    if (nivel && nivel !== "administrativo") query.set("nivel", nivel);
    if (cargo && cargo !== "outro") query.set("cargo", cargo);
    const qs = query.toString();
    const link = `${CONFIG.PUBLIC_BASE_URL}/avaliar/${token}${qs ? "?" + qs : ""}`;
    res.json({ ok: true, token, link });
  } catch (e) {
    console.error("Erro /api/avaliacoes/criar:", e.message);
    res.json({ ok: false, erro: e.message });
  }
});

// Lista para o painel da recrutadora (avaliacoes-painel.html).
app.get("/api/avaliacoes", (req, res) => {
  try {
    const lista = lerAvaliacoes().map(a => ({
      token: a.token, nome: a.nome, vaga: a.vaga, nivel: a.nivel, cargo: a.cargo,
      status: a.status, criadoEm: a.criadoEm, respondidoEm: a.respondidoEm
    }));
    res.json({ ok: true, avaliacoes: lista });
  } catch (e) {
    res.json({ ok: false, erro: e.message, avaliacoes: [] });
  }
});

// Checagem de existência/status consumida pela tela inicial de avaliar.html
// (link inválido, já respondido, ou pré-preenchimento de nome/vaga).
app.get("/api/avaliacoes/:token", (req, res) => {
  try {
    const registro = lerAvaliacoes().find(a => a.token === req.params.token);
    if (!registro) return res.json({ ok: true, existe: false });
    res.json({
      ok: true, existe: true,
      respondido: registro.status === "respondido",
      nome: registro.nome, vaga: registro.vaga, nivel: registro.nivel, cargo: registro.cargo
    });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// Resultado consolidado — JSON consumido por avaliacao-resultado.html.
app.get("/api/avaliacao-resultado/:token", (req, res) => {
  try {
    const registro = lerAvaliacoes().find(a => a.token === req.params.token);
    if (!registro) return res.json({ ok: false, erro: "Avaliação não encontrada" });
    res.json({ ok: true, avaliacao: registro });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// Candidata envia o pacote completo (DISC + Valores + Disponibilidade) de uma vez só,
// ao final do fluxo em avaliar.html — sem depender de sessão/telefone da Lia.
app.post("/avaliar/:token/submit", (req, res) => {
  try {
    const token = req.params.token;
    const lista = lerAvaliacoes();
    const idx = lista.findIndex(a => a.token === token);
    if (idx === -1) return res.json({ ok: false, erro: "Avaliação não encontrada" });

    const body = req.body || {};
    const registro = lista[idx];
    if (body.nome) registro.nome = String(body.nome).trim() || registro.nome;
    if (body.vaga) registro.vaga = String(body.vaga).trim() || registro.vaga;
    if (body.cargo) registro.cargo = String(body.cargo).trim().toLowerCase() || registro.cargo;
    if (body.cargoLabel) registro.cargoLabel = String(body.cargoLabel).trim() || registro.cargoLabel;
    registro.disc = body.disc || null;
    registro.valores = Array.isArray(body.valores) ? body.valores : [];
    registro.situacional = body.situacional || null;
    registro.pratico = body.pratico || null;
    registro.resiliencia = body.resiliencia || null;
    registro.estabilidade = body.estabilidade || null;
    registro.disponibilidade = body.disponibilidade || null;
    registro.status = "respondido";
    registro.respondidoEm = new Date().toISOString();

    lista[idx] = registro;
    gravarAvaliacoes(lista);

    res.json({ ok: true });
  } catch (e) {
    console.error("Erro /avaliar/:token/submit:", e.message);
    res.json({ ok: false, erro: e.message });
  }
});

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
// ── INBOX PERSISTENCE (Google Drive — ver drive-json-store.js) ─────────────
// inboxDriveStore (criado lá em cima, perto de lerDadosInbox/gravarDadosInbox)
// já cuida de ler/gravar no Drive. Aqui só restauramos o geminiAtivo salvo
// assim que o carregamento inicial do Drive terminar.

// ── RESTAURA geminiAtivo DO DRIVE AO LIGAR O SERVIDOR ───────────────────────
// BUG CRÍTICO CORRIGIDO (histórico): geminiAtivo era sempre resetado para
// `true` a cada deploy/restart, mesmo quando o estado salvo era `false`. Isso
// fazia a Lia voltar a responder sozinha depois de qualquer redeploy, mesmo
// com o botão "IA OFF" marcado. Como o carregamento do Drive é assíncrono,
// esperamos ele terminar (prontoPromise) antes de restaurar o estado — nos
// primeiros instantes após o servidor subir, geminiAtivo mantém o valor
// padrão (true) até essa Promise resolver, o que leva no máximo alguns
// segundos.
inboxDriveStore.prontoPromise.then(() => {
  const dadosSalvos = lerDadosInbox();
  if (dadosSalvos && typeof dadosSalvos.geminiAtivo === "boolean") {
    geminiAtivo = dadosSalvos.geminiAtivo;
    inboxDataCache = dadosSalvos;
    console.log(`[IA] Estado restaurado do Drive ao iniciar: geminiAtivo = ${geminiAtivo}`);
  }
}).catch(e => {
  console.error("[IA] Erro ao restaurar geminiAtivo do Drive:", e.message);
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
