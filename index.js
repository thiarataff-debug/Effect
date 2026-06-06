const express = require("express");
const axios = require("axios");
const pdfParse = require("pdf-parse");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 3000;

const CONFIG = {
  CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "effect_lia_2026",
  VAGAS_URL: process.env.VAGAS_URL
};

const sessoes = {};

app.get("/", (req, res) => {
  res.send("Lia Effect rodando com Meta WhatsApp ✅");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;

    if (message.text?.body) {
      const resposta = await processarMensagem(from, message.text.body);
      await enviarMensagem(from, resposta);
      return;
    }

    if (message.document) {
      await enviarMensagem(from, "Perfeito, recebi seu currículo. Vou analisar as informações agora. 💙");

      const resposta = await processarCurriculo(from, message.document);
      await enviarMensagem(from, resposta);
      return;
    }

    await enviarMensagem(
      from,
      "Recebi sua mensagem. Pode me enviar em texto ou encaminhar o currículo em PDF por aqui?"
    );

  } catch (erro) {
    console.error("Erro no webhook:", JSON.stringify(erro.response?.data || erro.message));
  }
});

async function processarMensagem(telefone, mensagem) {
  if (!sessoes[telefone]) {
    sessoes[telefone] = { historico: [] };
  }

  const sessao = sessoes[telefone];

  sessao.historico.push({
    role: "user",
    content: mensagem
  });

  sessao.historico = sessao.historico.slice(-10);

  const vagas = await buscarVagas();
  const prompt = montarPromptConversa(sessao, mensagem, vagas);
  const resposta = await chamarClaude(prompt);

  sessao.historico.push({
    role: "assistant",
    content: resposta
  });

  sessao.historico = sessao.historico.slice(-10);

  return resposta;
}

async function processarCurriculo(telefone, documento) {
  try {
    const textoCurriculo = await baixarELerPdf(documento.id);

    if (!textoCurriculo || textoCurriculo.length < 50) {
      return "Recebi o currículo, mas não consegui ler bem o conteúdo do arquivo. Pode me enviar em PDF com texto legível ou me mandar um resumo da sua experiência por aqui?";
    }

    const vagas = await buscarVagas();
    const sessao = sessoes[telefone] || { historico: [] };

    const vagasFiltradas = filtrarVagasRelevantes(
      vagas,
      textoCurriculo,
      sessao.historico
    ).slice(0, 5);

    const prompt = montarPromptAnaliseCurriculo(textoCurriculo, vagasFiltradas);

    const resposta = await chamarClaude(prompt);

    if (!sessoes[telefone]) sessoes[telefone] = { historico: [] };

    sessoes[telefone].historico.push({
      role: "user",
      content: "[Currículo PDF recebido]"
    });

    sessoes[telefone].historico.push({
      role: "assistant",
      content: resposta
    });

    sessoes[telefone].historico = sessoes[telefone].historico.slice(-10);

    return resposta;

  } catch (erro) {
    console.error("Erro ao processar currículo:", JSON.stringify(erro.response?.data || erro.message));
    return "Recebi seu currículo, mas tive dificuldade para fazer a leitura automática agora. Ele ficou registrado na conversa e podemos seguir com algumas perguntas rápidas por aqui. Qual foi sua última experiência profissional?";
  }
}

async function baixarELerPdf(mediaId) {
  const mediaInfo = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    {
      headers: {
        Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`
      },
      timeout: 15000
    }
  );

  const mediaUrl = mediaInfo.data.url;

  const arquivo = await axios.get(mediaUrl, {
    headers: {
      Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`
    },
    responseType: "arraybuffer",
    timeout: 30000
  });

  const buffer = Buffer.from(arquivo.data);
  const pdfData = await pdfParse(buffer);

  return String(pdfData.text || "").slice(0, 12000);
}

async function buscarVagas() {
  try {
    if (!CONFIG.VAGAS_URL) {
      console.error("Erro Vagas: VAGAS_URL ausente");
      return [];
    }

    const response = await axios.get(CONFIG.VAGAS_URL, { timeout: 15000 });
    return response.data?.vagas || [];
  } catch (erro) {
    console.error("Erro ao buscar vagas:", JSON.stringify(erro.response?.data || erro.message));
    return [];
  }
}

