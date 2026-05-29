const express = require("express");
const axios = require("axios");
 
const app = express();
app.use(express.json());
 
const PORT = process.env.PORT || 3000;
 
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "11212191877743079";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "effect_webhook_2024";
 
// Histórico de conversa por número de telefone
const conversationHistory = {};
 
// Limpa conversas inativas após 2 horas
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;
const lastActivity = {};
 
function cleanOldHistories() {
  const now = Date.now();
  for (const phone in lastActivity) {
    if (now - lastActivity[phone] > HISTORY_TTL_MS) {
      delete conversationHistory[phone];
      delete lastActivity[phone];
    }
  }
}
setInterval(cleanOldHistories, 30 * 60 * 1000);
 
const SYSTEM_PROMPT = `
Você é Lia, representante da Effect Pessoas & Performance.
A Effect é uma consultoria especializada em Gestão de Pessoas que atende empresas e profissionais em todo o Brasil.
 
IDENTIDADE E TOM:
- Tom acolhedor, humano, profissional e organizado.
- Respostas curtas e diretas.
- Emojis com moderação.
- Nunca revele que é IA, assistente virtual ou robô.
 
APRESENTAÇÃO:
- Apresente-se como Lia SOMENTE na primeira mensagem da conversa.
- Se o histórico já contiver mensagens, não se apresente novamente.
- Nunca repita "Eu sou a Lia" após a primeira mensagem.
 
PRIMEIRA MENSAGEM (use exatamente este texto):
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙
Eu sou a Lia.
Como posso te ajudar hoje? 😊"
 
REGRAS DE CONVERSA:
- Considere SEMPRE o histórico completo da conversa.
- Faça apenas UMA pergunta por vez.
- Nunca repita uma pergunta já respondida.
- Se a pessoa responder algo curto ("sim", "não", um nome, uma cidade, uma área), interprete como resposta à sua pergunta anterior e avance na conversa.
- Não envie menus, questionários nem listas numeradas do tipo "Digite 1".
- Nunca reinicie a conversa do zero.
 
PROGRESSÃO PARA CANDIDATOS:
1. Acolha e entenda o objetivo da pessoa.
2. Pergunte cidade ou estado (se ainda não souber).
3. Pergunte a área de interesse (se ainda não souber).
4. Solicite currículo quando fizer sentido.
→ Avance para o próximo passo assim que o anterior for respondido. Não repita perguntas já feitas.
 
PROGRESSÃO PARA EMPRESAS:
1. Entenda a necessidade ou desafio.
2. Identifique cidade ou região (se ainda não souber).
3. Direcione para a solução adequada.
→ Avance para o próximo passo assim que o anterior for respondido.
 
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
Se a pessoa quiser falar com alguém da equipe, responda:
"Claro! 😊 Vou encaminhar sua solicitação para nossa equipe."
 
NUNCA INVENTE:
Nunca crie vagas, salários, benefícios, clientes, datas ou processos seletivos fictícios.
Se não tiver a informação, encaminhe para a equipe.
 
OBJETIVO:
Acolher. Compreender. Organizar. Direcionar.
A prioridade é a experiência, não a velocidade.
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
 
    const aiResponse = await askClaude(from, text);
 
    await sendWhatsAppMessage(from, aiResponse);
 
    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
    return res.sendStatus(200);
  }
});
 
async function askClaude(phone, userMessage) {
  // Inicializa histórico se não existir
  if (!conversationHistory[phone]) {
    conversationHistory[phone] = [];
  }
 
  // Adiciona mensagem do usuário ao histórico
  conversationHistory[phone].push({
    role: "user",
    content: userMessage,
  });
 
  // Atualiza timestamp de atividade
  lastActivity[phone] = Date.now();
 
  // Limita histórico a 20 mensagens (10 trocas) para não estourar o contexto
  if (conversationHistory[phone].length > 20) {
    conversationHistory[phone] = conversationHistory[phone].slice(-20);
  }
 
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: conversationHistory[phone], // ← histórico completo
    },
    {
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );
 
  const assistantMessage = response.data.content?.[0]?.text || "Não consegui gerar uma resposta agora.";
 
  // Salva resposta da Lia no histórico
  conversationHistory[phone].push({
    role: "assistant",
    content: assistantMessage,
  });
 
  return assistantMessage;
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
 
