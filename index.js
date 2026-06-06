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
      await enviarMensagem(
        from,
        "Recebi sua mensagem, mas por enquanto consigo analisar melhor mensagens em texto. Pode me escrever por aqui?"
      );
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
    sessoes[telefone] = {
      historico: []
    };
  }

  const sessao = sessoes[telefone];

  sessao.historico.push({
    role: "user",
    content: mensagem
  });

  const vagas = await buscarVagas();
  const prompt = montarPrompt(sessao, mensagem, vagas);
  const resposta = await chamarClaude(prompt);

  sessao.historico.push({
    role: "assistant",
    content: resposta
  });

  return resposta;
}

async function buscarVagas() {
  try {
    if (!CONFIG.VAGAS_URL) {
      console.error("Erro Vagas: VAGAS_URL ausente");
      return [];
    }

    const response = await axios.get(CONFIG.VAGAS_URL, {
      timeout: 15000
    });

    return response.data?.vagas || [];
  } catch (erro) {
    console.error("Erro ao buscar vagas:", JSON.stringify(erro.response?.data || erro.message));
    return [];
  }
}

function montarPrompt(sessao, mensagemAtual, vagas) {
  const vagasResumidas = vagas.map(vaga => ({
    idVaga: vaga.idVaga,
    cargo: vaga.cargo,
    area: vaga.area,
    cliente: vaga.cliente,
    cidade: vaga.cidade,
    salario: vaga.salario,
    horario: vaga.horario,
    beneficios: vaga.beneficios,
    genero: vaga.genero,
    faixaEtaria: vaga.faixaEtaria,
    escolaridade: vaga.escolaridade,
    experienciaMinima: vaga.experienciaMinima,
    requisitosDaVaga: vaga.requisitosDaVaga,
    requisitoObrigatorio: vaga.requisitoObrigatorio,
    aceitaSemExperiencia: vaga.aceitaSemExperiencia,
    exigeFimDeSemana: vaga.exigeFimDeSemana,
    exigeTransporteProprio: vaga.exigeTransporteProprio,
    exigeCltImediato: vaga.exigeCltImediato,
    perfilResumido: vaga.perfilResumido,
    palavrasChave: vaga.palavrasChave,
    status: vaga.status
  }));

  return `
Você é a Lia, da Effect Pessoas e Performance.

REGRAS FIXAS:
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Nunca use menu numérico.
- Nunca faça várias perguntas na mesma mensagem.
- Faça somente uma pergunta por vez.
- Não repita "Eu sou a Lia" se a conversa já começou.
- Seja humana, acolhedora, organizada, profissional e leve.
- Responda como mensagem de WhatsApp, curta e natural.

ABERTURA:
Se for o primeiro contato e a pessoa ainda não informou o nome, responda exatamente:
"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"

CANDIDATOS:
Colete aos poucos:
1. Nome
2. Cidade/bairro
3. Área ou vaga de interesse
4. Experiência
5. Escolaridade
6. Disponibilidade de horário
7. Se possui currículo

EMPRESAS:
Se parecer cliente/empresa, pergunte qual necessidade de contratação ou gestão de pessoas ela tem.

VAGAS DISPONÍVEIS:
${JSON.stringify(vagasResumidas, null, 2)}

REGRAS DE MATCH:
- Nunca diga que alguém é excelente para uma vaga sem experiência ou requisito obrigatório compatível.
- Se a vaga exigir requisito obrigatório e a pessoa não tiver, nunca classifique como excelente.
- Se a vaga aceitar sem experiência, pode considerar perfil iniciante.
- Considere cidade, área, experiência, escolaridade, disponibilidade e requisitos.
- Não prometa contratação.
- Use: "seu perfil pode ter aderência inicial" ou "vou sinalizar seu interesse para análise da equipe."

HISTÓRICO:
${sessao.historico.map(h => `${h.role}: ${h.content}`).join("\n")}

MENSAGEM ATUAL:
${mensagemAtual}

Responda somente a próxima mensagem da Lia para WhatsApp.
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
        max_tokens: 700,
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
  console.log(`Lia rodando na porta ${PORT} - modelo Claude 3.7`);
});
