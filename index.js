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

const SHEET_ID = "1Bqrwjjy0JwAVouppOg-LGCENYrTsCQYrqntCBf9mSk";
const DRIVE_FOLDER_ID = "1-N6OjCjfdpaPCxvkXFjoMtU3UlksifTH";
const NUMERO_THIARATAFF = "5527997925288";

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  console.log("SERVICE ACCOUNT:", credentials.client_email);

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getDriveAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  });

  return oauth2Client;
}

function normalizarTexto(texto) {
  return (texto || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function gerarTermosBusca(area) {
  const texto = normalizarTexto(area);
  const termos = new Set();

  texto
    .replace("auxiliar ou ajudante de", "")
    .replace("ajudante de", "")
    .replace("auxiliar de", "")
    .replace("vaga de", "")
    .replace("vagas de", "")
    .replace("quero", "")
    .replace("procuro", "")
    .replace("preciso", "")
    .split(/[\/,;| ]+/)
    .map(t => t.trim())
    .filter(t => t.length > 2)
    .forEach(t => termos.add(t));

  if (
    texto.includes("cozinha") ||
    texto.includes("cozinheiro") ||
    texto.includes("cozinheira") ||
    texto.includes("chapeiro") ||
    texto.includes("restaurante")
  ) {
    termos.add("cozinha");
    termos.add("cozinheiro");
    termos.add("cozinheira");
    termos.add("chapeiro");
    termos.add("auxiliar");
  }

  if (
    texto.includes("garcom") ||
    texto.includes("garçon") ||
    texto.includes("salao") ||
    texto.includes("atendimento")
  ) {
    termos.add("garcom");
    termos.add("salao");
    termos.add("atendimento");
  }

  if (texto.includes("logistica") || texto.includes("estoque")) {
    termos.add("logistica");
    termos.add("estoque");
  }

  if (texto.includes("limpeza") || texto.includes("servicos gerais")) {
    termos.add("limpeza");
    termos.add("servicos");
    termos.add("gerais");
  }

  if (
    texto.includes("rh") ||
    texto.includes("recursos humanos") ||
    texto.includes("recrutamento") ||
    texto.includes("administrativo")
  ) {
    termos.add("rh");
    termos.add("recursos");
    termos.add("humanos");
    termos.add("administrativo");
  }

  return Array.from(termos);
}

async function getWhatsAppFileUrl(mediaId) {
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    return { url: res.data.url, mimeType: res.data.mime_type };
  } catch (e) {
    console.error("Erro ao buscar URL do arquivo:", e.message);
    return null;
  }
}

async function salvarCurriculoNoDrive(telefone, nomeCanditado, fileUrl, fileName, mimeType) {
  try {
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const response = await axios.get(fileUrl, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    const data = new Date().toLocaleDateString("pt-BR").replace(/\//g, "-");
    const ext = fileName.split(".").pop() || "pdf";
    const nomeArquivo = `${(nomeCanditado || "Candidato").replace(/\s+/g, "_")}_${telefone}_${data}.${ext}`;

    const uploaded = await drive.files.create({
      requestBody: {
        name: nomeArquivo,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: mimeType || "application/octet-stream",
        body: response.data,
      },
      fields: "id, webViewLink",
    });

    console.log(`Currículo salvo: ${nomeArquivo}`);
    return { link: uploaded.data.webViewLink, nome: nomeArquivo };
  } catch (e) {
    console.error("Erro ao salvar no Drive:", e.message);
    return null;
  }
}

async function buscarCandidato(telefone) {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Candidatos",
    });

    const rows = res.data.values || [];

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === telefone) {
        return { linha: i + 1, dados: rows[i] };
      }
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
        dados.score !== undefined ? dados.score : atual[5] || "",
        dados.status || atual[6] || "Em triagem",
        atual[7] || agora,
        agora,
        dados.obs || atual[9] || "",
        dados.vaga_interesse || atual[10] || "",
      ];

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Candidatos!A${existente.linha}:K${existente.linha}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [atualizado] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Candidatos",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[
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
            dados.vaga_interesse || "",
          ]],
        },
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
      range: "Vagas",
    });

    const rows = res.data.values || [];

    console.log("========== TESTE VAGAS ==========");
    console.log("AREA RECEBIDA:", area);
    console.log("PRIMEIRA LINHA:", JSON.stringify(rows[1]));
    console.log("SEGUNDA LINHA:", JSON.stringify(rows[2]));
    console.log("TOTAL LINHAS:", rows.length);
    console.log("=================================");

    const vagas = [];
    const areaCandidate = normalizarTexto(area);
    const termos = gerarTermosBusca(areaCandidate);

    console.log("BUSCA VAGAS - área normalizada:", areaCandidate);
    console.log("BUSCA VAGAS - termos:", termos);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];

      const cargoVaga = normalizarTexto(row[1]);
      const areaVaga = normalizarTexto(row[2]);
      const cidadeVaga = normalizarTexto(row[4]);
      const status = normalizarTexto(row[6]);

      const textoVaga = `${cargoVaga} ${areaVaga} ${cidadeVaga}`;

      const vagaAberta = status.includes("abert");
      const bateArea =
        termos.some(t => textoVaga.includes(t)) ||
        textoVaga.includes(areaCandidate) ||
        areaCandidate.includes(areaVaga);

      console.log("VAGA LIDA:", {
        linha: i + 1,
        cargo: row[1],
        area: row[2],
        cidade: row[4],
        status: row[6],
        textoVaga,
        vagaAberta,
        bateArea,
      });

      if (vagaAberta && bateArea) {
        vagas.push({
          id: row[0] || "",
          cargo: row[1] || "",
          area: row[2] || "",
          empresa: row[3] || "",
          cidade: row[4] || "",
          salario: row[5] || "",
          status: row[6] || "",
          turno: row[8] || "",
          beneficios: row[9] || "",
          requisitos: row[10] || "",
          descricao: row[11] || "",
        });
      }

      if (vagas.length >= 8) break;
    }

    console.log("BUSCA VAGAS - encontradas:", vagas.length);
    console.log("BUSCA VAGAS - vagas:", JSON.stringify(vagas));
    return vagas;
  } catch (e) {
    console.error("Erro ao buscar vagas:", e.message);
    return [];
  }
}

