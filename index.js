const express = require("express");
const axios = require("axios");
const pdfParse = require("pdf-parse");
const path = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

const CONFIG = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "effect_lia_2026",
  VAGAS_URL: process.env.VAGAS_URL,
  THIARA_WHATSAPP: "5527997925288"
};

const sessoes = {};
const mensagensProcessadas = new Set();
const atendimentosManuais = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function limparTelefone(telefone) {
  return String(telefone || "").replace(/\D/g, "");
}

function garantirSessao(telefoneOriginal) {
  const telefone = limparTelefone(telefoneOriginal);

  if (!sessoes[telefone]) {
    sessoes[telefone] = {
      historico: [],
      nome: null,
      modo: "automatico",
      pausado: false
    };
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

  return (
    atendimentosManuais.has(telefone) ||
    sessao.pausado === true ||
    sessao.modo === "manual"
  );
}

// ============================================================
// SHEETS
// ============================================================

async function salvarMensagemSheets(telefoneOriginal, role, mensagem, nome) {
  const telefone = limparTelefone(telefoneOriginal);
  const MAX_TENTATIVAS = 3;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      if (!CONFIG.VAGAS_URL) return;

      const urlBase = CONFIG.VAGAS_URL.split("?")[0];

      const payload = JSON.stringify({
        acao: "salvarMensagem",
        telefone,
        role,
        mensagem,
        nome: nome || "",
        timestamp: new Date().toISOString()
      });

      await axios.post(urlBase, payload, {
        headers: { "Content-Type": "text/plain" },
        timeout: 15000,
        maxRedirects: 5
      });

      return;
    } catch (e) {
      console.error(`Erro salvarMensagemSheets (${tentativa}/${MAX_TENTATIVAS}):`, e.message);
      if (tentativa < MAX_TENTATIVAS) await sleep(2000 * tentativa);
    }
  }
}

async function salvarConversaCompletaSheets(telefoneOriginal, historico, nome) {
  const telefone = limparTelefone(telefoneOriginal);

  try {
    if (!CONFIG.VAGAS_URL) return;

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];

    const payload = JSON.stringify({
      acao: "salvarConversaCompleta",
      telefone,
      nome: nome || "",
      historico: historico || [],
      modo: sessoes[telefone]?.modo || "automatico",
      pausado: sessoes[telefone]?.pausado || false,
      timestamp: new Date().toISOString()
    });

    await axios.post(urlBase, payload, {
      headers: { "Content-Type": "text/plain" },
      timeout: 20000,
      maxRedirects: 5
    });
  } catch (e) {
    console.error("Erro salvarConversaCompletaSheets:", e.message);
  }
}

async function carregarSessoesDoSheets() {
  try {
    if (!CONFIG.VAGAS_URL) return;

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const url = `${urlBase}?acao=conversas`;

    const r = await axios.get(url, { timeout: 15000, maxRedirects: 5 });
    const data = r.data;

    if (!data.sucesso || !data.sessoes) return;

    Object.entries(data.sessoes).forEach(([telOriginal, sessao]) => {
      const tel = limparTelefone(telOriginal);

      const modo = sessao.modo || (sessao.pausado ? "manual" : "automatico");

      sessoes[tel] = {
        historico: Array.isArray(sessao.historico)
          ? sessao.historico.map(h => ({ role: h.role, content: h.content }))
          : [],
        nome: sessao.nome || null,
        modo,
        pausado: modo === "manual" || sessao.pausado === true
      };

      if (sessoes[tel].pausado) {
        atendimentosManuais.add(tel);
      }
    });

    console.log(`Sessões carregadas do Sheets: ${Object.keys(data.sessoes).length}`);
  } catch (e) {
    console.error("Erro carregarSessoesDoSheets:", e.message);
  }
}

carregarSessoesDoSheets();

