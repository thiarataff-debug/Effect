// supervisor.js — Monitor da LIA (Effect Pessoas e Performance)
// Criado em: 19/06/2026
//
// Funções exportadas:
//   iniciarSupervisor()            — inicia todos os monitoramentos
//   registrarErroMeta(err, tel)   — chamado quando enviarMensagem() falha
//   registrarErroLia(tipo, desc)  — chamado em qualquer erro interno da LIA
//   obterStatusSupervisor()       — retorna resumo do estado atual
//   dispararResumoSemanal()       — envia resumo manual via WhatsApp

const axios = require("axios");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const THIARA_WHATSAPP = "5527997925288";
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID   = process.env.PHONE_NUMBER_ID;
const RAILWAY_TOKEN     = process.env.RAILWAY_TOKEN;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const GITHUB_REPO       = process.env.GITHUB_REPO; // ex: "thiara/effect-main"
const DRIVE_SCRIPT_URL  = process.env.DRIVE_SCRIPT_URL;

// ─── ESTADO INTERNO ───────────────────────────────────────────────────────────
const log = {
  railway:   [],
  github:    [],
  meta:      [],
  appscript: [],
  lia:       [],
};

const ultimoAlerta = {};        // chave → timestamp do último alerta enviado
let totalMensagensEnviadas = 0;
let totalErrosMeta = 0;
let supervisorAtivo = false;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function agoraBR() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

// Retorna true se passou o intervalo mínimo desde o último alerta com essa chave
function podeAlertar(chave, intervaloMs = 30 * 60 * 1000) {
  const ultimo = ultimoAlerta[chave] || 0;
  if (Date.now() - ultimo >= intervaloMs) {
    ultimoAlerta[chave] = Date.now();
    return true;
  }
  return false;
}

async function enviarAlerta(mensagem) {
  if (!META_ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("[Supervisor] WhatsApp não configurado — alerta não enviado");
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: THIARA_WHATSAPP,
        type: "text",
        text: { preview_url: false, body: mensagem },
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    console.log("[Supervisor] ✅ Alerta enviado para Thiara");
  } catch (e) {
    console.error("[Supervisor] Falha ao enviar alerta:", e.message);
  }
}

