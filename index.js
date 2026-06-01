const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "11212191877743079";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "effect_webhook_2024";

const SHEET_ID = "1rue0dhiZZdlaLENq7sZ6KSWVLLi7iJeA";

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function buscarCandidato(telefone) {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Candidatos!A:J",
    });
    const rows = res.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === telefone) return { linha: i + 1, dados: rows[i] };
    }
    return null;
  } catch (e) {
    console.error("Erro ao buscar candidato:", e.message);
    return null;
  }
}

async function salvarCandidato(telefone, dados) {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const existente = await buscarCandidato(telefone);
    const agora = new Date().toLocaleDateString("pt-BR");

    if (existente) {
      const atual = existente.dados;
      const atualizado = [
        telefone,
        dados.nome || atual[1] || "",
        dados.cidade || atual[2] || "",
        dados.area || atual[3] || "",
        dados.curriculo || atual[4] || "",
        dados.score !== undefined ? dados.score : (atual[5] || ""),
        dados.status || atual[6] || "Em triagem",
        atual[7] || agora,
        agora,
        dados.obs || atual[9] || "",
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Candidatos!A${existente.linha}:J${existente.linha}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [atualizado] },
      });
    } else {
      const nova = [
        telefone,
        dados.nome || "",
        dados.cidade || "",
        dados.area || "",
        dados.curriculo || "",
        dados.score || "",
        dados.status || "Em triagem",
        agora,
        agora,
        dados.obs || "",
      ];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Candidatos!A:J",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [nova] },
      });
    }
  } catch (e) {
    console.error("Erro ao salvar candidato:", e.message);
  }
}

async function buscarVagasCompativeis(area) {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Vagas!A:H",
    });
    const rows = res.data.values || [];
    const vagas = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const areaVaga = (row[2] || "").toLowerCase();
      const status = (row[6] || "").toLowerCase();
      const areaCandidate = (area || "").toLowerCase();
      if (status === "aberta" && areaVaga && areaCandidate &&
          (areaVaga.includes(areaCandidate.split("/")[0].trim()) ||
           areaCandidate.includes(areaVaga.split("/")[0].trim()))) {
        vagas.push({ id: row[0], cargo: row[1], area: row[2], empresa: row[3], cidade: row[4], salario: row[5] });
      }
    }
    return vagas;
  } catch (e) {
    console.error("Erro ao buscar vagas:", e.message);
    return [];
  }
}

function calcularScore(dados) {
  let score = 40;
  if (dados.nome && dados.nome.length > 2) score += 10;
  if (dados.cidade) score += 10;
  if (dados.area) score += 15;
  if (dados.curriculo === "Sim") score += 25;
  return Math.min(score, 100);
}

async function extrairDadosDaConversa(historico) {
  try {
    const prompt = `Analise esta conversa e extraia os dados do candidato em JSON.
Retorne APENAS o JSON, sem texto adicional, sem markdown.

Campos a extrair:
- nome: nome completo mencionado (ou null)
- cidade: cidade ou estado mencionado (ou null)
- area: área de interesse como "Salão / Garçom", "Cozinha / Auxiliar", "Cozinha / Cozinheiro", "Bar / Barman", "Gestão / Supervisão", "RH / Administrativo" (ou null)
- curriculo: "Sim" se enviou currículo, "Não" se disse que não tem, null se não mencionou
- obs: observação relevante em até 10 palavras (ou null)

Conversa:
${historico.map(m => `${m.role === "user" ? "Candidato" : "Lia"}: ${m.content}`).join("\n")}`;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] },
      { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    const text = response.data.content?.[0]?.text || "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("Erro ao extrair dados:", e.message);
    return {};
  }
}

const conversationHistory = {};
const lastActivity = {};
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;

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
- Nunca repita "Eu sou a Lia" após a primeira mensagem.

PRIMEIRA MENSAGEM (use exatamente este texto):
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙
Eu sou a Lia.
Como posso te ajudar hoje? 😊"

REGRAS DE CONVERSA:
- Considere SEMPRE o histórico completo da conversa.
- Faça apenas UMA pergunta por vez.
- Nunca repita uma pergunta já respondida.
- Não envie menus ou listas numeradas do tipo "Digite 1".
- Nunca reinicie a conversa do zero.

PROGRESSÃO PARA CANDIDATOS:
1. Acolha e pergunte o nome.
2. Pergunte cidade ou estado.
3. Pergunte a área de interesse.
4. Solicite currículo.

QUANDO HOUVER VAGAS COMPATÍVEIS:
- Se receber a tag [VAGAS_ENCONTRADAS], apresente as vagas de forma acolhedora.
- Exemplo: "Ótima notícia! Temos uma vaga aberta de [cargo] em [empresa], [cidade]. Vou registrar seu interesse e nossa equipe entrará em contato em breve 😊"

SERVIÇOS DA EFFECT:
- Recrutamento e Seleção, Treinamentos, Desenvolvimento de Lideranças
- Clima e Cultura, Performance, Estruturação de RH, NR-01 e riscos psicossociais

ATENDIMENTO HUMANO:
Se quiser falar com a equipe: "Claro! 😊 Vou encaminhar sua solicitação para nossa equipe."

NUNCA INVENTE vagas, salários, benefícios ou processos fictícios.
`;

app.get("/", (req, res) => res.send("Effect
