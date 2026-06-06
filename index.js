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

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz2PiEcDWi0RqqIPS4dG-ZaoM243awUD-RZcDNc47KO9MV1BRnMDD-uSNvET-sO_IjhKQ/exec";

const DRIVE_FOLDER_ID = "1-N6OjCjfdpaPCxvkXFjoMtU3UlksifTH";
const NUMERO_THIARATAFF = "5527997925288";

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

function gerarTermoBusca(texto) {
  const t = normalizarTexto(texto);

  if (t.includes("cozinha") || t.includes("cozinheiro") || t.includes("cozinheira") || t.includes("chapeiro") || t.includes("restaurante")) return "cozinha";
  if (t.includes("garcom") || t.includes("garçon") || t.includes("salao") || t.includes("atendimento")) return "garcom";
  if (t.includes("logistica") || t.includes("estoque")) return "logistica";
  if (t.includes("limpeza") || t.includes("servicos gerais")) return "limpeza";
  if (t.includes("rh") || t.includes("recursos humanos") || t.includes("recrutamento") || t.includes("administrativo")) return "rh";

  return t.replace("quero", "").replace("procuro", "").replace("vaga de", "").replace("vagas de", "").trim();
}

async function buscarCandidato(telefone) {
  try {
    const url = `${APPS_SCRIPT_URL}?acao=candidato&telefone=${encodeURIComponent(telefone)}`;
    const res = await axios.get(url);
    return res.data;
  } catch (e) {
    console.error("Erro ao buscar candidato:", e.message);
    return { ok: false, encontrado: false };
  }
}

async function salvarCandidato(telefone, dados) {
  try {
    await axios.post(APPS_SCRIPT_URL, {
      acao: "salvarCandidato",
      telefone,
      nome: dados.nome || "",
      cidade: dados.cidade || "",
      area: dados.area || "",
      curriculo: dados.curriculo || "",
      score: dados.score || "",
      status: dados.status || "Em triagem",
      obs: dados.obs || "",
      vaga_interesse: dados.vaga_interesse || "",
    });
  } catch (e) {
    console.error("Erro ao salvar candidato:", e.message);
  }
}

async function buscarVagasCompativeis(area) {
  try {
    const termo = gerarTermoBusca(area);
    console.log("BUSCANDO VAGAS:", termo);
    const url = `${APPS_SCRIPT_URL}?acao=vagas&termo=${encodeURIComponent(termo)}`;
    const res = await axios.get(url);
    console.log("RETORNO APPS SCRIPT:", JSON.stringify(res.data));
    if (!res.data || !res.data.ok) return [];
    return res.data.vagas || [];
  } catch (e) {
    console.error("Erro ao buscar vagas:", e.message);
    return [];
  }
}

function formatarVagasParaLia(vagas) {
  const vagasLimitadas = vagas.slice(0, 3);
  return vagasLimitadas
    .map((v, i) => {
      const linhas = [`*${i + 1}. ${v.cargo}* — ${v.empresa}, ${v.cidade}`];
      if (v.salario) linhas.push(`💰 Salário: ${v.salario}`);
      if (v.turno) linhas.push(`🕐 Horário/Escala: ${v.turno}`);
      if (v.beneficios) linhas.push(`🎁 Benefícios: ${String(v.beneficios).substring(0, 100)}`);
      if (v.requisitos) linhas.push(`📋 Requisitos: ${String(v.requisitos).substring(0, 100)}`);
      return linhas.join("\n");
    })
    .join("\n\n");
}

function formatarVagaDetalhada(vaga) {
  const linhas = [
    `*${vaga.cargo}*`,
    `🏢 Empresa: ${vaga.empresa}`,
    `📍 Local: ${vaga.cidade}`,
  ];
  if (vaga.salario) linhas.push(`💰 Salário: ${vaga.salario}`);
  if (vaga.turno) linhas.push(`🕐 Horário/Escala: ${vaga.turno}`);
  if (vaga.beneficios) linhas.push(`🎁 Benefícios: ${vaga.beneficios}`);
  if (vaga.requisitos) linhas.push(`📋 Requisitos: ${vaga.requisitos}`);
  if (vaga.descricao) linhas.push(`📝 Atividades: ${vaga.descricao}`);
  return linhas.join("\n");
}