// ─── MONITORAMENTO: RAILWAY ───────────────────────────────────────────────────
async function verificarRailway() {
  if (!RAILWAY_TOKEN) return;
  try {
    const query = `{
      me {
        projects {
          edges {
            node {
              name
              deployments(last: 3) {
                edges {
                  node { id status createdAt }
                }
              }
            }
          }
        }
      }
    }`;

    const res = await axios.post(
      "https://backboard.railway.app/graphql/v2",
      { query },
      {
        headers: {
          Authorization: `Bearer ${RAILWAY_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    const projects = res.data?.data?.me?.projects?.edges || [];
    for (const { node: proj } of projects) {
      for (const { node: dep } of proj.deployments?.edges || []) {
        if (["FAILED", "CRASHED", "ERROR"].includes(dep.status)) {
          const chave = `railway_${dep.id}`;
          if (podeAlertar(chave, 60 * 60 * 1000)) {
            const horario = new Date(dep.createdAt).toLocaleString("pt-BR", {
              timeZone: "America/Sao_Paulo",
            });
            await enviarAlerta(
              `🚨 FALHA NO RAILWAY\n\nProjeto: ${proj.name}\nStatus: ${dep.status}\nHorário: ${horario}\n\n⚠️ A LIA pode estar fora do ar!\nAcesse: railway.app para verificar.`
            );
            log.railway.push({ status: dep.status, projeto: proj.name, horario: agoraBR() });
          }
        }
      }
    }
  } catch (e) {
    console.error("[Supervisor] Erro ao verificar Railway:", e.message);
    // Falha de rede ao verificar Railway pode indicar problema no próprio Railway
    if (podeAlertar("railway_conexao", 60 * 60 * 1000)) {
      await enviarAlerta(
        `⚠️ SUPERVISOR — Falha ao consultar Railway\n\nErro: ${e.message}\n\nVerifique manualmente: railway.app`
      );
    }
  }
}

// ─── MONITORAMENTO: GITHUB ACTIONS ────────────────────────────────────────────
async function verificarGithub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=5`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
        timeout: 15000,
      }
    );

    const runs = res.data?.workflow_runs || [];
    for (const run of runs) {
      if (run.conclusion === "failure") {
        const chave = `github_${run.id}`;
        if (podeAlertar(chave, 2 * 60 * 60 * 1000)) {
          const horario = new Date(run.created_at).toLocaleString("pt-BR", {
            timeZone: "America/Sao_Paulo",
          });
          await enviarAlerta(
            `⚠️ GITHUB ACTIONS COM FALHA\n\nWorkflow: ${run.name}\nHorário: ${horario}\n\nVer detalhes: ${run.html_url}`
          );
          log.github.push({ workflow: run.name, horario: agoraBR() });
        }
      }
    }
  } catch (e) {
    console.error("[Supervisor] Erro ao verificar GitHub:", e.message);
  }
}

// ─── MONITORAMENTO: APPS SCRIPT ───────────────────────────────────────────────
async function verificarAppScript() {
  if (!DRIVE_SCRIPT_URL) return;
  try {
    const urlBase = DRIVE_SCRIPT_URL.split("?")[0];
    const res = await axios.get(`${urlBase}?acao=ping`, { timeout: 15000 });
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}`);
    }
    // Se chegou aqui, Apps Script está respondendo — OK
  } catch (e) {
    if (podeAlertar("appscript", 30 * 60 * 1000)) {
      await enviarAlerta(
        `⚠️ APPS SCRIPT INACESSÍVEL\n\nErro: ${e.message}\nHorário: ${agoraBR()}\n\nO Apps Script pode estar com quota excedida ou fora do ar. Verifique no Google Drive.`
      );
      log.appscript.push({ erro: e.message, horario: agoraBR() });
    }
  }
}

// ─── REGISTRO: ERROS META (chamado de index.js) ───────────────────────────────
function registrarErroMeta(erro, telefone = "") {
  totalErrosMeta++;
  log.meta.push({ erro: String(erro), telefone, horario: agoraBR() });

  // Alerta se ≥3 erros nos últimos 10 minutos
  const diezMin = Date.now() - 10 * 60 * 1000;
  const recentes = log.meta.filter((e) => {
    const ms = new Date(e.horario).getTime();
    return ms > diezMin;
  });

  if (recentes.length >= 3 && podeAlertar("meta_falhas", 20 * 60 * 1000)) {
    enviarAlerta(
      `🔴 META/WHATSAPP COM FALHAS\n\n${recentes.length} erros nos últimos 10 minutos.\n\nÚltimo erro: ${erro}\n\nVerifique:\n• Token da Meta API (validade)\n• PHONE_NUMBER_ID\n• Limite de mensagens da conta`
    ).catch(() => {});
  }
}

// ─── REGISTRO: ERROS INTERNOS DA LIA (chamado de index.js) ───────────────────
function registrarErroLia(tipo, descricao, telefone = "") {
  log.lia.push({ tipo, descricao, telefone, horario: agoraBR() });
  console.error(`[LIA Error] ${tipo}: ${descricao}`);
}

// ─── CONTADOR DE MENSAGENS ENVIADAS ──────────────────────────────────────────
function contarMensagemEnviada() {
  totalMensagensEnviadas++;
}

// ─── RESUMO SEMANAL ───────────────────────────────────────────────────────────
async function dispararResumoSemanal() {
  const totalErros = Object.values(log).reduce((s, arr) => s + arr.length, 0);

  const linhas = [
    `📊 RESUMO SEMANAL — LIA`,
    `🗓️ ${agoraBR()}`,
    ``,
    `📨 Mensagens enviadas esta semana: ${totalMensagensEnviadas}`,
    ``,
    `Falhas registradas:`,
    `• Railway: ${log.railway.length}`,
    `• GitHub Actions: ${log.github.length}`,
    `• Meta/WhatsApp: ${log.meta.length}`,
    `• Apps Script: ${log.appscript.length}`,
    `• LIA interno: ${log.lia.length}`,
  ];

  if (totalErros === 0) {
    linhas.push(`\n✅ Semana sem falhas! Tudo funcionando.`);
  } else {
    if (log.meta.length > 0) {
      linhas.push(`\n🔴 Últimos erros Meta:`);
      log.meta.slice(-3).forEach((e) =>
        linhas.push(`  • ${e.horario}: ${e.erro}`)
      );
    }
    if (log.railway.length > 0) {
      linhas.push(`\n🚨 Falhas Railway:`);
      log.railway.slice(-3).forEach((e) =>
        linhas.push(`  • ${e.horario}: ${e.status} (${e.projeto})`)
      );
    }
    linhas.push(
      `\n💡 Recomendação: faça um deploy limpo no Railway e revise os logs.`
    );
  }

  await enviarAlerta(linhas.join("\n"));

  // Zera contadores após enviar
  Object.keys(log).forEach((k) => (log[k] = []));
  totalMensagensEnviadas = 0;
}

// ─── STATUS ATUAL (para rota /supervisor/status) ──────────────────────────────
function obterStatusSupervisor() {
  return {
    ativo: supervisorAtivo,
    horarioConsulta: agoraBR(),
    totalMensagensEnviadas,
    totalErrosMeta,
    erros: {
      railway: log.railway.length,
      github: log.github.length,
      meta: log.meta.length,
      appscript: log.appscript.length,
      lia: log.lia.length,
    },
    ultimosErros: {
      meta: log.meta.slice(-5),
      lia: log.lia.slice(-5),
    },
  };
}

// ─── INICIAR ──────────────────────────────────────────────────────────────────
function iniciarSupervisor() {
  if (supervisorAtivo) return;
  supervisorAtivo = true;

  console.log("[Supervisor] ✅ Monitoramento da LIA iniciado");

  // Railway + Apps Script: a cada 5 minutos
  setInterval(async () => {
    await verificarRailway();
    await verificarAppScript();
  }, 5 * 60 * 1000);

  // GitHub: a cada 15 minutos
  setInterval(verificarGithub, 15 * 60 * 1000);

  // Resumo semanal: toda segunda-feira às 08h
  setInterval(async () => {
    const br = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    );
    if (br.getDay() === 1 && br.getHours() === 8 && br.getMinutes() < 5) {
      await dispararResumoSemanal();
    }
  }, 5 * 60 * 1000); // checa a cada 5 min
}

module.exports = {
  iniciarSupervisor,
  registrarErroMeta,
  registrarErroLia,
  contarMensagemEnviada,
  obterStatusSupervisor,
  dispararResumoSemanal,
};