setInterval(async () => {
  for (const [telefone, sessao] of Object.entries(sessoes)) {
    if (sessao.historico && sessao.historico.length > 0) {
      await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// VAGA FIXA
// ============================================================

const VAGA_DIARIA_LINHARES = {
  idVaga: "LIN-DIA-01",
  cargo: "Auxiliar de Serviços Gerais (Diária)",
  area: "Serviços Gerais / Limpeza",
  cidade: "Linhares/ES — Bairro Shell",
  salario: "R$ 250,00 por dia (incluso passagem e alimentação)",
  escala: "Diária — entrevistas previstas para quarta-feira",
  escolaridade: "Ensino Fundamental",
  experienciaMinima: "Sem experiência obrigatória",
  aceitaSemExperiencia: "Sim",
  perfilResumido: "Auxiliar de serviços gerais para trabalho de limpeza em Linhares, bairro Shell. Diária de R$ 250,00 com passagem e alimentação inclusos.",
  palavrasChave: "limpeza, serviços gerais, diária, linhares, faxina, auxiliar",
  requisitoObrigatorio: "Disponibilidade para trabalho em Linhares/ES, bairro Shell",
  observacoes: "Não exige currículo. Perguntar apenas se tem experiência em limpeza."
};

// ============================================================
// ROTAS PRINCIPAIS
// ============================================================

app.get("/", (req, res) => {
  res.send("Lia Effect rodando — trava manual reforçada ✅");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return;

    if (message.id && mensagensProcessadas.has(message.id)) return;

    if (message.id) {
      mensagensProcessadas.add(message.id);
      if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear();
    }

    if (!message.text?.body && !message.document) return;

    const from = limparTelefone(message.from);
    const sessaoAtual = garantirSessao(from);

    if (message.text?.body) {
      const texto = message.text.body;

      sessaoAtual.historico.push({ role: "user", content: texto });
      sessaoAtual.historico = sessaoAtual.historico.slice(-20);

      await salvarMensagemSheets(from, "user", texto, sessaoAtual.nome || "");

      if (estaEmManual(from)) {
        console.log("LIA BLOQUEADA — ATENDIMENTO MANUAL:", from);
        await salvarConversaCompletaSheets(from, sessaoAtual.historico, sessaoAtual.nome);
        return;
      }

      const resposta = await processarMensagem(from, texto);

      if (resposta) {
        await enviarMensagem(from, resposta);
      }

      return;
    }

    if (message.document) {
      sessaoAtual.historico.push({
        role: "user",
        content: "[Documento/Currículo recebido]"
      });

      sessaoAtual.historico = sessaoAtual.historico.slice(-20);

      if (estaEmManual(from)) {
        console.log("LIA BLOQUEADA — DOCUMENTO EM ATENDIMENTO MANUAL:", from);
        await salvarConversaCompletaSheets(from, sessaoAtual.historico, sessaoAtual.nome);
        return;
      }

      if (ehCandidataDiaria(sessaoAtual)) {
        const msg = "Obrigada! Para essa vaga não é necessário enviar currículo. Já tenho suas informações. Em breve entraremos em contato sobre a entrevista. 💙";
        await enviarMensagem(from, msg);
        await salvarMensagemSheets(from, "assistant", msg, sessaoAtual.nome);
        return;
      }

      await enviarMensagem(from, "Perfeito, recebi seu currículo. Vou analisar as informações agora. 💙");

      const resposta = await processarCurriculo(from, message.document);

      if (resposta) {
        await enviarMensagem(from, resposta);
      }

      return;
    }
  } catch (erro) {
    console.error("Erro no webhook:", JSON.stringify(erro.response?.data || erro.message));
  }
});

function ehCandidataDiaria(sessao) {
  if (!sessao || !sessao.historico) return false;

  const texto = sessao.historico
    .map(h => h.content || "")
    .join(" ")
    .toLowerCase();

  return (
    texto.includes("diária") ||
    texto.includes("diaria") ||
    texto.includes("linhares") ||
    texto.includes("shell") ||
    texto.includes("lin-dia")
  );
}

// ============================================================
// ROTAS SHEETS
// ============================================================

app.get("/sheets", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox-sheets.html"));
});

app.get("/sheets/candidatos", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ candidatos: [] });

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=candidatos`, { timeout: 15000 });

    res.json(r.data);
  } catch (e) {
    res.json({ candidatos: [], erro: e.message });
  }
});

app.get("/sheets/vagas", async (req, res) => {
  try {
    if (!CONFIG.VAGAS_URL) return res.json({ vagas: [] });

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=vagas`, { timeout: 15000 });

    res.json(r.data);
  } catch (e) {
    res.json({ vagas: [], erro: e.message });
  }
});

