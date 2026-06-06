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
const SHEET_ID = "1aZTIZSMa_s1szwpqAV-hmCbq3rIdV1P6";
const DRIVE_FOLDER_ID = "1-N6OjCjfdpaPCxvkXFjoMtU3UlksifTH";
const NUMERO_THIARATAFF = "5527997925288";

// Auth para Sheets (Service Account)
function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// Auth para Drive (OAuth — usa suas credenciais pessoais)
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

// ─────────────────────────────────────────
// GOOGLE DRIVE (OAuth)
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
      range: "Candidatos!A:K",
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
        range: "Candidatos!A:K",
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
          dados.vaga_interesse || "",
        ]] },
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
      range: "Vagas!A:L",
    });
    const rows = res.data.values || [];
    const vagas = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const cargoVaga     = (row[1] || "").toLowerCase();
const areaVaga      = (row[2] || "").toLowerCase();
const status        = (row[6] || "").toLowerCase();
const areaCandidate = (area  || "").toLowerCase();

const termos = areaCandidate
  .replace("auxiliar ou ajudante de", "")
  .replace("ajudante de", "")
  .replace("auxiliar de", "")
  .split(/[\/, ]+/)
  .map(t => t.trim())
  .filter(t => t.length > 2);

const textoVaga = `${cargoVaga} ${areaVaga}`;

if (status.includes("abert") && areaCandidate && termos.some(t => textoVaga.includes(t))) {
        vagas.push({
          id: row[0], cargo: row[1], area: row[2], empresa: row[3],
          cidade: row[4], salario: row[5], turno: row[8],
          beneficios: row[9], requisitos: row[10], descricao: row[11],
        });
        if (vagas.length >= 5) break;
      }
    }
    return vagas;
  } catch (e) {
    console.error("Erro ao buscar vagas:", e.message);
    return [];
  }
}

function formatarVagasParaLia(vagas) {
  return vagas.map((v, i) => {
    const p = [`*${i + 1}. ${v.cargo}* — ${v.empresa}, ${v.cidade}`];
    if (v.salario)    p.push(`💰 Salário: ${v.salario}`);
    if (v.turno)      p.push(`🕐 Turno: ${v.turno}`);
    if (v.beneficios) p.push(`🎁 Benefícios: ${v.beneficios}`);
    if (v.requisitos) p.push(`📋 Requisitos: ${v.requisitos}`);
    if (v.descricao)  p.push(`📝 Função: ${v.descricao}`);
    return p.join("\n");
  }).join("\n\n");
}