function formatarVagasParaLia(vagas) {
  return vagas.map((v, i) => {
    const p = [`*${i + 1}. ${v.cargo}* — ${v.empresa}, ${v.cidade}`];

    if (v.salario) p.push(`💰 Salário: ${v.salario}`);
    if (v.turno) p.push(`🕐 Horário/Escala: ${v.turno}`);
    if (v.beneficios) p.push(`🎁 Benefícios: ${v.beneficios}`);
    if (v.requisitos) p.push(`📋 Requisitos: ${v.requisitos}`);
    if (v.descricao) p.push(`📝 Atividades: ${v.descricao}`);

    return p.join("\n");
  }).join("\n\n");
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

Campos:
- nome: nome completo ou null
- cidade: cidade ou estado ou null
- area: área ou cargo de interesse.
- curriculo: "Sim", "Não" ou null
- pediu_humano: true ou false
- vaga_interesse: cargo exato da vaga escolhida ou null
- obs: observação em até 10 palavras ou null

Conversa:
${historico.map(m => `${m.role === "user" ? "Candidato" : "Lia"}: ${m.content}`).join("\n")}`;

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
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
const atendimentoHumanoNotificado = {};
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;

function cleanOldHistories() {
  const now = Date.now();

  for (const phone in lastActivity) {
    if (now - lastActivity[phone] > HISTORY_TTL_MS) {
      delete conversationHistory[phone];
      delete lastActivity[phone];
      delete atendimentoHumanoNotificado[phone];
    }
  }
}

setInterval(cleanOldHistories, 30 * 60 * 1000);

const SYSTEM_PROMPT = `
Você é Lia, da Effect Pessoas & Performance.

A Effect é uma consultoria especializada em Recrutamento e Seleção, Hunting, Desenvolvimento de Pessoas, Consultoria em RH e Cargos e Salários.

IDENTIDADE:
- Você é humana, acolhedora, profissional e objetiva.
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Fale como uma recrutadora experiente.
- Seja leve, simpática e organizada.
- Utilize emojis com moderação.

PRIMEIRO CONTATO:
Apresente-se apenas na primeira interação:
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙
Eu sou a Lia.
Que bom falar com você. Como posso te ajudar hoje? 😊"

Nunca repita essa apresentação depois.

VAGAS — REGRA PRIORITÁRIA:
- Sempre que houver [VAGAS_ENCONTRADAS], apresente TODAS as vagas imediatamente.
- Nunca peça currículo antes de mostrar as vagas encontradas.
- Nunca diga que não há vaga se existir [VAGAS_ENCONTRADAS].
- Use exatamente as informações recebidas em [VAGAS_ENCONTRADAS].
`;

app.get("/", (req, res) => {
  res.send("Effect WhatsApp Bot rodando!");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;

    if (message.fromMe === true || message.key?.fromMe === true) {
      return res.sendStatus(200);
    }

    const text = message.text?.body || "";
    const isDocument = message.type === "document";
    const isImage = message.type === "image";

    let userInput = text;

    if (!conversationHistory[from]) {
      conversationHistory[from] = [];
    }

    conversationHistory[from].push({
      role: "user",
      content: userInput,
    });

    lastActivity[from] = Date.now();

    if (conversationHistory[from].length > 20) {
      conversationHistory[from] = conversationHistory[from].slice(-20);
    }

    const dadosExtraidos = await extrairDadosDaConversa(conversationHistory[from]);

    if (dadosExtraidos && Object.keys(dadosExtraidos).length > 0) {
      await salvarCandidato(from, {
        ...dadosExtraidos,
        score: calcularScore(dadosExtraidos),
      });
    }

    const areaParaBuscar = dadosExtraidos?.area || text;

    if (areaParaBuscar && !isDocument && !isImage) {
      const vagas = await buscarVagasCompativeis(areaParaBuscar);

      if (vagas.length > 0) {
        const mensagemVagas =
          `Ótima notícia! 😊\n\n` +
          `Encontrei estas oportunidades para você:\n\n` +
          `${formatarVagasParaLia(vagas)}\n\n` +
          `Alguma delas chamou sua atenção?`;

        conversationHistory[from].push({
          role: "assistant",
          content: mensagemVagas,
        });

        await sendWhatsAppMessage(from, mensagemVagas);
        return res.sendStatus(200);
      }

      conversationHistory[from][conversationHistory[from].length - 1].content +=
        `\n\n[NENHUMA_VAGA_ENCONTRADA para: ${areaParaBuscar}]`;
    }

    const aiResponse = await askClaude(from);

    conversationHistory[from].push({
      role: "assistant",
      content: aiResponse,
    });

    await sendWhatsAppMessage(from, aiResponse);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
    return res.sendStatus(200);
  }
});

async function askClaude(phone) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 900,
      system: SYSTEM_PROMPT,
      messages: conversationHistory[phone],
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
      text: { body: message },
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