// ============================================================
// ROTAS INBOX
// ============================================================

app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
});

app.get("/inbox/sessoes", (req, res) => {
  try {
    const dados = {};

    Object.entries(sessoes).forEach(([tel, sessao]) => {
      const telefone = limparTelefone(tel);
      garantirSessao(telefone);

      dados[telefone] = {
        historico: sessao.historico || [],
        nome: sessao.nome || null,
        modo: sessao.modo || "automatico",
        pausado: sessao.pausado === true || atendimentosManuais.has(telefone),
        aguardandoConfirmacaoInteresse: sessao.aguardandoConfirmacaoInteresse || false,
        ultimaAnalise: sessao.ultimaAnalise || null
      };
    });

    res.json({ sessoes: dados, total: Object.keys(dados).length });
  } catch (erro) {
    res.json({ sessoes: {}, total: 0 });
  }
});

app.post("/inbox/pausar", async (req, res) => {
  try {
    const telefone = limparTelefone(
      req.body.telefone ||
      req.body.phone ||
      req.body.from ||
      req.body.numero ||
      req.body.whatsapp
    );

    const devePausar =
      req.body.pausado === true ||
      req.body.manual === true ||
      req.body.modo === "manual" ||
      req.body.mode === "manual" ||
      req.body.status === "manual";

    if (!telefone) {
      return res.json({ ok: false, erro: "Telefone não informado" });
    }

    const sessao = garantirSessao(telefone);

    if (devePausar) {
      atendimentosManuais.add(telefone);
      sessao.modo = "manual";
      sessao.pausado = true;
    } else {
      atendimentosManuais.delete(telefone);
      sessao.modo = "automatico";
      sessao.pausado = false;
    }

    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

    console.log("STATUS MANUAL ALTERADO:", telefone, {
      modo: sessao.modo,
      pausado: sessao.pausado
    });

    return res.json({
      ok: true,
      telefone,
      modo: sessao.modo,
      pausado: sessao.pausado
    });
  } catch (erro) {
    console.error("Erro /inbox/pausar:", erro.message);
    return res.json({ ok: false, erro: erro.message });
  }
});

app.post("/inbox/modo", async (req, res) => {
  try {
    const telefone = limparTelefone(
      req.body.telefone ||
      req.body.phone ||
      req.body.from ||
      req.body.numero ||
      req.body.whatsapp
    );

    const modo = req.body.modo || req.body.mode;

    if (!telefone) {
      return res.json({ ok: false, erro: "Telefone não informado" });
    }

    const sessao = garantirSessao(telefone);

    if (modo === "manual") {
      atendimentosManuais.add(telefone);
      sessao.modo = "manual";
      sessao.pausado = true;
    } else {
      atendimentosManuais.delete(telefone);
      sessao.modo = "automatico";
      sessao.pausado = false;
    }

    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

    return res.json({
      ok: true,
      telefone,
      modo: sessao.modo,
      pausado: sessao.pausado
    });
  } catch (erro) {
    return res.json({ ok: false, erro: erro.message });
  }
});