// ─────────────────────────────────────────
// RETORNO NEGATIVO
// ─────────────────────────────────────────
async function enviarRetornosNegativos() {
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Candidatos!A:K",
    });
    const rows = res.data.values || [];
    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(ontem.getDate() - 1);
    const ontemStr = ontem.toLocaleDateString("pt-BR");

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const telefone       = row[0] || "";
      const nome           = row[1] || "";
      const status         = (row[6] || "").toLowerCase();
      const ultimaInteracao = row[8] || "";
      const vagaInteresse  = row[10] || "";
      const retornoEnviado = (row[9] || "").includes("Retorno enviado");

      if (status === "descartado" && ultimaInteracao === ontemStr && !retornoEnviado && telefone) {
        const nomePrimeiro = nome.split(" ")[0] || "candidato(a)";
        const mensagem = vagaInteresse
          ? `Olá, ${nomePrimeiro}! 😊\n\nPassando para te dar um retorno sobre o processo seletivo para a vaga de *${vagaInteresse}* na Effect Pessoas & Performance.\n\nApós análise cuidadosa do seu perfil, desta vez não seguiremos com sua candidatura para essa oportunidade específica.\n\nSeu cadastro permanece em nosso banco de talentos e entraremos em contato assim que surgir uma vaga compatível com seu perfil 💙\n\nObrigada pela confiança na Effect!\n*Equipe Effect Pessoas & Performance*`
          : `Olá, ${nomePrimeiro}! 😊\n\nPassando para te dar um retorno sobre o seu cadastro na Effect Pessoas & Performance.\n\nApós análise cuidadosa do seu perfil, no momento não temos uma oportunidade compatível com seu histórico.\n\nSeu cadastro permanece em nosso banco de talentos e entraremos em contato assim que surgir uma vaga compatível com seu perfil 💙\n\nObrigada pela confiança na Effect!\n*Equipe Effect Pessoas & Performance*`;

        await sendWhatsAppMessage(telefone, mensagem);
        console.log(`Retorno negativo enviado para ${nome} (${telefone})`);

        const obsAtual = row[9] || "";
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `Candidatos!J${i + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[obsAtual + " | Retorno enviado: " + hoje.toLocaleDateString("pt-BR")]] },
        });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log("Verificação de retornos negativos concluída.");
  } catch (e) {
    console.error("Erro ao enviar retornos negativos:", e.message);
  }
}

function agendarRetornos() {
  const agora = new Date();
  const proximaNove = new Date();
  proximaNove.setHours(12, 0, 0, 0);
  if (agora >= proximaNove) proximaNove.setDate(proximaNove.getDate() + 1);
  const msAteNove = proximaNove - agora;
  setTimeout(() => {
    enviarRetornosNegativos();
    setInterval(enviarRetornosNegativos, 24 * 60 * 60 * 1000);
  }, msAteNove);
  console.log(`Retornos agendados para ${proximaNove.toLocaleString("pt-BR")}`);
}
agendarRetornos();

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

Campos:
- nome: nome completo (ou null)
- cidade: cidade ou estado (ou null)
- area: "Salão / Garçom", "Cozinha / Auxiliar", "Cozinha / Cozinheiro", "Bar / Barman", "Gestão / Supervisão", "RH / Administrativo" (ou null)
- curriculo: "Sim", "Não" ou null
- pediu_humano: true/false
- vaga_interesse: cargo exato da vaga escolhida (ou null)
- obs: observação em até 10 palavras (ou null)

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
    await sendWhatsAppMessage(NUMERO_THIARATAFF,
      `🔔 *Atendimento humano solicitado*\n\n👤 *Candidato:* ${nome || "Não informado"}\n📱 *WhatsApp:* +${telefone}\n📍 *Cidade:* ${cidade || "Não informada"}\n💼 *Área:* ${area || "Não informada"}\n🕐 *Horário:* ${horario}\n\n_Responda diretamente para esse número no WhatsApp._`
    );
  } catch (e) { console.error("Erro ao notificar atendimento:", e.message); }
}

async function notificarCurriculoRecebido(telefone, nome, nomeArquivo, linkDrive) {
  try {
    const horario = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    await sendWhatsAppMessage(NUMERO_THIARATAFF,
      `📄 *Currículo recebido*\n\n👤 *Candidato:* ${nome || "Não informado"}\n📱 *WhatsApp:* +${telefone}\n📁 *Arquivo:* ${nomeArquivo}\n🕐 *Horário:* ${horario}\n${linkDrive ? `🔗 *Drive:* ${linkDrive}` : ""}`
    );
  } catch (e) { console.error("Erro ao notificar currículo:", e.message); }
}

// ─────────────────────────────────────────
// HISTÓRICO
// ─────────────────────────────────────────
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
- Apresente-se como Lia SOMENTE na primeira mensagem.
- Nunca repita "Eu sou a Lia" após a primeira mensagem.

PRIMEIRA MENSAGEM:
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙
Eu sou a Lia.
Como posso te ajudar hoje? 😊"

REGRAS:
- Faça apenas UMA pergunta por vez.
- Nunca repita perguntas já respondidas.
- Nunca reinicie a conversa do zero.

PROGRESSÃO PARA CANDIDATOS:
1. Acolha e pergunte o nome.
2. Pergunte cidade ou estado.
3. Pergunte a área de interesse.
4. Apresente vagas se houver [VAGAS_ENCONTRADAS].
5. Pergunte se tem interesse em alguma vaga específica.
6. Solicite currículo.

QUANDO HOUVER VAGAS:
"Ótima notícia! Encontrei [X] vaga(s) compatível(is) com seu perfil 🎉

[detalhes]

Alguma dessas vagas te interessou? 😊"

QUANDO NÃO HOUVER VAGAS:
"Registrei seu interesse em [área]. No momento não temos vagas abertas, mas você ficará em nosso banco de talentos 💙
Consegue me enviar seu currículo?"

ATENDIMENTO HUMANO:
"Claro! 😊 Já avisei nossa equipe e em breve alguém entrará em contato."

NUNCA INVENTE vagas, salários ou benefícios.
`;

// ─────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────
app.get("/", (req, res) => res.send("Effect WhatsApp Bot rodando!"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
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

    if (!text && !isDocument && !isImage) {
      await sendWhatsAppMessage(from, "Recebi sua mensagem. No momento consigo responder melhor mensagens em texto.");
      return res.sendStatus(200);
    }

    let userInput = text;

    if (isDocument || isImage) {
      const mediaId  = message.document?.id || message.image?.id;
      const fileName = message.document?.filename || "curriculo";
      const mimeType = message.document?.mime_type || message.image?.mime_type || "application/octet-stream";
      userInput = `O candidato enviou o currículo (arquivo: ${fileName}). Confirme o recebimento de forma acolhedora e informe que a equipe irá analisar e entrar em contato em breve.`;
      const existente = await buscarCandidato(from);
      const dadosAtuais = existente?.dados || [];
      const score = calcularScore({ nome: dadosAtuais[1], cidade: dadosAtuais[2], area: dadosAtuais[3], curriculo: "Sim" });
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
        vaga_interesse: dadosAtuais[10] || "",
      });
      await notificarCurriculoRecebido(from, dadosAtuais[1], fileName, linkDrive);
    }

    if (!conversationHistory[from]) conversationHistory[from] = [];
    conversationHistory[from].push({ role: "user", content: userInput });
    lastActivity[from] = Date.now();
    if (conversationHistory[from].length > 20) conversationHistory[from] = conversationHistory[from].slice(-20);

    if (conversationHistory[from].length >= 2) {
      const dadosExtraidos = await extrairDadosDaConversa(conversationHistory[from]);
      if (dadosExtraidos && Object.keys(dadosExtraidos).length > 0) {
        await salvarCandidato(from, { ...dadosExtraidos, score: calcularScore(dadosExtraidos) });
        if (dadosExtraidos.pediu_humano === true && !atendimentoHumanoNotificado[from]) {
          atendimentoHumanoNotificado[from] = true;
          await notificarAtendimentoHumano(from, dadosExtraidos.nome, dadosExtraidos.area, dadosExtraidos.cidade);
        }
      }
      if (dadosExtraidos?.area && conversationHistory[from].length <= 8) {
        const vagas = await buscarVagasCompativeis(dadosExtraidos.area);
        if (vagas.length > 0) {
          conversationHistory[from][conversationHistory[from].length - 1].content +=
            `\n\n[VAGAS_ENCONTRADAS — ${vagas.length} vaga(s)]\n${formatarVagasParaLia(vagas)}`;
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