function normalizarTexto(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function filtrarVagasRelevantes(vagas, texto, historico) {
  const textoBusca = normalizarTexto(
    texto + " " + historico.map(h => h.content).join(" ")
  );

  const vagasComScore = vagas.map(vaga => {
    const textoVaga = normalizarTexto([
      vaga.cargo,
      vaga.area,
      vaga.cidade,
      vaga.perfilResumido,
      vaga.palavrasChave,
      vaga.requisitosDaVaga,
      vaga.requisitoObrigatorio
    ].join(" "));

    let score = 0;

    const palavras = textoBusca
      .split(/\s+/)
      .filter(p => p.length >= 4)
      .slice(0, 80);

    palavras.forEach(palavra => {
      if (textoVaga.includes(palavra)) score++;
    });

    return { vaga, score };
  });

  const filtradas = vagasComScore
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(item => item.vaga);

  return filtradas.length > 0 ? filtradas : vagas.slice(0, 8);
}

function resumirVagas(vagas) {
  return vagas.map(vaga => ({
    cargo: vaga.cargo,
    cidade: vaga.cidade,
    horario: vaga.horario,
    beneficios: vaga.beneficios,
    escolaridade: vaga.escolaridade,
    experienciaMinima: vaga.experienciaMinima,
    requisitoObrigatorio: vaga.requisitoObrigatorio,
    aceitaSemExperiencia: vaga.aceitaSemExperiencia,
    perfilResumido: vaga.perfilResumido,
    palavrasChave: vaga.palavrasChave
  }));
}

function montarPromptConversa(sessao, mensagemAtual, vagas) {
  const vagasFiltradas = filtrarVagasRelevantes(vagas, mensagemAtual, sessao.historico);
  const vagasResumidas = resumirVagas(vagasFiltradas);

  const historicoCurto = sessao.historico
    .slice(-8)
    .map(h => `${h.role}: ${h.content}`)
    .join("\n");

  return `
Você é a Lia, da Effect Pessoas e Performance.

REGRAS:
- Nunca diga que é robô, IA, chatbot ou assistente virtual.
- Nunca use menu numérico.
- Faça somente uma pergunta por vez.
- Não repita "Eu sou a Lia" se a conversa já começou.
- Seja humana, acolhedora, organizada, profissional e leve.
- Responda curto, como WhatsApp.

ABERTURA:
Se for o primeiro contato e a pessoa ainda não informou o nome, responda:
"Olá, que bom falar com você. Eu sou a Lia, da Effect. Antes de começarmos, qual é o seu nome?"

COLETA:
Colete aos poucos: nome, cidade/bairro, área ou vaga, experiência, escolaridade, disponibilidade e currículo.

VAGAS RELEVANTES:
${JSON.stringify(vagasResumidas, null, 2)}

HISTÓRICO RECENTE:
${historicoCurto}

MENSAGEM ATUAL:
${mensagemAtual}

Responda somente a próxima mensagem da Lia.
`;
}

function montarPromptAnaliseCurriculo(textoCurriculo, vagas) {
  const vagasResumidas = resumirVagas(vagas);

  return `
Você é a Lia, da Effect Pessoas e Performance.

Analise o currículo abaixo e compare com as vagas disponíveis.

REGRAS:
- Seja cuidadosa e profissional.
- Não prometa contratação.
- Não diga "excelente" se faltar experiência ou requisito obrigatório.
- Se houver aderência, diga que o perfil tem aderência inicial e seguirá para análise.
- Se não houver aderência, diga de forma acolhedora que manteremos o cadastro para oportunidades compatíveis.
- Responda em mensagem curta de WhatsApp.
- Não exponha análise técnica longa para o candidato.

VAGAS PARA COMPARAR:
${JSON.stringify(vagasResumidas, null, 2)}

CURRÍCULO:
${textoCurriculo}

Responda ao candidato de forma humana, curta e clara.
`;
}

async function chamarClaude(prompt) {
  try {
    if (!CONFIG.CLAUDE_API_KEY) {
      console.error("Erro Claude: CLAUDE_API_KEY ausente");
      return "Tive uma instabilidade aqui. Pode me mandar novamente?";
    }

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        temperature: 0.4,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      },
      {
        headers: {
          "x-api-key": CONFIG.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        timeout: 30000
      }
    );

    return response.data?.content?.[0]?.text || "Tive uma instabilidade aqui. Pode me mandar novamente?";
  } catch (erro) {
    console.error("Erro Claude:", JSON.stringify(erro.response?.data || erro.message));

    const mensagemErro = JSON.stringify(erro.response?.data || erro.message);

    if (mensagemErro.includes("rate_limit")) {
      return "Estou processando suas informações, só preciso de um instantinho. Pode me responder novamente em alguns segundos?";
    }

    return "Tive uma instabilidade aqui. Pode me mandar novamente?";
  }
}

async function enviarMensagem(to, body) {
  try {
    if (!CONFIG.META_ACCESS_TOKEN) {
      console.error("Erro Meta: META_ACCESS_TOKEN ausente");
      return;
    }

    if (!CONFIG.PHONE_NUMBER_ID) {
      console.error("Erro Meta: PHONE_NUMBER_ID ausente");
      return;
    }

    await axios.post(
      `https://graph.facebook.com/v20.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          preview_url: false,
          body
        }
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.META_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );
  } catch (erro) {
    console.error("Erro ao enviar WhatsApp:", JSON.stringify(erro.response?.data || erro.message));
  }
}

app.listen(PORT, () => {
  console.log(`Lia rodando na porta ${PORT} - currículo PDF ativo`);
});
