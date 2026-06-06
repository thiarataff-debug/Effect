const express = require("express");
const axios = require("axios");
const pdfParse = require("pdf-parse");

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

app.get("/", (req, res) => {
  res.send("Lia Effect rodando com Meta WhatsApp ✅");
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

    await enviarMensagem(from, "Recebi sua mensagem. Pode me enviar em texto ou encaminhar o currículo em PDF por aqui?");
  } catch (erro) {
    console.error("Erro no webhook:", JSON.stringify(erro.response?.data || erro.message));
  }
});

async function processarMensagem(telefone, mensagem) {
  if (!sessoes[telefone]) sessoes[telefone] = { historico: [] };

  const sessao = sessoes[telefone];

  if (sessao.aguardandoConfirmacaoInteresse && ehConfirmacaoInteresse(mensagem)) {
    await confirmarInteresseNaPlanilha(telefone, sessao.ultimaAnalise);
    await enviarAlertaInteresseThiara(sessao.ultimaAnalise, telefone);

    sessao.aguardandoConfirmacaoInteresse = false;

    sessao.historico.push({ role: "user", content: mensagem });
    sessao.historico.push({
      role: "assistant",
      content: "Interesse confirmado e registrado."
    });
    sessao.historico = sessao.historico.slice(-10);

    return `Perfeito, ${sessao.ultimaAnalise?.nome || ""}! 😊

Já registrei seu interesse na oportunidade e sua candidatura seguirá para análise da nossa equipe.

Caso seu perfil avance para a próxima etapa, entraremos em contato pelos canais informados.

Obrigada pelo interesse e boa sorte! 💙`;
  }

  sessao.historico.push({ role: "user", content: mensagem });
  sessao.historico = sessao.historico.slice(-10);

  const vagas = await buscarVagas();
  const prompt = montarPromptConversa(sessao, mensagem, vagas);
  const resposta = await chamarClaudeTexto(prompt);

  sessao.historico.push({ role: "assistant", content: resposta });
  sessao.historico = sessao.historico.slice(-10);

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

    sessoes[telefone].historico.push({ role: "user", content: "[Currículo PDF recebido e analisado]" });
    sessoes[telefone].historico.push({ role: "assistant", content: analise.mensagemCandidato });
    sessoes[telefone].historico = sessoes[telefone].historico.slice(-10);

    return analise.mensagemCandidato;

  } catch (erro) {
    console.error("Erro ao processar currículo:", JSON.stringify(erro.response?.data || erro.message));
    return "Recebi seu currículo, mas tive dificuldade para concluir a análise automática agora. Podemos seguir com algumas perguntas rápidas por aqui. Qual foi sua última experiência profissional?";
  }
}

async function baixarELerPdf(mediaId) {
  const mediaInfo = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` },
      timeout: 15000
    }
  );

  const mediaUrl = mediaInfo.data.url;

  const arquivo = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}` },
    responseType: "arraybuffer",
    timeout: 30000
  });

  const buffer = Buffer.from(arquivo.data);
  const pdfData = await pdfParse(buffer);

  return String(pdfData.text || "").slice(0, 12000);
}

async function buscarVagas() {
  try {
    if (!CONFIG.VAGAS_URL) return [];

    const response = await axios.get(CONFIG.VAGAS_URL, { timeout: 15000 });
    return response.data?.vagas || [];
  } catch (erro) {
    console.error("Erro ao buscar vagas:", JSON.stringify(erro.response?.data || erro.message));
    return [];
  }
}

function normalizarTexto(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function filtrarVagasRelevantes(vagas, texto, historico) {
  const textoBusca = normalizarTexto(texto + " " + historico.map(h => h.content).join(" "));

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
    const palavras = textoBusca.split(/\s+/).filter(p => p.length >= 4).slice(0, 80);

    palavras.forEach(palavra => {
      if (textoVaga.includes(palavra)) score++;
    });

    return { vaga, score };
  });

  const filtradas = vagasComScore
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(item => item.vaga);

  return filtradas.length > 0 ? filtradas : vagas.slice(0, 8);
}

function resumirVagas(vagas) {
  return vagas.map(vaga => ({
    idVaga: vaga.idVaga,
    cargo: vaga.cargo,
    cidade: vaga.cidade,
    horario: vaga.horario,
    beneficios: vaga.beneficios,
    escolaridade: vaga.escolaridade,
    experienciaMinima: vaga.experienciaMinima,
    requisitoObrigatorio: vaga.requisitoObrigatorio,
    aceitaSemExperiencia: vaga.aceitaSemExperiencia,
    perfilResumido: vaga.perfilResumido,
    palavrasChave: vaga.palavrasChave
  }));
}