function detectarInteresseVaga(texto, totalVagas) {
  const t = normalizarTexto(texto);

  // Detecta desinteresse
  const semInteresse = ["nenhuma", "nao", "não", "nenhum", "outra", "outras", "outro", "nada", "nao gostei", "não gostei"];
  if (semInteresse.some(p => t.includes(p))) return { interesse: false };

  // Detecta número da vaga
  const numeros = { "1": 1, "2": 2, "3": 3, "um": 1, "dois": 2, "tres": 3, "três": 3, "primeira": 1, "segunda": 2, "terceira": 3 };
  for (const [chave, num] of Object.entries(numeros)) {
    if (t.includes(chave) && num <= totalVagas) return { interesse: true, numero: num };
  }

  // Se texto curto e positivo, assume interesse na primeira
  const positivos = ["sim", "quero", "tenho interesse", "gostei", "legal", "essa", "me interessa"];
  if (positivos.some(p => t.includes(p))) return { interesse: true, numero: 1 };

  return null; // Não identificado
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
Retorne APENAS o JSON, sem texto adicional.

Campos:
- nome
- cidade
- area
- curriculo
- pediu_humano
- vaga_interesse
- obs

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

async function salvarCurriculoNoDrive(telefone, nomeCandidato, fileUrl, fileName, mimeType) {
  try {
    const auth = getDriveAuth();
    const drive = google.drive({ version: "v3", auth });

    const response = await axios.get(fileUrl, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    const data = new Date().toLocaleDateString("pt-BR").replace(/\//g, "-");
    const ext = fileName.split(".").pop() || "pdf";
    const nomeArquivo = `${(nomeCandidato || "Candidato").replace(/\s+/g, "_")}_${telefone}_${data}.${ext}`;

    const uploaded = await drive.files.create({
      requestBody: { name: nomeArquivo, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType: mimeType || "application/octet-stream", body: response.data },
      fields: "id, webViewLink",
    });

    return { link: uploaded.data.webViewLink, nome: nomeArquivo };
  } catch (e) {
    console.error("Erro ao salvar currículo no Drive:", e.message);
    return null;
  }
}

async function notificarCurriculoRecebido(telefone, nome, nomeArquivo, linkDrive) {
  try {
    const horario = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    await sendWhatsAppMessage(
      NUMERO_THIARATAFF,
      `📄 *Currículo recebido*\n\n👤 *Candidato:* ${nome || "Não informado"}\n📱 *WhatsApp:* +${telefone}\n📁 *Arquivo:* ${nomeArquivo}\n🕐 *Horário:* ${horario}\n${linkDrive ? `🔗 *Drive:* ${linkDrive}` : ""}`
    );
  } catch (e) {
    console.error("Erro ao notificar currículo:", e.message);
  }
}

// Estado da conversa por telefone
const conversationHistory = {};
const conversationState = {}; // Guarda estado do fluxo por telefone

/*
  Estados possíveis em conversationState[from]:
  - vagasApresentadas: boolean
  - vagasCache: array de vagas mostradas
  - aguardandoInteresse: boolean
  - vagaDetalhada: boolean
  - semVagasRodada2: boolean (já perguntou nova área)
  - aguardandoCurriculo: boolean
  - encerrado: boolean
*/

const SYSTEM_PROMPT = `
Você é Lia, da Effect Pessoas & Performance.

A Effect é uma consultoria especializada em Recrutamento e Seleção, Hunting, Desenvolvimento de Pessoas, Consultoria em RH e Cargos e Salários.

IDENTIDADE:
- Você é humana, acolhedora, profissional e objetiva.
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Fale como uma recrutadora experiente.
- Seja leve, simpática e organizada.
- Use emojis com moderação.

PRIMEIRO CONTATO:
Apresente-se apenas na primeira interação:
"Olá! Seja muito bem-vindo(a) à Effect Pessoas & Performance 💙
Eu sou a Lia.
Que bom falar com você. Como posso te ajudar hoje? 😊"

Nunca repita essa apresentação depois.

REGRAS:
- Faça apenas UMA pergunta por vez.
- Nunca transforme a conversa em formulário.
- Nunca repita perguntas já respondidas.
- Nunca peça currículo antes de verificar vagas.

VAGAS:
Quando houver vagas, apresente todas as vagas recebidas.
Nunca invente vagas, salários ou benefícios.
`;

app.get("/", (req, res) => res.send("Effect WhatsApp Bot rodando!"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);
    if (message.fromMe === true || message.key?.fromMe === true) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body || "";
    const isDocument = message.type === "document";
    const isImage = message.type === "image";

    if (!conversationHistory[from]) conversationHistory[from] = [];
    if (!conversationState[from]) conversationState[from] = {};

    const state = conversationState[from];

    // ─── Recebimento de currículo ───────────────────────────────────────────
    if (isDocument || isImage) {
      const mediaId = message.document?.id || message.image?.id;
      const fileName = message.document?.filename || "curriculo";
      const mimeType = message.document?.mime_type || message.image?.mime_type || "application/octet-stream";

      const candidato = await buscarCandidato(from);
      const dados = candidato?.dados || [];

      let linkDrive = null;

      if (mediaId) {
        const fileInfo = await getWhatsAppFileUrl(mediaId);
        if (fileInfo) {
          const uploaded = await salvarCurriculoNoDrive(from, dados[1], fileInfo.url, fileName, fileInfo.mimeType || mimeType);
          if (uploaded) linkDrive = uploaded.link;
        }
      }

      await salvarCandidato(from, {
        nome: dados[1] || "",
        cidade: dados[2] || "",
        area: dados[3] || "",
        curriculo: "Sim",
        score: calcularScore({ nome: dados[1], cidade: dados[2], area: dados[3], curriculo: "Sim" }),
        status: "Currículo recebido",
        obs: linkDrive ? `Drive: ${linkDrive}` : `Arquivo: ${fileName}`,
      });

      await notificarCurriculoRecebido(from, dados[1], fileName, linkDrive);
      await sendWhatsAppMessage(from, "Perfeito, recebi seu currículo com sucesso! 💙 Nossa equipe vai analisar seu perfil e entraremos em contato quando surgir uma oportunidade compatível.");

      state.encerrado = true;
      return res.sendStatus(200);
    }

    // ─── Fluxo: candidato viu detalhes e está aguardando candidatura ────────
    if (state.vagaDetalhada && !state.aguardandoCurriculo) {
      const t = normalizarTexto(text);
      const quer = ["sim", "quero", "pode", "vamos", "me candidato", "tenho interesse", "ok", "claro"].some(p => t.includes(p));
      const nao = ["nao", "não", "agora nao", "agora não", "depois", "obrigado", "valeu", "tchau"].some(p => t.includes(p));

      if (quer) {
        state.aguardandoCurriculo = true;
        conversationHistory[from].push({ role: "user", content: text });
        const msg = "Ótimo! 🎉 Para concluir sua candidatura, me envie seu currículo aqui pelo WhatsApp (PDF ou Word). 📄";
        conversationHistory[from].push({ role: "assistant", content: msg });
        await sendWhatsAppMessage(from, msg);
        return res.sendStatus(200);
      }

      if (nao) {
        // Encerra educadamente
        conversationHistory[from].push({ role: "user", content: text });
        const msg = "Tudo bem! 😊 Fico à disposição sempre que precisar. Qualquer novidade em vagas, estaremos aqui. Tenha um ótimo dia! 💙";
        conversationHistory[from].push({ role: "assistant", content: msg });
        await sendWhatsAppMessage(from, msg);
        state.encerrado = true;
        return res.sendStatus(200);
      }
    }

    // ─── Fluxo: vagas apresentadas, aguardando interesse ────────────────────
    if (state.aguardandoInteresse && state.vagasCache) {
      const resultado = detectarInteresseVaga(text, state.vagasCache.length);

      if (resultado && resultado.interesse) {
        const vagaEscolhida = state.vagasCache[resultado.numero - 1];
        const detalhe = formatarVagaDetalhada(vagaEscolhida);
        const msg = `Boa escolha! 😊 Veja todos os detalhes:\n\n${detalhe}\n\nTem interesse em se candidatar a essa vaga?`;

        conversationHistory[from].push({ role: "user", content: text });
        conversationHistory[from].push({ role: "assistant", content: msg });
        await sendWhatsAppMessage(from, msg);

        state.aguardandoInteresse = false;
        state.vagaDetalhada = true;
        await salvarCandidato(from, { vaga_interesse: vagaEscolhida.cargo, status: "Interessado" });
        return res.sendStatus(200);
      }

      if (resultado && !resultado.interesse) {
        // Não se interessou — pergunta nova área (rodada 2)
        if (!state.semVagasRodada2) {
          state.semVagasRodada2 = true;
          state.aguardandoInteresse = false;
          state.vagasCache = null;

          conversationHistory[from].push({ role: "user", content: text });
          const msg = "Entendo! 😊 Me conta então qual área ou cargo você está procurando? Assim posso buscar outras oportunidades para você.";
          conversationHistory[from].push({ role: "assistant", content: msg });
          await sendWhatsAppMessage(from, msg);
          return res.sendStatus(200);
        }

        // Rodada 2 também sem interesse — pede currículo para banco de talentos
        if (state.semVagasRodada2 && !state.pedidoCurriculo) {
          state.pedidoCurriculo = true;
          conversationHistory[from].push({ role: "user", content: text });
          const msg = "Compreendo! No momento não temos uma vaga perfeita para você, mas adoraríamos ter seu perfil no nosso banco de talentos 💙\n\nVocê pode me enviar seu currículo? Assim te avisamos assim que surgir uma oportunidade compatível!";
          conversationHistory[from].push({ role: "assistant", content: msg });
          await sendWhatsAppMessage(from, msg);
          state.aguardandoCurriculo = true;
          return res.sendStatus(200);
        }
      }
    }

    // ─── Fluxo: segunda busca de vagas após nova área informada ─────────────
    if (state.semVagasRodada2 && !state.vagasCache && !state.pedidoCurriculo) {
      const vagas2 = await buscarVagasCompativeis(text);

      if (vagas2.length > 0) {
        const listaFormatada = formatarVagasParaLia(vagas2);
        const msg = `Encontrei estas oportunidades:\n\n${listaFormatada}\n\nAlguma delas chamou sua atenção?`;

        conversationHistory[from].push({ role: "user", content: text });
        conversationHistory[from].push({ role: "assistant", content: msg });
        await sendWhatsAppMessage(from, msg);

        state.vagasCache = vagas2;
        state.aguardandoInteresse = true;
        return res.sendStatus(200);
      } else {
        // Sem vagas na rodada 2 — pede currículo para banco de talentos
        state.pedidoCurriculo = true;
        conversationHistory[from].push({ role: "user", content: text });
        const msg = "No momento não temos vagas nessa área, mas adoraríamos ter seu perfil no nosso banco de talentos 💙\n\nVocê pode me enviar seu currículo? Assim te avisamos assim que surgir uma oportunidade compatível!";
        conversationHistory[from].push({ role: "assistant", content: msg });
        await sendWhatsAppMessage(from, msg);
        state.aguardandoCurriculo = true;
        return res.sendStatus(200);
      }
    }

    // ─── Fluxo: aguardando currículo mas candidato não enviou ───────────────
    if (state.aguardandoCurriculo && !isDocument && !isImage) {
      const t = normalizarTexto(text);
      const nao = ["nao", "não", "agora nao", "agora não", "depois", "obrigado", "valeu", "tchau", "nao tenho", "não tenho"].some(p => t.includes(p));

      if (nao) {
        conversationHistory[from].push({ role: "user", content: text });
        const msg = "Sem problema! 😊 Quando quiser, é só nos chamar. Desejo muito sucesso na sua jornada profissional! 💙";
        conversationHistory[from].push({ role: "assistant", content: msg });
        await sendWhatsAppMessage(from, msg);
        state.encerrado = true;
        return res.sendStatus(200);
      }
    }

    // ─── Fluxo principal: primeira busca de vagas ────────────────────────────
    conversationHistory[from].push({ role: "user", content: text });

    if (conversationHistory[from].length > 20) {
      conversationHistory[from] = conversationHistory[from].slice(-20);
    }

    const dadosExtraidos = await extrairDadosDaConversa(conversationHistory[from]);

    await salvarCandidato(from, {
      ...dadosExtraidos,
      score: calcularScore(dadosExtraidos),
    });

    const areaParaBuscar = dadosExtraidos?.area || text;

    if (areaParaBuscar && !state.vagasApresentadas) {
      const vagas = await buscarVagasCompativeis(areaParaBuscar);

      if (vagas.length > 0) {
        const listaFormatada = formatarVagasParaLia(vagas);
        const mensagem = `Ótima notícia! 😊\n\nEncontrei estas oportunidades para você:\n\n${listaFormatada}\n\nAlguma delas chamou sua atenção?`;

        conversationHistory[from].push({ role: "assistant", content: mensagem });
        await sendWhatsAppMessage(from, mensagem);

        state.vagasApresentadas = true;
        state.vagasCache = vagas;
        state.aguardandoInteresse = true;
        return res.sendStatus(200);
      }
    }

    // ─── Resposta livre da Lia via Claude ────────────────────────────────────
    const resposta = await askClaude(from);
    conversationHistory[from].push({ role: "assistant", content: resposta });
    await sendWhatsAppMessage(from, resposta);

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
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