app.post("/inbox/enviar", async (req, res) => {
  try {
    const telefone = limparTelefone(
      req.body.telefone ||
      req.body.phone ||
      req.body.from ||
      req.body.numero ||
      req.body.whatsapp
    );

    const mensagem = req.body.mensagem || req.body.message || req.body.texto || req.body.text;

    if (!telefone || !mensagem) {
      return res.json({ ok: false, erro: "Dados incompletos" });
    }

    const sessao = garantirSessao(telefone);

    atendimentosManuais.add(telefone);
    sessao.modo = "manual";
    sessao.pausado = true;

    await enviarMensagem(telefone, mensagem);

    sessao.historico.push({ role: "assistant", content: mensagem });
    sessao.historico = sessao.historico.slice(-20);

    await salvarMensagemSheets(telefone, "assistant", mensagem, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

    return res.json({
      ok: true,
      telefone,
      modo: "manual",
      pausado: true
    });
  } catch (erro) {
    console.error("Erro inbox/enviar:", erro.message);
    res.json({ ok: false, erro: erro.message });
  }
});

app.post("/inbox/observacao", async (req, res) => {
  const telefone = limparTelefone(req.body.telefone || req.body.phone || req.body.from);
  const observacao = req.body.observacao || req.body.note || "";

  if (!telefone) return res.json({ ok: false });

  try {
    if (CONFIG.VAGAS_URL) {
      const urlBase = CONFIG.VAGAS_URL.split("?")[0];

      await axios.post(urlBase, {
        acao: "salvarMensagem",
        telefone,
        role: "observacao",
        mensagem: observacao,
        nome: sessoes[telefone]?.nome || ""
      }, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000
      });
    }
  } catch (e) {
    console.error("Erro salvar obs:", e.message);
  }

  res.json({ ok: true });
});

// ============================================================
// PROCESSAMENTO
// ============================================================

async function processarMensagem(telefoneOriginal, mensagem) {
  const telefone = limparTelefone(telefoneOriginal);
  const sessao = garantirSessao(telefone);

  if (estaEmManual(telefone)) {
    console.log("BLOQUEIO INTERNO — CLAUDE NÃO CHAMADO:", telefone);
    return null;
  }

  if (ehSaudacaoSimples(mensagem) && sessao.historico.length <= 1) {
    const candidatoExistente = await buscarCandidatoNaPlanilha(telefone);

    if (candidatoExistente?.encontrado) {
      const nome = candidatoExistente.candidato?.Nome || "";

      const resposta = `Olá${nome ? ", " + primeiroNome(nome) : ""}! 😊

Seu currículo já está cadastrado em nosso Banco de Talentos.

Quando surgir uma oportunidade compatível com seu perfil, entraremos em contato. 💙

Caso queira atualizar alguma informação profissional ou buscar uma vaga específica, estou à disposição.`;

      sessao.historico.push({ role: "assistant", content: resposta });
      sessao.historico = sessao.historico.slice(-20);

      await salvarMensagemSheets(telefone, "assistant", resposta, nome);
      await salvarConversaCompletaSheets(telefone, sessao.historico, nome);

      return resposta;
    }
  }

  if (sessao.aguardandoConfirmacaoInteresse && ehConfirmacaoInteresse(mensagem)) {
    await confirmarInteresseNaPlanilha(telefone, sessao.ultimaAnalise);
    await enviarAlertaInteresseThiara(sessao.ultimaAnalise, telefone);

    sessao.aguardandoConfirmacaoInteresse = false;

    const resposta = `Perfeito, ${sessao.ultimaAnalise?.nome || ""}! 😊

Já registrei seu interesse na oportunidade e sua candidatura seguirá para análise da nossa equipe.

Caso seu perfil avance para a próxima etapa, entraremos em contato pelos canais informados.

Obrigada pelo interesse e boa sorte! 💙`;

    sessao.historico.push({ role: "assistant", content: resposta });
    sessao.historico = sessao.historico.slice(-20);

    await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

    return resposta;
  }

  const vagas = await buscarVagas();
  const prompt = montarPromptConversa(sessao, mensagem, vagas);
  const resposta = await chamarClaudeTexto(prompt);

  sessao.historico.push({ role: "assistant", content: resposta });
  sessao.historico = sessao.historico.slice(-20);

  await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);
  await salvarConversaCompletaSheets(telefone, sessao.historico, sessao.nome);

  return resposta;
}

