const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

const CONFIG = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "effect_lia_2026",
  VAGAS_URL: process.env.VAGAS_URL
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
    const text = message.text?.body || "";

    if (!text) {
      await enviarMensagem(from, "Recebi sua mensagem, mas por enquanto consigo analisar melhor mensagens em texto. Pode me escrever por aqui?");
      return;
    }

    const resposta = await processarMensagem(from, text);
    await enviarMensagem(from, resposta);

  } catch (erro) {
    console.error("Erro no webhook:", JSON.stringify(erro.response?.data || erro.message));
  }
});

async function processarMensagem(telefone, mensagem) {
  if (!sessoes[telefone]) {
    sessoes[telefone] = { historico: [] };
  }

  const sessao = sessoes[telefone];

  sessao.historico.push({
    role: "user",
    content: mensagem
  });

  // Mantém só as últimas 10 mensagens para não estourar limite de tokens
  sessao.historico = sessao.historico.slice(-10);

  const vagas = await buscarVagas();
  const prompt = montarPrompt(sessao, mensagem, vagas);
  const resposta = await chamarClaude(prompt);

  sessao.historico.push({
    role: "assistant",
    content: resposta
  });

  sessao.historico = sessao.historico.slice(-10);

  return resposta;
}

async function buscarVagas() {
  try {
    if (!CONFIG.VAGAS_URL) {
      console.error("Erro Vagas: VAGAS_URL ausente");
      return [];
    }

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

function filtrarVagasRelevantes(vagas, mensagemAtual, historico) {
  const textoBusca = normalizarTexto(
    mensagemAtual + " " + historico.map(h => h.content).join(" ")
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

    const palavras = textoBusca.split(/\s+/).filter(p => p.length >= 4);

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

function montarPrompt(sessao, mensagemAtual, vagas) {
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagemAtual, sessao.historico);

  const vagasResumidas = vagasFiltradas.map(vaga => ({
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
- Responda curto, como WhatsApp.

ABERTURA:
Se for o primeiro contato e a pessoa ainda não informou o nome, responda:
"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"

COLETA DE CANDIDATO:
Colete aos poucos:
Nome, cidade/bairro, área ou vaga de interesse, experiência, escolaridade, disponibilidade e currículo.

VAGAS RELEVANTES:
${JSON.stringify(vagasResumidas, null, 2)}

MATCH:
- Nunca classifique como excelente se faltar experiência ou requisito obrigatório.
- Se a vaga exigir requisito obrigatório e a pessoa não tiver, diga que precisa avaliar melhor.
- Se a vaga aceitar sem experiência, pode considerar perfil iniciante.
- Não prometa contratação.
- Use: "seu perfil pode ter aderência inicial" ou "vou sinalizar seu interesse para análise da equipe."

HISTÓRICO RECENTE:
${historicoCurto}

MENSAGEM ATUAL:
${mensagemAtual}

Responda somente a próxima mensagem da Lia.
`;
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
        max_tokens: 400,
        temperature: 0.4,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
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

async function enviarMensagem(to, body) {
  try {
    if (!CONFIG.META_ACCESS_TOKEN) {
      console.error("Erro Meta: META_ACCESS_TOKEN ausente");
      return;
    }

    if (!CONFIG.PHONE_NUMBER_ID) {
      console.error("Erro Meta: PHONE_NUMBER_ID ausente");
      return;
    }

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
  console.log(`Lia rodando na porta ${PORT} - versão otimizada sem estouro de tokens`);
});
