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

// ============================================================
// HELPERS SHEETS
// ============================================================

async function salvarMensagemSheets(telefone, role, mensagem, nome) {
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, {
      acao: "salvarMensagem",
      telefone,
      role,
      mensagem,
      nome: nome || ""
    }, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
  } catch (e) {
    console.error("Erro salvarMensagemSheets:", e.message);
  }
}

async function carregarSessoesDoSheets() {
  try {
    if (!CONFIG.VAGAS_URL) return;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const url = `${urlBase}?acao=conversas`;
    const r = await axios.get(url, { timeout: 15000 });
    const data = r.data;
    if (!data.sucesso || !data.sessoes) return;

    Object.entries(data.sessoes).forEach(([tel, sessao]) => {
      if (!sessoes[tel]) {
        sessoes[tel] = {
          historico: sessao.historico.map(h => ({ role: h.role, content: h.content })),
          nome: sessao.nome || null
        };
      }
    });
    console.log(`Sessões carregadas do Sheets: ${Object.keys(data.sessoes).length}`);
  } catch (e) {
    console.error("Erro carregarSessoesDoSheets:", e.message);
  }
}

// Carregar sessões ao iniciar
carregarSessoesDoSheets();

// ============================================================
// ROTAS PRINCIPAIS
// ============================================================

app.get("/", (req, res) => {
  res.send("Lia Effect rodando com travas anti-mensagem duplicada ✅");
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
    if (message.id) {
      mensagensProcessadas.add(message.id);
      if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear();
    }
    if (!message.text?.body && !message.document) return;

    const from = message.from;

    if (message.text?.body) {
      const resposta = await processarMensagem(from, message.text.body);
      await enviarMensagem(from, resposta);
      return;
    }

    if (message.document) {
      await enviarMensagem(from, "Perfeito, recebi seu currículo. Vou analisar as informações agora. 💙");
      const resposta = await processarCurriculo(from, message.document);
      await enviarMensagem(from, resposta);
      return;
    }
  } catch (erro) {
    console.error("Erro no webhook:", JSON.stringify(erro.response?.data || erro.message));
  }
});

// ============================================================
// ROTAS DO INBOX
// ============================================================

app.get("/inbox", (req, res) => {
  res.sendFile(path.join(__dirname, "inbox.html"));
});

app.get("/inbox/sessoes", (req, res) => {
  try {
    const dados = {};
    Object.entries(sessoes).forEach(([tel, sessao]) => {
      dados[tel] = {
        historico: sessao.historico || [],
        nome: sessao.nome || null,
        aguardandoConfirmacaoInteresse: sessao.aguardandoConfirmacaoInteresse || false,
        ultimaAnalise: sessao.ultimaAnalise || null
      };
    });
    res.json({ sessoes: dados, total: Object.keys(dados).length });
  } catch (erro) {
    res.json({ sessoes: {}, total: 0 });
  }
});

app.post("/inbox/enviar", async (req, res) => {
  try {
    const { telefone, mensagem, modo } = req.body;
    if (!telefone || !mensagem) return res.json({ ok: false, erro: "Dados incompletos" });

    if (modo === "manual") {
      await enviarMensagem(telefone, mensagem);
      if (!sessoes[telefone]) sessoes[telefone] = { historico: [] };
      sessoes[telefone].historico.push({ role: "assistant", content: mensagem });
      sessoes[telefone].historico = sessoes[telefone].historico.slice(-20);
      await salvarMensagemSheets(telefone, "assistant", mensagem, sessoes[telefone].nome);
      return res.json({ ok: true, modo: "manual" });
    } else {
      const resposta = await processarMensagem(telefone, mensagem);
      await enviarMensagem(telefone, resposta);
      return res.json({ ok: true, modo: "lia", resposta });
    }
  } catch (erro) {
    console.error("Erro inbox/enviar:", erro.message);
    res.json({ ok: false, erro: erro.message });
  }
});

// ============================================================
// PROCESSAMENTO
// ============================================================