async function processarCurriculo(telefoneOriginal, documento) {
  const telefone = limparTelefone(telefoneOriginal);

  try {
    if (estaEmManual(telefone)) {
      console.log("CURRÍCULO BLOQUEADO — ATENDIMENTO MANUAL:", telefone);
      return null;
    }

    const textoCurriculo = await baixarELerPdf(documento.id);

    if (!textoCurriculo || textoCurriculo.length < 50) {
      return "Recebi o currículo, mas não consegui ler bem o conteúdo do arquivo. Pode me enviar um PDF mais legível ou me contar sua experiência por aqui?";
    }

    const vagas = await buscarVagas();
    const sessao = garantirSessao(telefone);

    const vagasFiltradas = filtrarVagasRelevantes(vagas, textoCurriculo, sessao.historico).slice(0, 5);
    const prompt = montarPromptAnaliseEstruturada(textoCurriculo, vagasFiltradas);
    const analise = await chamarClaudeJSON(prompt);

    await salvarAnaliseNaPlanilha(telefone, analise);
    await enviarAlertaThiara(analise, telefone);

    sessao.aguardandoConfirmacaoInteresse = true;
    sessao.ultimaAnalise = analise;
    sessao.nome = analise.nome || sessao.nome;

    sessao.historico.push({ role: "assistant", content: analise.mensagemCandidato });
    sessao.historico = sessao.historico.slice(-20);

    await salvarMensagemSheets(telefone, "user", "[Currículo PDF recebido]", analise.nome);
    await salvarMensagemSheets(telefone, "assistant", analise.mensagemCandidato, analise.nome);
    await salvarConversaCompletaSheets(telefone, sessao.historico, analise.nome);

    return analise.mensagemCandidato;
  } catch (erro) {
    console.error("Erro ao processar currículo:", JSON.stringify(erro.response?.data || erro.message));
    return "Recebi seu currículo, mas tive dificuldade para concluir a análise automática agora. Podemos seguir com algumas perguntas rápidas por aqui. Qual foi sua última experiência profissional?";
  }
}

async function baixarELerPdf(mediaId) {
  const mediaInfo = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` },
    timeout: 15000
  });

  const arquivo = await axios.get(mediaInfo.data.url, {
    headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000
  });

  const pdfData = await pdfParse(Buffer.from(arquivo.data));

  return String(pdfData.text || "").slice(0, 12000);
}

async function buscarCandidatoNaPlanilha(telefone) {
  try {
    if (!CONFIG.VAGAS_URL) return null;

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=candidato&telefone=${encodeURIComponent(telefone)}`, {
      timeout: 15000
    });

    return r.data;
  } catch (e) {
    return null;
  }
}

async function buscarVagas() {
  try {
    const vagasSheets = [];

    if (CONFIG.VAGAS_URL) {
      const r = await axios.get(CONFIG.VAGAS_URL, { timeout: 15000 });

      if (r.data?.vagas) {
        vagasSheets.push(...r.data.vagas);
      }
    }

    return [VAGA_DIARIA_LINHARES, ...vagasSheets];
  } catch (e) {
    return [VAGA_DIARIA_LINHARES];
  }
}

