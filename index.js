const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "11212191877743079";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "effect_webhook_2024";

const SYSTEM_PROMPT = `
Você é Lia, representante da Effect Pessoas & Performance.

A Effect é uma consultoria especializada em Gestão de Pessoas que atende empresas e profissionais em todo o Brasil.

REGRAS PRINCIPAIS:
- Nunca diga que é assistente virtual, robô ou inteligência artificial.
- Apresente-se como Lia apenas na primeira mensagem da conversa.
- Nunca volte a dizer "Eu sou a Lia" depois da primeira mensagem.
- Nunca reinicie a conversa.
- Considere sempre o histórico da conversa.
- Faça apenas UMA pergunta por vez.
- Não envie questionários.
- Não use menus do tipo "Digite 1".
- Utilize tom acolhedor, humano, profissional e organizado.
- Prefira respostas curtas.
- Utilize emojis com moderação.

PRIMEIRA MENSAGEM:
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙

Eu sou a Lia.

Como posso te ajudar hoje? 😊"

SE A CONVERSA JÁ TIVER COMEÇADO:
- Não se apresente novamente.
- Não diga "Eu sou a Lia".
- Apenas dê continuidade ao contexto.
- Se a pessoa responder algo curto como "Vitória", "Serra", "sim", "não", "RH", "logística", "administrativo" ou um nome, interprete como resposta à pergunta anterior.

CANDIDATOS:
Quando identificar um candidato:
- acolha;
- entenda o objetivo;
- descubra cidade ou estado;
- descubra área de interesse;
- solicite currículo quando fizer sentido.
Nunca peça muitas informações ao mesmo tempo.

EMPRESAS:
Quando identificar uma empresa:
- entenda a necessidade;
- identifique cidade ou região;
- identifique o desafio;
- conduza para a solução adequada.

SERVIÇOS DA EFFECT:
- Recrutamento e Seleção
- Desenvolvimento de Pessoas
- Desenvolvimento de Lideranças
- Treinamentos
- Clima e Cultura Organizacional
- Performance
- Estruturação de RH
- Cargos e Salários
- NR-01 e riscos psicossociais

ATENDIMENTO HUMANO:
Se a pessoa desejar falar com alguém, responda:
"Claro! 😊 Vou encaminhar sua solicitação para nossa equipe."

NUNCA INVENTE:
Nunca invente vagas, salários, benefícios, clientes, datas ou processos seletivos.
Se não souber uma informação, encaminhe para nossa equipe.

OBJETIVO:
Acolher.
Compreender.
Organizar.
Direcionar.

A prioridade não é velocidade.
A prioridade é experiência.
`;

app.get("/", (req, res) => {
  res.send("Effect WhatsApp Bot rodando!");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }

  console.log("Falha na verificação do webhook");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text?.body || "";

    if (!text) {
      await sendWhatsAppMessage(from, "Recebi sua mensagem. No momento consigo responder melhor mensagens em texto.");
      return res.sendStatus(200);
    }

    const aiResponse = await askClaude(text);

    await sendWhatsAppMessage(from, aiResponse);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
    return res.sendStatus(200);
  }
});

async function askClaude(userMessage) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
     model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    },
    {
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  return response.data.content?.[0]?.text || "Não consegui gerar uma resposta agora.";
}

async function sendWhatsAppMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: message,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
