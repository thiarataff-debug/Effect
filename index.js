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

const REGIOES = {
  "Grande Vitória": ["vitoria", "vitória", "serra", "vila velha", "cariacica", "viana", "guarapari"],
  "Norte do ES": ["linhares", "sao mateus", "são mateus", "colatina", "aracruz", "sooretama"],
  "Sul do ES": ["cachoeiro", "itapemirim", "marataizes", "marataízes", "anchieta"]
};

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

  return t
    .replace("quero", "")
    .replace("procuro", "")
    .replace("vaga de", "")
    .replace("vagas de", "")
    .replace("emprego de", "")
    .trim();
}

function detectarTurno(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("noite") || t.includes("noturno") || t.includes("madrugada")) return "noite";
  if (t.includes("dia") || t.includes("manha") || t.includes("manhã") || t.includes("tarde") || t.includes("comercial")) return "dia";
  if (t.includes("tanto faz") || t.includes("qualquer") || t.includes("indiferente") || t.includes("disponibilidade total")) return "tanto faz";
  return "";
}

function detectarExperiencia(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("sem experiencia") || t.includes("sem experiência") || t.includes("primeiro emprego") || t.includes("nao tenho") || t.includes("não tenho")) return "sem experiencia";
  if (t.includes("com experiencia") || t.includes("com experiência") || t.includes("tenho experiencia") || t.includes("tenho experiência") || t.includes("ja trabalhei") || t.includes("já trabalhei")) return "com experiencia";
  if (t.includes("tanto faz") || t.includes("qualquer") || t.includes("indiferente")) return "tanto faz";
  return "";
}

function detectarEscolaridade(texto) {
  const t = normalizarTexto(texto);
  if (t.includes("fundamental")) return "fundamental";
  if (t.includes("medio") || t.includes("médio") || t.includes("ensino medio") || t.includes("ensino médio")) return "medio";
  if (t.includes("tecnico") || t.includes("técnico")) return "tecnico";
  if (t.includes("superior cursando") || t.includes("faculdade cursando")) return "superior cursando";
  if (t.includes("superior completo") || t.includes("faculdade completa") || t.includes("formado")) return "superior completo";
  if (t.includes("tanto faz") || t.includes("qualquer") || t.includes("indiferente")) return "tanto faz";
  return "";
}

function identificarRegiao(cidade) {
  const c = normalizarTexto(cidade);
  for (const [regiao, cidades] of Object.entries(REGIOES)) {
    if (cidades.some(nome => c.includes(normalizarTexto(nome)) || normalizarTexto(nome).includes(c))) return regiao;
  }
  return "";
}

function calcularDistanciaRegiao(cidadeCandidato, cidadeVaga) {
  const cand = normalizarTexto(cidadeCandidato);
  const vaga = normalizarTexto(cidadeVaga);

  if (cand && vaga && vaga.includes(cand)) return 0;

  const regiaoCand = identificarRegiao(cidadeCandidato);
  const regiaoVaga = identificarRegiao(cidadeVaga);

  if (regiaoCand && regiaoVaga && regiaoCand === regiaoVaga) return 1;
  if (regiaoCand && regiaoVaga && regiaoCand !== regiaoVaga) return 2;

  return 3;
}