function normalizarTexto(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function primeiroNome(nome) {
  return String(nome || "").trim().split(/\s+/)[0];
}

function ehSaudacaoSimples(mensagem) {
  const texto = normalizarTexto(mensagem).trim();

  return [
    "oi",
    "ola",
    "olá",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem",
    "td bem"
  ].includes(texto);
}

function filtrarVagasRelevantes(vagas, texto, historico) {
  const textoBusca = normalizarTexto(
    texto + " " + historico.map(h => h.content).join(" ")
  );

  const vagasComScore = vagas.map(vaga => {
    const textoVaga = normalizarTexto([
      vaga.cargo,
      vaga.area,
      vaga.cidade,
      vaga.perfilResumido,
      vaga.palavrasChave,
      vaga.requisitosDaVaga,
      vaga.requisitoObrigatorio
    ].join(" "));

    let score = 0;

    textoBusca
      .split(/\s+/)
      .filter(p => p.length >= 4)
      .slice(0, 80)
      .forEach(p => {
        if (textoVaga.includes(p)) score++;
      });

    return { vaga, score };
  });

  const filtradas = vagasComScore
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(i => i.vaga);

  return filtradas.length > 0 ? filtradas : vagas.slice(0, 8);
}

function resumirVagas(vagas) {
  return vagas.map(vaga => ({
    idVaga: vaga.idVaga,
    cargo: vaga.cargo,
    cidade: vaga.cidade,
    horario: vaga.horario,
    escala: vaga.escala,
    salario: vaga.salario,
    beneficios: vaga.beneficios,
    escolaridade: vaga.escolaridade,
    experienciaMinima: vaga.experienciaMinima,
    requisitoObrigatorio: vaga.requisitoObrigatorio,
    aceitaSemExperiencia: vaga.aceitaSemExperiencia,
    perfilResumido: vaga.perfilResumido,
    palavrasChave: vaga.palavrasChave,
    observacoes: vaga.observacoes
  }));
}

function montarPromptConversa(sessao, mensagemAtual, vagas) {
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagemAtual, sessao.historico);
  const vagasResumidas = resumirVagas(vagasFiltradas);

  const historicoCurto = sessao.historico
    .slice(-8)
    .map(h => `${h.role}: ${h.content}`)
    .join("\n");

  const textoConversa = normalizarTexto(mensagemAtual + " " + historicoCurto);

  const ehDiaria =
    textoConversa.includes("diaria") ||
    textoConversa.includes("linhares") ||
    textoConversa.includes("shell") ||
    textoConversa.includes("servicos gerais") ||
    textoConversa.includes("limpeza");

  const instrucaoCurriculo = ehDiaria
    ? `REGRA ESPECIAL — VAGA DE DIÁRIA:
- Esta é uma vaga de diária, trabalho por dia.
- NÃO peça currículo.
- Pergunte APENAS se a candidata tem experiência com limpeza/serviços gerais.
- Colete aos poucos: nome, cidade/bairro, experiência com limpeza e disponibilidade para quarta-feira.
- Informe: R$ 250,00 por dia, incluso passagem e alimentação, em Linhares/ES bairro Shell.
- Entrevistas previstas para quarta-feira.
- Após coletar as informações, diga que vai passar o contato para a equipe e que retornarão em breve.`
    : `COLETA PADRÃO:
Colete aos poucos: nome, cidade/bairro, área ou vaga, experiência, escolaridade, disponibilidade e currículo.
Se o currículo já foi recebido, siga com interesse na vaga, disponibilidade, deslocamento ou próximos passos.`;

  return `
Você é a Lia, da Effect Pessoas e Performance.

REGRAS GERAIS:
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Nunca use menu numérico.
- Faça somente uma pergunta por vez.
- Não repita "Eu sou a Lia" se a conversa já começou.
- Seja humana, acolhedora, organizada, profissional e leve.
- Seja simpática, mas sem exageros.
- NÃO diga "que nome lindo", "amei seu nome", "nome bonito" ou qualquer elogio ao nome da pessoa.
- Use o nome do candidato de forma natural e profissional.
- Responda curto, como WhatsApp.
- Se o histórico indicar que o currículo já foi recebido ou analisado, NÃO peça o currículo novamente.

ABERTURA:
Se for o primeiro contato e a pessoa ainda não informou o nome, responda:
"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"

${instrucaoCurriculo}

VAGAS DISPONÍVEIS:
${JSON.stringify(vagasResumidas, null, 2)}

HISTÓRICO RECENTE:
${historicoCurto}

MENSAGEM ATUAL:
${mensagemAtual}

Responda somente a próxima mensagem da Lia.
`;
}