async function processarMensagem(telefone, mensagem) {
  if (!sessoes[telefone]) sessoes[telefone] = { historico: [] };
  const sessao = sessoes[telefone];

  // Salvar mensagem do candidato no Sheets
  await salvarMensagemSheets(telefone, "user", mensagem, sessao.nome);

  if (ehSaudacaoSimples(mensagem) && sessao.historico.length === 0) {
    const candidatoExistente = await buscarCandidatoNaPlanilha(telefone);
    if (candidatoExistente?.encontrado) {
      const nome = candidatoExistente.candidato?.Nome || "";
      sessao.historico.push({ role: "user", content: mensagem });
      sessao.historico.push({ role: "assistant", content: "Candidato já cadastrado." });
      const resposta = `Olá${nome ? ", " + primeiroNome(nome) : ""}! 😊\n\nSeu currículo já está cadastrado em nosso Banco de Talentos.\n\nQuando surgir uma oportunidade compatível com seu perfil, entraremos em contato. 💙\n\nCaso queira atualizar alguma informação profissional ou buscar uma vaga específica, estou à disposição.`;
      await salvarMensagemSheets(telefone, "assistant", resposta, nome);
      return resposta;
    }
  }

  if (sessao.aguardandoConfirmacaoInteresse && ehConfirmacaoInteresse(mensagem)) {
    await confirmarInteresseNaPlanilha(telefone, sessao.ultimaAnalise);
    await enviarAlertaInteresseThiara(sessao.ultimaAnalise, telefone);
    sessao.aguardandoConfirmacaoInteresse = false;
    sessao.historico.push({ role: "user", content: mensagem });
    sessao.historico.push({ role: "assistant", content: "Interesse confirmado e registrado." });
    sessao.historico = sessao.historico.slice(-10);
    const resposta = `Perfeito, ${sessao.ultimaAnalise?.nome || ""}! 😊\n\nJá registrei seu interesse na oportunidade e sua candidatura seguirá para análise da nossa equipe.\n\nCaso seu perfil avance para a próxima etapa, entraremos em contato pelos canais informados.\n\nObrigada pelo interesse e boa sorte! 💙`;
    await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);
    return resposta;
  }

  sessao.historico.push({ role: "user", content: mensagem });
  sessao.historico = sessao.historico.slice(-10);

  const vagas = await buscarVagas();
  const prompt = montarPromptConversa(sessao, mensagem, vagas);
  const resposta = await chamarClaudeTexto(prompt);

  sessao.historico.push({ role: "assistant", content: resposta });
  sessao.historico = sessao.historico.slice(-10);

  // Salvar resposta da Lia no Sheets
  await salvarMensagemSheets(telefone, "assistant", resposta, sessao.nome);

  return resposta;
}

async function processarCurriculo(telefone, documento) {
  try {
    const textoCurriculo = await baixarELerPdf(documento.id);
    if (!textoCurriculo || textoCurriculo.length < 50) {
      return "Recebi o currículo, mas não consegui ler bem o conteúdo do arquivo. Pode me enviar um PDF mais legível ou me contar sua experiência por aqui?";
    }

    const vagas = await buscarVagas();
    const sessao = sessoes[telefone] || { historico: [] };
    const vagasFiltradas = filtrarVagasRelevantes(vagas, textoCurriculo, sessao.historico).slice(0, 5);
    const prompt = montarPromptAnaliseEstruturada(textoCurriculo, vagasFiltradas);
    const analise = await chamarClaudeJSON(prompt);

    await salvarAnaliseNaPlanilha(telefone, analise);
    await enviarAlertaThiara(analise, telefone);

    if (!sessoes[telefone]) sessoes[telefone] = { historico: [] };
    sessoes[telefone].aguardandoConfirmacaoInteresse = true;
    sessoes[telefone].ultimaAnalise = analise;
    sessoes[telefone].nome = analise.nome || sessoes[telefone].nome;

    sessoes[telefone].historico.push({ role: "user", content: "[Currículo PDF recebido e analisado]" });
    sessoes[telefone].historico.push({ role: "assistant", content: analise.mensagemCandidato });
    sessoes[telefone].historico = sessoes[telefone].historico.slice(-10);

    await salvarMensagemSheets(telefone, "user", "[Currículo PDF recebido]", analise.nome);
    await salvarMensagemSheets(telefone, "assistant", analise.mensagemCandidato, analise.nome);

    return analise.mensagemCandidato;
  } catch (erro) {
    console.error("Erro ao processar currículo:", JSON.stringify(erro.response?.data || erro.message));
    return "Recebi seu currículo, mas tive dificuldade para concluir a análise automática agora. Podemos seguir com algumas perguntas rápidas por aqui. Qual foi sua última experiência profissional?";
  }
}

async function baixarELerPdf(mediaId) {
  const mediaInfo = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` }, timeout: 15000
  });
  const arquivo = await axios.get(mediaInfo.data.url, {
    headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` },
    responseType: "arraybuffer", timeout: 30000
  });
  const pdfData = await pdfParse(Buffer.from(arquivo.data));
  return String(pdfData.text || "").slice(0, 12000);
}

