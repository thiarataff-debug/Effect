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
const SHEET_ID = "1p0BpaqBOGBn-Mmzt_omuZ1d9U1TzeMzwrIjIEN42NCk";
const DRIVE_FOLDER_ID = "1CERKBaTRq5ztoSCj94V5H8lgVqROZQqS";
const NUMERO_THIARATAFF = "5527997925288";

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

// ─────────────────────────────────────────
// GOOGLE DRIVE
// ─────────────────────────────────────────
async function getWhatsAppFileUrl(mediaId) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    return { url: res.data.url, mimeType: res.data.mime_type };
  } catch (e) {
    console.error("Erro ao buscar URL do arquivo:", e.message);
    return null;
  }
}

async function salvarCurriculoNoDrive(telefone, nomeCanditado, fileUrl, fileName, mimeType) {
  try {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: "v3", auth });
    const response = await axios.get(fileUrl, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const data = new Date().toLocaleDateString("pt-BR").replace(/\//g, "-");
    const ext = fileName.split(".").pop() || "pdf";
    const nomeArquivo = `${(nomeCanditado || "Candidato").replace(/\s+/g, "_")}_${telefone}_${data}.${ext}`;
    const uploaded = await drive.files.create({
      requestBody: { name: nomeArquivo, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType: mimeType || "application/octet-stream", body: response.data },
      fields: "id, webViewLink",
    });
    console.log(`Currículo salvo: ${nomeArquivo}`);
    return { link: uploaded.data.webViewLink, nome: nomeArquivo };
  } catch (e) {
    console.error("Erro ao salvar no Drive:", e.message);
    return null;
  }
}

// ─────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────
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
        dados.nome      || atual[1] || "",
        dados.cidade    || atual[2] || "",
        dados.area      || atual[3] || "",
        dados.curriculo || atual[4] || "",
        dados.score !== undefined ? dados.score : (atual[5] || ""),
        dados.status    || atual[6] || "Em triagem",
        atual[7]        || agora,
        agora,
        dados.obs       || atual[9] || "",
      ];
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Candidatos!A${existente.linha}:J${existente.linha}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [atualizado] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Candidatos!A:J",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[
          telefone,
          dados.nome      || "",
          dados.cidade    || "",
          dados.area      || "",
          dados.curriculo || "",
          dados.score     || "",
          dados.status    || "Em triagem",
          agora, agora,
          dados.obs       || "",
        ]] },
      });
    }
  } catch (e) {
    console.error("Erro ao salvar candidato:", e.message);
  }
}

// Busca até 5 vagas compatíveis com detalhes completos
async function buscarVagasCompativeis(area) {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    // Agora lê até a coluna L (12 colunas) para pegar os novos campos
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Vagas!A:L",
    });
    const rows = res.data.values || [];
    const vagas = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const areaVaga      = (row[2] || "").toLowerCase();
      const status        = (row[6] || "").toLowerCase();
      const areaCandidate = (area  || "").toLowerCase();
      if (
        status === "aberta" && areaVaga && areaCandidate &&
        (areaVaga.includes(areaCandidate.split("/")[0].trim()) ||
         areaCandidate.includes(areaVaga.split("/")[0].trim()))
      ) {
        vagas.push({
          id:        row[0]  || "",
          cargo:     row[1]  || "",
          area:      row[2]  || "",
          empresa:   row[3]  || "",
          cidade:    row[4]  || "",
          salario:   row[5]  || "",
          turno:     row[8]  || "",
          beneficios:row[9]  || "",
          requisitos:row[10] || "",
          descricao: row[11] || "",
        });
        if (vagas.length >= 5) break; // máximo 5 vagas
      }
    }
    return vagas;
  } catch (e) {
    console.error("Erro ao buscar vagas:", e.message);
    return [];
  }
}

// Formata vagas para a Lia apresentar de forma detalhada e legível
function formatarVagasParaLia(vagas) {
  if (vagas.length === 0) return "";
  const linhas = vagas.map((v, i) => {
    const partes = [
      `*${i + 1}. ${v.cargo}* — ${v.empresa}, ${v.cidade}`,
    ];
    if (v.salario)    partes.push(`💰 Salário: ${v.salario}`);
    if (v.turno)      partes.push(`🕐 Turno: ${v.turno}`);
    if (v.beneficios) partes.push(`🎁 Benefícios: ${v.beneficios}`);
    if (v.requisitos) partes.push(`📋 Requisitos: ${v.requisitos}`);
    if (v.descricao)  partes.push(`📝 Função: ${v.descricao}`);
    return partes.join("\n");
  });
  return linhas.join("\n\n");
}