function montarPromptAnaliseEstruturada(textoCurriculo, vagas) {
  const vagasResumidas = resumirVagas(vagas);

  return `
Você é a Lia, da Effect Pessoas e Performance.

Analise o currículo abaixo e compare com as vagas disponíveis.

Responda SOMENTE em JSON válido, sem markdown, sem explicação fora do JSON.

Use exatamente esta estrutura:

{
  "nome": "",
  "cidade": "",
  "areaInteresse": "",
  "vagaInteresse": "",
  "idVaga": "",
  "scoreGeral": 0,
  "scoreVaga": 0,
  "classificacao": "",
  "motivoMatch": "",
  "status": "",
  "requisitoObrigatorio": "",
  "escolaridadeCompativel": "",
  "experienciaCompativel": "",
  "anosExperiencia": "",
  "pontosFortes": "",
  "pontosAtencao": "",
  "analiseIA": "",
  "transporteProprio": "",
  "cltImediato": "",
  "observacoes": "",
  "mensagemCandidato": ""
}

REGRAS DE CLASSIFICAÇÃO:
- 90 a 100: Excelente
- 70 a 89: Bom
- 50 a 69: Regular
- abaixo de 50: Reprovado
- Nunca use Excelente se faltar requisito obrigatório.
- Não prometa contratação.

FORMATO DA mensagemCandidato:
😊 Olá, {NOME}!

Analisei seu currículo e identifiquei uma oportunidade que possui compatibilidade com sua experiência profissional.

📍 {CARGO}
📍 {CIDADE}

Os principais pontos observados foram:

• {PONTO FORTE 1}
• {PONTO FORTE 2}
• {PONTO FORTE 3}

Você teria interesse em participar deste processo seletivo?

Fico à disposição. 💙

REGRAS:
- Não mostrar score.
- Não mostrar classificação.
- Não falar em IA ou análise automática.
- Não elogiar o nome.
- Não usar textos longos.
- Não prometer contratação.

VAGAS:
${JSON.stringify(vagasResumidas, null, 2)}

CURRÍCULO:
${textoCurriculo}
`;
}

async function chamarClaudeTexto(prompt) {
  return await chamarClaude(prompt);
}

async function chamarClaudeJSON(prompt) {
  const texto = await chamarClaude(prompt);

  try {
    return JSON.parse(texto);
  } catch (e) {
    const match = texto.match(/\{[\s\S]*\}/);

    if (match) {
      return JSON.parse(match[0]);
    }

    throw new Error("Claude não retornou JSON válido: " + texto);
  }
}

async function chamarClaude(prompt) {
  try {
    if (!CONFIG.CLAUDE_API_KEY) {
      return "Tive uma instabilidade aqui. Pode me mandar novamente?";
    }

    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: {
        "x-api-key": CONFIG.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      timeout: 30000
    });

    return response.data?.content?.[0]?.text || "Tive uma instabilidade aqui. Pode me mandar novamente?";
  } catch (erro) {
    const msg = JSON.stringify(erro.response?.data || erro.message);

    if (msg.includes("rate_limit")) {
      return "Estou processando suas informações, só preciso de um instantinho. Pode me responder novamente em alguns segundos?";
    }

    return "Tive uma instabilidade aqui. Pode me mandar novamente?";
  }
}

async function salvarAnaliseNaPlanilha(telefone, analise) {
  try {
    if (!CONFIG.VAGAS_URL) return;

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];

    await axios.post(urlBase, {
      acao: "salvarAnalise",
      telefone,
      nome: analise.nome || "",
      cidade: analise.cidade || "",
      areaInteresse: analise.areaInteresse || "",
      vagaInteresse: analise.vagaInteresse || "",
      idVaga: analise.idVaga || "",
      scoreGeral: analise.scoreGeral || "",
      scoreVaga: analise.scoreVaga || "",
      classificacao: analise.classificacao || "",
      motivoMatch: analise.motivoMatch || "",
      status: analise.status || "Analisado pela Lia",
      requisitoObrigatorio: analise.requisitoObrigatorio || "",
      escolaridadeCompativel: analise.escolaridadeCompativel || "",
      experienciaCompativel: analise.experienciaCompativel || "",
      anosExperiencia: analise.anosExperiencia || "",
      pontosFortes: analise.pontosFortes || "",
      pontosAtencao: analise.pontosAtencao || "",
      analiseIA: analise.analiseIA || "",
      transporteProprio: analise.transporteProprio || "",
      cltImediato: analise.cltImediato || "",
      observacoes: analise.observacoes || ""
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000
    });
  } catch (e) {
    console.error("Erro ao salvar análise:", e.message);
  }
}

