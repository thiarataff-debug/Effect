/**
 * NF Processor - Extrai dados de PDFs de notas fiscais automaticamente
 * Integração com Claude API para IA
 * Salva em Google Sheets
 */

const pdfParse = require("pdf-parse");
const axios = require("axios");

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Extrair texto do PDF
// ═══════════════════════════════════════════════════════════════════════════
async function extrairTextoPDF(bufferPDF) {
  try {
    const dados = await pdfParse(bufferPDF);
    return dados.text;
  } catch (erro) {
    console.error("❌ Erro ao extrair PDF:", erro.message);
    throw new Error("Falha ao ler PDF");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Usar Claude IA para extrair dados estruturados
// ═══════════════════════════════════════════════════════════════════════════
async function extrairDadosComClaude(textoPDF, claudeApiKey) {
  const prompt = `
Você é um especialista em leitura de notas fiscais.
Analise o seguinte texto de uma nota fiscal e extraia EXATAMENTE estes dados em JSON:

{
  "numeroNota": "número da nota fiscal",
  "cliente": "nome do cliente/empresa",
  "valorNota": número decimal (ex: 1234.56),
  "primeiroVencimento": "data em formato dd/mm/yyyy",
  "segundoVencimento": "data em formato dd/mm/yyyy ou null",
  "terceiroVencimento": "data em formato dd/mm/yyyy ou null",
  "quartoVencimento": "data em formato dd/mm/yyyy ou null"
}

REGRAS IMPORTANTES:
- Se não encontrar o campo, use null
- valorNota SEMPRE sem vírgulas, apenas ponto decimal
- Datas no formato DD/MM/YYYY
- Se houver parcelas, extraia as datas de cada uma

TEXTO DA NF:
${textoPDF}

Responda APENAS com o JSON, sem explicações adicionais.`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      },
      {
        headers: {
          "x-api-key": claudeApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const conteudo = response.data.content[0].text;
    const jsonMatch = conteudo.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("Claude não retornou JSON válido");
    }

    return JSON.parse(jsonMatch[0]);
  } catch (erro) {
    console.error("❌ Erro ao chamar Claude:", erro.message);
    throw new Error("Falha ao processar com IA");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Calcular em qual mês a comissão cai
// ═══════════════════════════════════════════════════════════════════════════
function calcularMesComissao(dataVencimentoStr) {
  if (!dataVencimentoStr) return null;

  // Parse data no formato dd/mm/yyyy
  const [dia, mes, ano] = dataVencimentoStr.split("/").map(Number);

  let diaNum = dia;
  let mesComissao = mes;
  let anoComissao = ano;

  // Se vencimento >= 16, comissão cai no próximo mês
  if (diaNum >= 16) {
    mesComissao += 1;
    if (mesComissao > 12) {
      mesComissao = 1;
      anoComissao += 1;
    }
  }

  // Formatar mês por extenso
  const meses = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];

  const dataPagamento = `15/${String(mesComissao).padStart(2, "0")}/${anoComissao}`;

  return {
    mes: meses[mesComissao - 1],
    mesNum: mesComissao,
    ano: anoComissao,
    dataPagamento: dataPagamento,
    mesExtenso: `${meses[mesComissao - 1]}/${anoComissao}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Calcular comissão (3%)
// ═══════════════════════════════════════════════════════════════════════════
function calcularComissao(valor) {
  return parseFloat((valor * 0.03).toFixed(2));
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÃO PRINCIPAL: Processar NF
// ═══════════════════════════════════════════════════════════════════════════
async function processarNotaFiscal(bufferPDF, claudeApiKey) {
  console.log("🔄 Processando nota fiscal...");

  // 1. Extrair texto do PDF
  const textoPDF = await extrairTextoPDF(bufferPDF);
  console.log("✓ PDF lido com sucesso");

  // 2. Usar Claude para extrair dados
  const dadosExtraidos = await extrairDadosComClaude(textoPDF, claudeApiKey);
  console.log("✓ Dados extraídos com sucesso:", dadosExtraidos);

  // 3. Calcular comissões e meses para cada vencimento
  const vencimentos = [];
  const vencimentosRaw = [
    dadosExtraidos.primeiroVencimento,
    dadosExtraidos.segundoVencimento,
    dadosExtraidos.terceiroVencimento,
    dadosExtraidos.quartoVencimento,
  ];

  for (const venc of vencimentosRaw) {
    if (venc) {
      const mesComissao = calcularMesComissao(venc);
      vencimentos.push({
        data: venc,
        comissaoParcial: calcularComissao(
          dadosExtraidos.valorNota / vencimentosRaw.filter((v) => v).length
        ),
        mesComissao: mesComissao,
      });
    }
  }

  // 4. Retornar dados estruturados
  const resultado = {
    numeroNota: dadosExtraidos.numeroNota,
    cliente: dadosExtraidos.cliente,
    valorNota: dadosExtraidos.valorNota,
    comissaoTotal: calcularComissao(dadosExtraidos.valorNota),
    vencimentos: vencimentos,
    resumo: {
      totalParcelas: vencimentos.length,
      comissaoPorParcela: calcularComissao(
        dadosExtraidos.valorNota / vencimentos.length
      ),
    },
    processadoEm: new Date().toISOString(),
  };

  console.log("✓ Processamento concluído");
  return resultado;
}

module.exports = {
  processarNotaFiscal,
  extrairTextoPDF,
  extrairDadosComClaude,
  calcularMesComissao,
  calcularComissao,
};