// ─────────────────────────────────────────
// SCORE E EXTRAÇÃO
// ─────────────────────────────────────────
function calcularScore(dados) {
  let score = 40;
  if (dados.nome     && dados.nome.length > 2) score += 10;
  if (dados.cidade)                             score += 10;
  if (dados.area)                               score += 15;
  if (dados.curriculo === "Sim")                score += 25;
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
- pediu_humano: true se pediu para falar com alguém da equipe, false caso contrário
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

// ─────────────────────────────────────────
// NOTIFICAÇÕES
// ─────────────────────────────────────────
async function notificarAtendimentoHumano(telefone, nome, area, cidade) {
  try {
    const horario = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const msg =
      `🔔 *Atendimento humano solicitado*\n\n` +
      `👤 *Candidato:* ${nome   || "Não informado"}\n` +
      `📱 *WhatsApp:* +${telefone}\n` +
      `📍 *Cidade:* ${cidade    || "Não informada"}\n` +
      `💼 *Área:* ${area        || "Não informada"}\n` +
      `🕐 *Horário:* ${horario}\n\n` +
      `_Responda diretamente para esse número no WhatsApp._`;
    await sendWhatsAppMessage(NUMERO_THIARATAFF, msg);
  } catch (e) {
    console.error("Erro ao notificar atendimento:", e.message);
  }
}

async function notificarCurriculoRecebido(telefone, nome, nomeArquivo, linkDrive) {
  try {
    const horario = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const msg =
      `📄 *Currículo recebido*\n\n` +
      `👤 *Candidato:* ${nome || "Não informado"}\n` +
      `📱 *WhatsApp:* +${telefone}\n` +
      `📁 *Arquivo:* ${nomeArquivo}\n` +
      `🕐 *Horário:* ${horario}\n` +
      (linkDrive ? `🔗 *Drive:* ${linkDrive}` : "");
    await sendWhatsAppMessage(NUMERO_THIARATAFF, msg);
  } catch (e) {
    console.error("Erro ao notificar currículo:", e.message);
  }
}

// ─────────────────────────────────────────
// HISTÓRICO
// ─────────────────────────────────────────
const conversationHistory         = {};
const lastActivity                = {};
const atendimentoHumanoNotificado = {};
const HISTORY_TTL_MS              = 2 * 60 * 60 * 1000;

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

// ─────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────
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
4. Apresente vagas se houver [VAGAS_ENCONTRADAS] — use os detalhes exatos fornecidos.
5. Pergunte se tem interesse em alguma vaga específica.
6. Solicite currículo.

QUANDO HOUVER VAGAS COMPATÍVEIS:
- Recebendo a tag [VAGAS_ENCONTRADAS], apresente TODAS as vagas listadas, uma por uma, com todos os detalhes.
- Use exatamente o formato abaixo, sem inventar nada:

"Ótima notícia! Encontrei [X] vaga(s) compatível(is) com seu perfil 🎉

[Cole aqui os detalhes das vagas exatamente como recebidos]

Alguma dessas vagas te interessou? 😊"

- Após o candidato confirmar interesse em uma vaga específica, diga:
"Ótimo! Vou registrar seu interesse na vaga de [cargo] na [empresa]. Para agilizar o processo, você consegue me enviar seu currículo por aqui?"

QUANDO NÃO HOUVER VAGAS:
"Registrei seu interesse em [área]. No momento não temos vagas abertas nessa área, mas você ficará em nosso banco de talentos e será avisado assim que surgir uma oportunidade 💙
Você consegue me enviar seu currículo para deixar tudo pronto?"

ATENDIMENTO HUMANO:
Se a pessoa quiser falar com alguém da equipe:
"Claro! 😊 Já avisei nossa equipe e em breve alguém entrará em contato com você."

SERVIÇOS DA EFFECT:
- Recrutamento e Seleção, Treinamentos, Desenvolvimento de Lideranças
- Clima e Cultura, Performance, Estruturação de RH, NR-01 e riscos psicossociais

NUNCA INVENTE vagas, salários, benefícios, horários ou requisitos fictícios.
Use APENAS as informações recebidas via [VAGAS_ENCONTRADAS].
`;

// ─────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────
app.get("/", (req, res) => res.send("Effect WhatsApp Bot rodando!"));

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
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

    const from       = message.from;
    const text       = message.text?.body || "";
    const isDocument = message.type === "document";
    const isImage    = message.type === "image";

    if (!text && !isDocument && !isImage) {
      await sendWhatsAppMessage(from, "Recebi sua mensagem. No momento consigo responder melhor mensagens em texto.");
      return res.sendStatus(200);
    }

    let userInput = text;

    // ── Currículo recebido ──
    if (isDocument || isImage) {
      const mediaId  = message.document?.id || message.image?.id;
      const fileName = message.document?.filename || "curriculo";
      const mimeType = message.document?.mime_type || message.image?.mime_type || "application/octet-stream";

      userInput = `O candidato enviou o currículo (arquivo: ${fileName}). Confirme o recebimento de forma acolhedora e informe que a equipe irá analisar e entrar em contato em breve.`;

      const existente   = await buscarCandidato(from);
      const dadosAtuais = existente?.dados || [];
      const score       = calcularScore({ nome: dadosAtuais[1], cidade: dadosAtuais[2], area: dadosAtuais[3], curriculo: "Sim" });

      let linkDrive = null;
      if (mediaId) {
        const fileInfo = await getWhatsAppFileUrl(mediaId);
        if (fileInfo) {
          const uploaded = await salvarCurriculoNoDrive(from, dadosAtuais[1], fileInfo.url, fileName, fileInfo.mimeType || mimeType);
          if (uploaded) linkDrive = uploaded.link;
        }
      }

      await salvarCandidato(from, {
        nome: dadosAtuais[1], cidade: dadosAtuais[2], area: dadosAtuais[3],
        curriculo: "Sim", score, status: "Currículo recebido",
        obs: linkDrive ? `Drive: ${linkDrive}` : `Arquivo: ${fileName}`,
      });

      await notificarCurriculoRecebido(from, dadosAtuais[1], fileName, linkDrive);
    }

    // ── Histórico ──
    if (!conversationHistory[from]) conversationHistory[from] = [];
    conversationHistory[from].push({ role: "user", content: userInput });
    lastActivity[from] = Date.now();
    if (conversationHistory[from].length > 20) conversationHistory[from] = conversationHistory[from].slice(-20);

    // ── Extrai dados e salva ──
    if (conversationHistory[from].length >= 2) {
      const dadosExtraidos = await extrairDadosDaConversa(conversationHistory[from]);

      if (dadosExtraidos && Object.keys(dadosExtraidos).length > 0) {
        await salvarCandidato(from, { ...dadosExtraidos, score: calcularScore(dadosExtraidos) });

        if (dadosExtraidos.pediu_humano === true && !atendimentoHumanoNotificado[from]) {
          atendimentoHumanoNotificado[from] = true;
          await notificarAtendimentoHumano(from, dadosExtraidos.nome, dadosExtraidos.area, dadosExtraidos.cidade);
        }
      }

      // Busca vagas quando área é identificada (nas primeiras 8 mensagens)
      if (dadosExtraidos?.area && conversationHistory[from].length <= 8) {
        const vagas = await buscarVagasCompativeis(dadosExtraidos.area);
        if (vagas.length > 0) {
          const vagasFormatadas = formatarVagasParaLia(vagas);
          conversationHistory[from][conversationHistory[from].length - 1].content +=
            `\n\n[VAGAS_ENCONTRADAS — ${vagas.length} vaga(s)]\n${vagasFormatadas}`;
        }
      }
    }

    const aiResponse = await askClaude(from);
    conversationHistory[from].push({ role: "assistant", content: aiResponse });
    await sendWhatsAppMessage(from, aiResponse);
    return res.sendStatus(200);

  } catch (error) {
    console.error("Erro no webhook:", error.response?.data || error.message);
    return res.sendStatus(200);
  }
});

// ─────────────────────────────────────────
// CLAUDE E WHATSAPP
// ─────────────────────────────────────────
async function askClaude(phone) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: "claude-haiku-4-5-20251001", max_tokens: 800, system: SYSTEM_PROMPT, messages: conversationHistory[phone] },
    { headers: { "x-api-key": CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
  );
  return response.data.content?.[0]?.text || "Não consegui gerar uma resposta agora.";
}

async function sendWhatsAppMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: message } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