async function confirmarInteresseNaPlanilha(telefone, analise) {
  try {
    if (!CONFIG.VAGAS_URL) return;

    const urlBase = CONFIG.VAGAS_URL.split("?")[0];

    await axios.post(urlBase, {
      acao: "confirmarInteresse",
      telefone,
      vagaInteresse: analise?.vagaInteresse || "",
      idVaga: analise?.idVaga || ""
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000
    });
  } catch (e) {
    console.error("Erro ao confirmar interesse:", e.message);
  }
}

function ehConfirmacaoInteresse(mensagem) {
  const texto = normalizarTexto(mensagem);

  return [
    "sim",
    "tenho interesse",
    "quero",
    "quero participar",
    "aceito",
    "tenho sim",
    "pode ser",
    "tenho disponibilidade",
    "tenho",
    "ok"
  ].some(p => texto === p || texto.includes(p));
}

async function enviarAlertaThiara(analise, telefone) {
  try {
    const score = Number(analise.scoreVaga || analise.scoreGeral || 0);
    const classificacao = String(analise.classificacao || "").toLowerCase();

    if (score < 80 && !classificacao.includes("excelente")) return;

    const texto = `🚨 NOVO MATCH IDENTIFICADO

👤 ${analise.nome || "Não identificado"}

📌 Vaga:
${analise.vagaInteresse || "Não identificada"}

📍 Cidade:
${analise.cidade || "Não informada"}

⭐ Score: ${analise.scoreVaga || analise.scoreGeral || "Não informado"}
🏅 Classificação: ${analise.classificacao || "Não informada"}

💼 Pontos fortes:
${formatarLista(analise.pontosFortes)}

📱 WhatsApp:
+${telefone}`;

    await enviarMensagem(CONFIG.THIARA_WHATSAPP, texto);
  } catch (e) {
    console.error("Erro alerta Thiara:", e.message);
  }
}

async function enviarAlertaInteresseThiara(analise, telefone) {
  try {
    const texto = `✅ CANDIDATO CONFIRMOU INTERESSE

👤 ${analise?.nome || "Não identificado"}

📌 Vaga:
${analise?.vagaInteresse || "Não identificada"}

📍 Cidade:
${analise?.cidade || "Não informada"}

⭐ Score: ${analise?.scoreVaga || analise?.scoreGeral || "Não informado"}
🏅 Classificação: ${analise?.classificacao || "Não informada"}

📱 WhatsApp:
+${telefone}

✅ O candidato confirmou interesse na oportunidade.`;

    await enviarMensagem(CONFIG.THIARA_WHATSAPP, texto);
  } catch (e) {
    console.error("Erro alerta interesse:", e.message);
  }
}

function formatarLista(texto) {
  if (!texto) return "Não informado";

  const partes = String(texto)
    .split(/;|,|\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .slice(0, 5);

  return partes.length === 0 ? texto : partes.map(p => `• ${p}`).join("\n");
}

async function enviarMensagem(toOriginal, body) {
  const to = limparTelefone(toOriginal);

  try {
    if (!CONFIG.META_ACCESS_TOKEN || !CONFIG.PHONE_NUMBER_ID) return;

    await axios.post(`https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        preview_url: false,
        body
      }
    }, {
      headers: {
        Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    });
  } catch (e) {
    console.error("Erro ao enviar WhatsApp:", JSON.stringify(e.response?.data || e.message));
  }
}

app.listen(PORT, () => {
  console.log(`Lia rodando na porta ${PORT} — trava manual reforçada ✅`);
});
