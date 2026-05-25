const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ============================================================
// CONFIGURAÇÕES — substitua pelos seus valores reais
// ============================================================
const CONFIG = {
  CLAUDE_API_KEY: "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",
  WHATSAPP_TOKEN: "EAASXotSISF0BRsfSSyZA2ELbVCylTU8Q4Nm3GA5JvNWnCfnK54FiNTxc4cnq2u7FWGY9l2TdHc46N8ZBBuxCQusFnUXZCcTK7X57hkuS32aI3362uaH7bZBKooQOibeyGRhkWByFioOSwZC4TQ5WhVXkdNMZAv8kZCMq1yQ4ULCon5WBXw3HIsRUbj8AXXecDL7brCqBkGOMeUhOATnsD6RxMJfLZCkj4GGLPoqXVNLfDxP24KK8uXjcLLvkBzOzUqpqmLUEZChnhHg3KSNyXOWDm",
  PHONE_NUMBER_ID: "11212191877743079",
  VERIFY_TOKEN: "effect_webhook_2024",              // token de verificação do webhook (pode ser qualquer string)
};

// ============================================================
// PROMPT DA EFFECT PESSOAS & PERFORMANCE
// ============================================================
const SYSTEM_PROMPT = `Você é o assistente virtual da Effect Pessoas & Performance, empresa especializada em Gestão de Pessoas com ênfase em Recrutamento, Seleção, Desenvolvimento e Gestão Estratégica de Pessoas.

Seu papel é:
- Atender candidatos e clientes via WhatsApp com simpatia e profissionalismo
- Responder dúvidas sobre vagas, processos seletivos e serviços da empresa
- Coletar informações iniciais de candidatos interessados
- Encaminhar currículos recebidos para análise
- Agendar conversas com a equipe quando necessário

Tom de comunicação: profissional, acolhedor e humano. Evite respostas muito longas — seja direto e claro como num chat real.

Se não souber responder algo específico, diga que vai verificar com a equipe e peça o melhor contato da pessoa.

Quando receber um currículo (texto), analise e retorne:
1. 👤 Nome e cargo pretendido
2. ⭐ Pontuação geral (0-10) 
3. 💼 Experiências relevantes
4. ✅ Pontos fortes
5. ⚠️ Pontos de atenção
6. 📋 Recomendação: Avançar / Avaliar com cuidado / Não recomendado`;

// ============================================================
// MEMÓRIA DE CONVERSAS (em produção, use Redis ou banco de dados)
// ============================================================
const conversationHistory = {};

function getHistory(phone) {
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
  return conversationHistory[phone];
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Mantém apenas as últimas 20 mensagens para controlar tokens
  if (history.length > 20) {
    conversationHistory[phone] = history.slice(-20);
  }
}

// ============================================================
// FUNÇÃO: Chamar API do Claude
// ============================================================
async function callClaude(phone, userMessage) {
  addToHistory(phone, "user", userMessage);

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: getHistory(phone),
    },
    {
      headers: {
        "x-api-key": CONFIG.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const reply = response.data.content[0].text;
  addToHistory(phone, "assistant", reply);
  return reply;
}

// ============================================================
// FUNÇÃO: Enviar mensagem pelo WhatsApp
// ============================================================
async function sendWhatsAppMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ============================================================
// WEBHOOK — Verificação (GET)
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================================
// WEBHOOK — Receber mensagens (POST)
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responde rápido para a Meta

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const from = message.from; // número do remetente
    const messageType = message.type;

    let userText = "";

    if (messageType === "text") {
      userText = message.text.body;
    } else if (messageType === "document" || messageType === "image") {
      userText = "[Arquivo recebido] Por favor, cole o texto do currículo diretamente na mensagem para que eu possa analisá-lo.";
    } else {
      return; // ignora outros tipos por enquanto
    }

    console.log(`📩 Mensagem de ${from}: ${userText}`);

    // Chama o Claude e envia a resposta
    const reply = await callClaude(from, userText);
    await sendWhatsAppMessage(from, reply);

    console.log(`✅ Resposta enviada para ${from}`);
  } catch (error) {
    console.error("❌ Erro:", error.response?.data || error.message);
  }
});

// ============================================================
// ROTA DE SAÚDE
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "✅ Effect WhatsApp Bot rodando!",
    empresa: "Effect Pessoas & Performance",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📌 Webhook URL: https://SEU-DOMINIO.railway.app/webhook`);
});