async function buscarCandidatoNaPlanilha(telefone) {
  try {
    if (!CONFIG.VAGAS_URL) return null;
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    const r = await axios.get(`${urlBase}?acao=candidato&telefone=${encodeURIComponent(telefone)}`, { timeout: 15000 });
    return r.data;
  } catch (e) { return null; }
}

async function buscarVagas() {
  try {
    if (!CONFIG.VAGAS_URL) return [];
    const r = await axios.get(CONFIG.VAGAS_URL, { timeout: 15000 });
    return r.data?.vagas || [];
  } catch (e) { return []; }
}

function normalizarTexto(texto) {
  return String(texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function primeiroNome(nome) {
  return String(nome || "").trim().split(/\s+/)[0];
}

function ehSaudacaoSimples(mensagem) {
  const texto = normalizarTexto(mensagem).trim();
  return ["oi","ola","olá","bom dia","boa tarde","boa noite","tudo bem","td bem"].includes(texto);
}

function filtrarVagasRelevantes(vagas, texto, historico) {
  const textoBusca = normalizarTexto(texto + " " + historico.map(h => h.content).join(" "));
  const vagasComScore = vagas.map(vaga => {
    const textoVaga = normalizarTexto([vaga.cargo, vaga.area, vaga.cidade, vaga.perfilResumido, vaga.palavrasChave, vaga.requisitosDaVaga, vaga.requisitoObrigatorio].join(" "));
    let score = 0;
    textoBusca.split(/\s+/).filter(p => p.length >= 4).slice(0, 80).forEach(p => { if (textoVaga.includes(p)) score++; });
    return { vaga, score };
  });
  const filtradas = vagasComScore.filter(i => i.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(i => i.vaga);
  return filtradas.length > 0 ? filtradas : vagas.slice(0, 8);
}

function resumirVagas(vagas) {
  return vagas.map(vaga => ({
    idVaga: vaga.idVaga, cargo: vaga.cargo, cidade: vaga.cidade, horario: vaga.horario,
    beneficios: vaga.beneficios, escolaridade: vaga.escolaridade, experienciaMinima: vaga.experienciaMinima,
    requisitoObrigatorio: vaga.requisitoObrigatorio, aceitaSemExperiencia: vaga.aceitaSemExperiencia,
    perfilResumido: vaga.perfilResumido, palavrasChave: vaga.palavrasChave
  }));
}

function montarPromptConversa(sessao, mensagemAtual, vagas) {
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagemAtual, sessao.historico);
  const vagasResumidas = resumirVagas(vagasFiltradas);
  const historicoCurto = sessao.historico.slice(-8).map(h => `${h.role}: ${h.content}`).join("\n");

  return `
Você é a Lia, da Effect Pessoas e Performance.

REGRAS:
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Nunca use menu numérico.
- Faça somente uma pergunta por vez.
- Não repita "Eu sou a Lia" se a conversa já começou.
- Seja humana, acolhedora, organizada, profissional e leve.
- Seja simpática, mas sem exageros.
- NÃO diga "que nome lindo", "amei seu nome", "nome bonito" ou qualquer elogio ao nome da pessoa.
- Use o nome do candidato de forma natural e profissional.
- Prefira frases como: "Prazer em falar com você, [nome].", "Perfeito, [nome]." ou "Obrigada pelas informações, [nome]."
- Responda curto, como WhatsApp.
- Se o histórico indicar que o currículo já foi recebido ou analisado, NÃO peça o currículo novamente.
- Se o candidato acabou de confirmar interesse em uma vaga, não volte a perguntar dados básicos.

ABERTURA:
Se for o primeiro contato e a pessoa ainda não informou o nome, responda:
"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"

COLETA:
Colete aos poucos: nome, cidade/bairro, área ou vaga, experiência, escolaridade, disponibilidade e currículo.
Se o currículo já foi recebido, siga com interesse na vaga, disponibilidade, deslocamento ou próximos passos.

VAGAS RELEVANTES:
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

REGRAS DA mensagemCandidato:
- Não mostrar score.
- Não mostrar classificação.
- Não falar em IA ou análise automática.
- Não elogiar o nome.
- Não usar textos longos.
- Sempre quebrar em parágrafos.
- Sempre utilizar marcadores com "•" nos pontos fortes.
- Não prometer contratação.

VAGAS:
${JSON.stringify(vagasResumidas, null, 2)}

CURRÍCULO:
${textoCurriculo}
`;
}

async function chamarClaudeTexto(prompt) { return await chamarClaude(prompt); }

async function chamarClaudeJSON(prompt) {
  const texto = await chamarClaude(prompt);
  try { return JSON.parse(texto); } catch (e) {
    const match = texto.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Claude não retornou JSON válido: " + texto);
  }
}

async function chamarClaude(prompt) {
  try {
    if (!CONFIG.CLAUDE_API_KEY) return "Tive uma instabilidade aqui. Pode me mandar novamente?";
    const response = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: { "x-api-key": CONFIG.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 30000
    });
    return response.data?.content?.[0]?.text || "Tive uma instabilidade aqui. Pode me mandar novamente?";
  } catch (erro) {
    const msg = JSON.stringify(erro.response?.data || erro.message);
    if (msg.includes("rate_limit")) return "Estou processando suas informações, só preciso de um instantinho. Pode me responder novamente em alguns segundos?";
    return "Tive uma instabilidade aqui. Pode me mandar novamente?";
  }
}

async function salvarAnaliseNaPlanilha(telefone, analise) {
  try {
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, {
      acao: "salvarAnalise", telefone,
      nome: analise.nome || "", cidade: analise.cidade || "",
      areaInteresse: analise.areaInteresse || "", vagaInteresse: analise.vagaInteresse || "",
      idVaga: analise.idVaga || "", scoreGeral: analise.scoreGeral || "",
      scoreVaga: analise.scoreVaga || "", classificacao: analise.classificacao || "",
      motivoMatch: analise.motivoMatch || "", status: analise.status || "Analisado pela Lia",
      requisitoObrigatorio: analise.requisitoObrigatorio || "",
      escolaridadeCompativel: analise.escolaridadeCompativel || "",
      experienciaCompativel: analise.experienciaCompativel || "",
      anosExperiencia: analise.anosExperiencia || "", pontosFortes: analise.pontosFortes || "",
      pontosAtencao: analise.pontosAtencao || "", analiseIA: analise.analiseIA || "",
      transporteProprio: analise.transporteProprio || "", cltImediato: analise.cltImediato || "",
      observacoes: analise.observacoes || ""
    }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
  } catch (e) { console.error("Erro ao salvar análise:", e.message); }
}

async function confirmarInteresseNaPlanilha(telefone, analise) {
  try {
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];
    await axios.post(urlBase, {
      acao: "confirmarInteresse", telefone,
      vagaInteresse: analise?.vagaInteresse || "", idVaga: analise?.idVaga || ""
    }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
  } catch (e) { console.error("Erro ao confirmar interesse:", e.message); }
}

function ehConfirmacaoInteresse(mensagem) {
  const texto = normalizarTexto(mensagem);
  return ["sim","tenho interesse","quero","quero participar","aceito","tenho sim","pode ser","tenho disponibilidade","tenho","ok"]
    .some(p => texto === p || texto.includes(p));
}

async function enviarAlertaThiara(analise, telefone) {
  try {
    const score = Number(analise.scoreVaga || analise.scoreGeral || 0);
    const classificacao = String(analise.classificacao || "").toLowerCase();
    if (score < 80 && !classificacao.includes("excelente")) return;
    const texto = `🚨 NOVO MATCH IDENTIFICADO\n\n👤 ${analise.nome || "Não identificado"}\n\n📌 Vaga:\n${analise.vagaInteresse || "Não identificada"}\n\n📍 Cidade:\n${analise.cidade || "Não informada"}\n\n⭐ Score: ${analise.scoreVaga || analise.scoreGeral || "Não informado"}\n🏅 Classificação: ${analise.classificacao || "Não informada"}\n\n💼 Pontos fortes:\n${formatarLista(analise.pontosFortes)}\n\n📱 WhatsApp:\n+${telefone}`;
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

async function enviarMensagem(to, body) {
  try {
    if (!CONFIG.META_ACCESS_TOKEN || !CONFIG.PHONE_NUMBER_ID) return;
    await axios.post(`https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "text",
      text: { preview_url: false, body }
    }, {
      headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      timeout: 15000
    });
  } catch (e) { console.error("Erro ao enviar WhatsApp:", JSON.stringify(e.response?.data || e.message)); }
}

app.listen(PORT, () => {
  console.log(`Lia rodando na porta ${PORT} - travas anti-mensagem duplicada`);
});
