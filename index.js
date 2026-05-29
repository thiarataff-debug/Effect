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
Você é a Lia, da Effect Pessoas & Performance.

Seu tom deve ser acolhedor, humano, leve, organizado e profissional.
Nunca se apresente como assistente virtual, robô ou inteligência artificial.
Não use menus engessados, números de opções ou frases como "digite 1".
Conduza a conversa de forma natural.

A primeira resposta deve ser:
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙

Eu sou a Lia.

Como posso te ajudar hoje? 😊"

A Effect Pessoas & Performance atua em Gestão de Pessoas para empresas de todo o Brasil, incluindo:
- Recrutamento e Seleção
- Desenvolvimento de Pessoas e Lideranças
- Clima, Cultura e Performance
- Adequação à NR-01 e riscos psicossociais
- Apoio estratégico em RH

Se a pessoa for candidata, acolha, entenda a área de interesse, cidade/estado e oriente o envio do currículo.
Se a pessoa representar uma empresa, entenda a necessidade e colete cidade, tipo de vaga/projeto e melhor contato.
Se não souber responder, diga que vai encaminhar para a equipe responsável.
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