function montarPromptConversa(sessao, mensagemAtual, vagas) {
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagemAtual, sessao.historico);
  const vagasResumidas = resumirVagas(vagasFiltradas);

  const historicoCurto = sessao.historico
    .slice(-8)
    .map(h => `${h.role}: ${h.content}`)
    .join("\n");

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
A mensagemCandidato deve seguir este modelo, com quebras de linha:

😊 Olá, {NOME}!

Analisei seu currículo e encontrei uma oportunidade que pode fazer sentido para sua experiência profissional.

📍 {CARGO}
📍 {CIDADE}

Seu histórico com:

• {PONTO FORTE 1}
• {PONTO FORTE 2}
• {PONTO FORTE 3}

apresentou compatibilidade com o perfil que estamos buscando.

Você teria interesse em participar deste processo seletivo?

Fico à disposição. 💙

REGRAS DA mensagemCandidato:
- Não mostrar score.
- Não mostrar classificação.
- Não falar em IA ou análise automática.
- Não elogiar o nome.
- Não usar "que nome lindo", "amei seu nome" ou semelhantes.
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

async function chamarClaudeTexto(prompt) {
  return await chamarClaude(prompt);
}

async function chamarClaudeJSON(prompt) {
  const texto = await chamarClaude(prompt);

  try {
    return JSON.parse(texto);
  } catch (erro) {
    const match = texto.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);

    throw new Error("Claude não retornou JSON válido: " + texto);
  }
}

async function chamarClaude(prompt) {
  try {
    if (!CONFIG.CLAUDE_API_KEY) {
      console.error("Erro Claude: CLAUDE_API_KEY ausente");
      return "Tive uma instabilidade aqui. Pode me mandar novamente?";
    }

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1800,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          "x-api-key": CONFIG.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 30000
      }
    );

    return response.data?.content?.[0]?.text || "Tive uma instabilidade aqui. Pode me mandar novamente?";
  } catch (erro) {
    console.error("Erro Claude:", JSON.stringify(erro.response?.data || erro.message));

    const mensagemErro = JSON.stringify(erro.response?.data || erro.message);

    if (mensagemErro.includes("rate_limit")) {
      return "Estou processando suas informações, só preciso de um instantinho. Pode me responder novamente em alguns segundos?";
    }

    return "Tive uma instabilidade aqui. Pode me mandar novamente?";
  }
}

async function salvarAnaliseNaPlanilha(telefone, analise) {
  try {
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];

    const payload = {
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
    };

    const response = await axios.post(urlBase, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000
    });

    console.log("Análise salva:", JSON.stringify(response.data));
  } catch (erro) {
    console.error("Erro ao salvar análise:", JSON.stringify(erro.response?.data || erro.message));
  }
}

async function confirmarInteresseNaPlanilha(telefone, analise) {
  try {
    const urlBase = CONFIG.VAGAS_URL.split("?")[0];

    const payload = {
      acao: "confirmarInteresse",
      telefone,
      vagaInteresse: analise?.vagaInteresse || "",
      idVaga: analise?.idVaga || ""
    };

    const response = await axios.post(urlBase, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 20000
    });

    console.log("Interesse confirmado:", JSON.stringify(response.data));
  } catch (erro) {
    console.error("Erro ao confirmar interesse:", JSON.stringify(erro.response?.data || erro.message));
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
  ].some(palavra => texto === palavra || texto.includes(palavra));
}

async function enviarAlertaThiara(analise, telefone) {
  try {
    const score = Number(analise.scoreVaga || analise.scoreGeral || 0);
    const classificacao = String(analise.classificacao || "").toLowerCase();

    if (score < 80 && !classificacao.includes("excelente")) {
      return;
    }

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
    console.log("Alerta enviado para Thiara");
  } catch (erro) {
    console.error("Erro ao enviar alerta para Thiara:", JSON.stringify(erro.response?.data || erro.message));
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
    console.log("Alerta de interesse enviado para Thiara");
  } catch (erro) {
    console.error("Erro ao enviar alerta de interesse:", JSON.stringify(erro.response?.data || erro.message));
  }
}

function formatarLista(texto) {
  if (!texto) return "Não informado";

  const partes = String(texto)
    .split(/;|,|\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (partes.length === 0) return texto;

  return partes.map(p => `• ${p}`).join("\n");
}

async function enviarMensagem(to, body) {
  try {
    if (!CONFIG.META_ACCESS_TOKEN || !CONFIG.PHONE_NUMBER_ID) return;

    await axios.post(
      `https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          preview_url: false,
          body
        }
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
  } catch (erro) {
    console.error("Erro ao enviar WhatsApp:", JSON.stringify(erro.response?.data || erro.message));
  }
}

app.listen(PORT, () => {
  console.log(`Lia rodando na porta ${PORT} - mensagem formatada e interesse ativo`);
});