function ordenarVagasPorRegiao(vagas, cidadeCandidato = "") {
  return [...vagas].sort((a, b) => {
    const distanciaA = calcularDistanciaRegiao(cidadeCandidato, a.cidade || "");
    const distanciaB = calcularDistanciaRegiao(cidadeCandidato, b.cidade || "");

    if (distanciaA !== distanciaB) return distanciaA - distanciaB;

    const dataA = new Date(a.data || 0).getTime();
    const dataB = new Date(b.data || 0).getTime();

    return dataB - dataA;
  });
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

async function buscarVagasCompativeis(area, filtros = {}) {
  try {
    const termo = gerarTermoBusca(area);

    const params = new URLSearchParams();
    params.append("acao", "vagas");
    params.append("termo", termo);

    if (filtros.turno) params.append("turno", filtros.turno);
    if (filtros.experiencia) params.append("experiencia", filtros.experiencia);
    if (filtros.escolaridade) params.append("escolaridade", filtros.escolaridade);

    const url = `${APPS_SCRIPT_URL}?${params.toString()}`;
    const res = await axios.get(url);

    if (!res.data || !res.data.ok) return [];
    return res.data.vagas || [];
  } catch (e) {
    console.error("Erro ao buscar vagas:", e.message);
    return [];
  }
}

function formatarVagasParaLia(vagas, offset = 0) {
  return vagas.map((v, i) => {
    const numero = offset + i + 1;
    const linhas = [`*${numero}. ${v.cargo}* — ${v.empresa || "Empresa confidencial"}, ${v.cidade || "Local não informado"}`];

    if (v.salario) linhas.push(`💰 Salário: ${v.salario}`);
    if (v.turno) linhas.push(`🕐 Horário/Escala: ${v.turno}`);
    if (v.beneficios) linhas.push(`🎁 Benefícios: ${v.beneficios}`);
    if (v.genero) linhas.push(`👥 Gênero: ${v.genero}`);
    if (v.experiencia) linhas.push(`⭐ Experiência: ${v.experiencia}`);
    if (v.escolaridade) linhas.push(`🎓 Escolaridade: ${v.escolaridade}`);
    if (v.requisitos) linhas.push(`📋 Requisitos: ${v.requisitos}`);

    return linhas.join("\n");
  }).join("\n\n");
}

async function enviarListaDeVagas(from, vagas, mensagemInicial) {
  const tamanhoBloco = 5;

  for (let i = 0; i < vagas.length; i += tamanhoBloco) {
    const bloco = vagas.slice(i, i + tamanhoBloco);
    const texto = formatarVagasParaLia(bloco, i);

    const mensagem = i === 0
      ? `${mensagemInicial}\n\n${texto}`
      : `Continuando as opções encontradas:\n\n${texto}`;

    await sendWhatsAppMessage(from, mensagem);
  }

  await sendWhatsAppMessage(from, "Alguma dessas vagas chamou sua atenção? Pode me responder com o número da vaga. 😊");
}

function formatarVagaDetalhada(vaga) {
  const linhas = [
    `*${vaga.cargo}*`,
    `🏢 Empresa: ${vaga.empresa || "Empresa confidencial"}`,
    `📍 Local: ${vaga.cidade || "Não informado"}`,
  ];

  if (vaga.salario) linhas.push(`💰 Salário: ${vaga.salario}`);
  if (vaga.turno) linhas.push(`🕐 Horário/Escala: ${vaga.turno}`);
  if (vaga.beneficios) linhas.push(`🎁 Benefícios: ${vaga.beneficios}`);
  if (vaga.genero) linhas.push(`👥 Gênero: ${vaga.genero}`);
  if (vaga.faixaEtaria) linhas.push(`🎂 Faixa etária: ${vaga.faixaEtaria}`);
  if (vaga.experiencia) linhas.push(`⭐ Experiência mínima: ${vaga.experiencia}`);
  if (vaga.escolaridade) linhas.push(`🎓 Escolaridade: ${vaga.escolaridade}`);
  if (vaga.requisitos) linhas.push(`📋 Requisitos: ${vaga.requisitos}`);
  if (vaga.descricao) linhas.push(`📝 Atividades: ${vaga.descricao}`);

  return linhas.join("\n");
}

function detectarInteresseVaga(texto, totalVagas) {
  const t = normalizarTexto(texto);

  const semInteresse = ["nenhuma", "nao", "não", "nenhum", "outra", "outras", "outro", "nada", "nao gostei", "não gostei"];
  if (semInteresse.some(p => t.includes(p))) return { interesse: false };

  const matchNumero = t.match(/\d+/);
  if (matchNumero) {
    const num = parseInt(matchNumero[0], 10);
    if (num >= 1 && num <= totalVagas) return { interesse: true, numero: num };
  }

  const positivos = ["sim", "quero", "tenho interesse", "gostei", "legal", "essa", "me interessa"];
  if (positivos.some(p => t.includes(p))) return { interesse: true, numero: 1 };

  return null;
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
Retorne APENAS o JSON.

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

async function notificarInteresseVaga(telefone, nome, vaga) {
  try {
    const horario = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    await sendWhatsAppMessage(
      NUMERO_THIARATAFF,
      `🚨 *Candidato interessado em vaga*\n\n👤 *Candidato:* ${nome || "Não informado"}\n📱 *WhatsApp:* +${telefone}\n\n💼 *Vaga:* ${vaga.cargo || "Não informada"}\n🏢 *Empresa:* ${vaga.empresa || "Não informada"}\n📍 *Local:* ${vaga.cidade || "Não informado"}\n💰 *Salário:* ${vaga.salario || "Não informado"}\n🕐 *Horário/Escala:* ${vaga.turno || "Não informado"}\n🎓 *Escolaridade:* ${vaga.escolaridade || "Não informada"}\n📋 *Requisitos:* ${vaga.requisitos || "Não informado"}\n\n🕐 *Horário do interesse:* ${horario}`
    );
  } catch (e) {
    console.error("Erro ao notificar interesse em vaga:", e.message);
  }
}

const conversationHistory = {};
const conversationState = {};

const SYSTEM_PROMPT = `
Você é Lia, da Effect Pessoas & Performance.

A Effect é uma consultoria especializada em Recrutamento e Seleção, Hunting, Desenvolvimento de Pessoas, Consultoria em RH e Cargos e Salários.

IDENTIDADE:
- Você é humana, acolhedora, profissional e objetiva.
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Fale como uma recrutadora experiente.
- Seja leve, simpática e organizada.
- Use emojis com moderação.

REGRAS:
- Faça apenas UMA pergunta por vez.
- Nunca transforme a conversa em formulário.
- Nunca peça currículo antes de verificar vagas.
- Nunca invente vagas, salários, benefícios ou requisitos.
`;

app.get("/", (req, res) => res.send("Effect WhatsApp Bot rodando!"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function apresentarVagasComFiltros(from, state) {
  let vagas = await buscarVagasCompativeis(state.areaInteresse, {
    turno: state.turnoPreferido,
    experiencia: state.experienciaPreferida,
    escolaridade: state.escolaridadePreferida,
  });

  vagas = ordenarVagasPorRegiao(vagas, state.cidadePreferida);

  if (vagas.length > 0) {
    const regiao = identificarRegiao(state.cidadePreferida);
    const intro = `Encontrei estas oportunidades compatíveis, começando pelas opções mais próximas de ${state.cidadePreferida}${regiao ? ` / ${regiao}` : ""}:`;

    state.vagasApresentadas = true;
    state.vagasCache = vagas;
    state.aguardandoInteresse = true;

    await enviarListaDeVagas(from, vagas, intro);
    return true;
  }

  let vagasSemFiltro = await buscarVagasCompativeis(state.areaInteresse, {});
  vagasSemFiltro = ordenarVagasPorRegiao(vagasSemFiltro, state.cidadePreferida);

  if (vagasSemFiltro.length > 0) {
    state.vagasApresentadas = true;
    state.vagasCache = vagasSemFiltro;
    state.aguardandoInteresse = true;

    await enviarListaDeVagas(
      from,
      vagasSemFiltro,
      "Não encontrei vagas exatamente com todos os filtros, mas encontrei estas opções próximas ao seu perfil:"
    );
    return true;
  }

  state.aguardandoCurriculo = true;

  await sendWhatsAppMessage(
    from,
    "No momento não encontrei uma vaga compatível com esses dados, mas posso deixar seu currículo no nosso banco de talentos 💙\n\nVocê pode me enviar seu currículo por aqui?"
  );

  return false;
}

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
        cidade: dados[2] || state.cidadePreferida || "",
        area: dados[3] || state.areaInteresse || "",
        curriculo: "Sim",
        score: calcularScore({
          nome: dados[1],
          cidade: dados[2] || state.cidadePreferida,
          area: dados[3] || state.areaInteresse,
          curriculo: "Sim",
        }),
        status: "Currículo recebido",
        obs: linkDrive ? `Drive: ${linkDrive}` : `Arquivo: ${fileName}`,
        vaga_interesse: state.vagaInteresse || "",
      });

      await notificarCurriculoRecebido(from, dados[1], fileName, linkDrive);

      await sendWhatsAppMessage(
        from,
        "Perfeito, recebi seu currículo com sucesso! 💙 Nossa equipe vai analisar seu perfil e entraremos em contato para prosseguirmos caso atenda aos requisitos da vaga."
      );

      state.encerrado = true;
      return res.sendStatus(200);
    }

    if (state.etapaFiltro === "cidade") {
      state.cidadePreferida = text;
      state.etapaFiltro = "turno";
      conversationHistory[from].push({ role: "user", content: text });

      await sendWhatsAppMessage(from, "Perfeito. Você prefere vagas de dia, à noite ou tanto faz?");
      return res.sendStatus(200);
    }

    if (state.etapaFiltro === "turno") {
      state.turnoPreferido = detectarTurno(text) || "tanto faz";
      state.etapaFiltro = "experiencia";
      conversationHistory[from].push({ role: "user", content: text });

      await sendWhatsAppMessage(from, "Entendi. Você já tem experiência na área ou busca oportunidade sem experiência?");
      return res.sendStatus(200);
    }

    if (state.etapaFiltro === "experiencia") {
      state.experienciaPreferida = detectarExperiencia(text) || "tanto faz";
      state.etapaFiltro = "escolaridade";
      conversationHistory[from].push({ role: "user", content: text });

      await sendWhatsAppMessage(from, "Qual é a sua escolaridade? Pode responder, por exemplo: fundamental, médio completo, técnico, superior cursando ou superior completo.");
      return res.sendStatus(200);
    }

    if (state.etapaFiltro === "escolaridade") {
      state.escolaridadePreferida = detectarEscolaridade(text) || "tanto faz";
      state.etapaFiltro = null;
      conversationHistory[from].push({ role: "user", content: text });

      await apresentarVagasComFiltros(from, state);
      return res.sendStatus(200);
    }

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
        conversationHistory[from].push({ role: "user", content: text });

        const msg = "Tudo bem! 😊 Fico à disposição sempre que precisar. Qualquer novidade em vagas, estaremos aqui. Tenha um ótimo dia! 💙";
        conversationHistory[from].push({ role: "assistant", content: msg });

        await sendWhatsAppMessage(from, msg);
        state.encerrado = true;
        return res.sendStatus(200);
      }
    }

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
        state.vagaInteresse = vagaEscolhida.cargo;

        const candidato = await buscarCandidato(from);
        const nomeCandidato = candidato?.dados?.[1] || "";

        await salvarCandidato(from, {
          vaga_interesse: vagaEscolhida.cargo,
          status: "Interessado",
          cidade: state.cidadePreferida || "",
          area: state.areaInteresse || "",
          obs: `Turno: ${state.turnoPreferido || ""} | Experiência: ${state.experienciaPreferida || ""} | Escolaridade: ${state.escolaridadePreferida || ""}`,
        });

        await notificarInteresseVaga(from, nomeCandidato, vagaEscolhida);

        return res.sendStatus(200);
      }

      if (resultado && !resultado.interesse) {
        state.aguardandoInteresse = false;
        state.vagasCache = null;
        state.vagasApresentadas = false;
        state.etapaFiltro = "cidade";

        await sendWhatsAppMessage(from, "Tudo bem! 😊 Vamos tentar buscar de outra forma. Qual cidade ou região você prefere?");
        return res.sendStatus(200);
      }
    }

    if (state.aguardandoCurriculo && !isDocument && !isImage) {
      const t = normalizarTexto(text);
      const nao = ["nao", "não", "agora nao", "agora não", "depois", "obrigado", "valeu", "tchau", "nao tenho", "não tenho"].some(p => t.includes(p));

      if (nao) {
        const msg = "Sem problema! 😊 Quando quiser, é só nos chamar. Desejo muito sucesso na sua jornada profissional! 💙";
        await sendWhatsAppMessage(from, msg);
        state.encerrado = true;
        return res.sendStatus(200);
      }
    }

    conversationHistory[from].push({ role: "user", content: text });

    if (conversationHistory[from].length > 20) {
      conversationHistory[from] = conversationHistory[from].slice(-20);
    }

    const dadosExtraidos = await extrairDadosDaConversa(conversationHistory[from]);

    await salvarCandidato(from, {
      ...dadosExtraidos,
      score: calcularScore(dadosExtraidos),
    });

    if (!state.areaInteresse) state.areaInteresse = dadosExtraidos?.area || text;
    if (!state.cidadePreferida && dadosExtraidos?.cidade) state.cidadePreferida = dadosExtraidos.cidade;
    if (!state.turnoPreferido) state.turnoPreferido = detectarTurno(text);
    if (!state.experienciaPreferida) state.experienciaPreferida = detectarExperiencia(text);
    if (!state.escolaridadePreferida) state.escolaridadePreferida = detectarEscolaridade(text);

    if (state.areaInteresse && !state.vagasApresentadas) {
      if (!state.cidadePreferida) {
        state.etapaFiltro = "cidade";
        await sendWhatsAppMessage(from, "Perfeito. Para eu buscar as melhores opções, qual cidade ou região você prefere trabalhar?");
        return res.sendStatus(200);
      }

      if (!state.turnoPreferido) {
        state.etapaFiltro = "turno";
        await sendWhatsAppMessage(from, "Você prefere vagas de dia, à noite ou tanto faz?");
        return res.sendStatus(200);
      }

      if (!state.experienciaPreferida) {
        state.etapaFiltro = "experiencia";
        await sendWhatsAppMessage(from, "Você já tem experiência na área ou busca uma oportunidade sem experiência?");
        return res.sendStatus(200);
      }

      if (!state.escolaridadePreferida) {
        state.etapaFiltro = "escolaridade";
        await sendWhatsAppMessage(from, "Qual é a sua escolaridade? Pode responder, por exemplo: fundamental, médio completo, técnico, superior cursando ou superior completo.");
        return res.sendStatus(200);
      }

      await apresentarVagasComFiltros(from, state);
      return res.sendStatus(200);
    }

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
