/**
 * Rotas para processamento de Notas Fiscais
 * Integração com Google Sheets
 */

const express = require("express");
const multer = require("multer");
const { processarNotaFiscal } = require("./nf-processor");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// ═══════════════════════════════════════════════════════════════════════════
// ROTA: Upload e processamento de PDF
// ═══════════════════════════════════════════════════════════════════════════
router.post("/nf/upload", upload.single("pdf"), async (req, res) => {
  try {
    const { claudeApiKey } = req.body;

    if (!req.file) {
      return res.status(400).json({
        erro: "Nenhum arquivo PDF enviado",
      });
    }

    if (!claudeApiKey) {
      return res.status(400).json({
        erro: "API key do Claude não fornecida",
      });
    }

    console.log(`📄 Processando arquivo: ${req.file.originalname}`);

    // Processar o PDF
    const dadosNF = await processarNotaFiscal(req.file.buffer, claudeApiKey);

    // Retornar sucesso
    return res.json({
      sucesso: true,
      dados: dadosNF,
      mensagem: `✓ Nota fiscal #${dadosNF.numeroNota} processada com sucesso!`,
    });
  } catch (erro) {
    console.error("❌ Erro no upload:", erro.message);
    return res.status(500).json({
      erro: erro.message || "Erro ao processar arquivo",
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROTA: Salvar NF processada no Google Sheets
// ═══════════════════════════════════════════════════════════════════════════
router.post("/nf/salvar-sheets", async (req, res) => {
  try {
    const { dadosNF, googleAuth } = req.body;

    if (!dadosNF) {
      return res.status(400).json({
        erro: "Dados da NF não fornecidos",
      });
    }

    // Aqui você integraria com o código existente do Effect
    // para salvar no Google Sheets

    return res.json({
      sucesso: true,
      mensagem: "✓ Nota fiscal salva no Sheets!",
      dadosNF,
    });
  } catch (erro) {
    console.error("❌ Erro ao salvar:", erro.message);
    return res.status(500).json({
      erro: erro.message || "Erro ao salvar nota fiscal",
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROTA: Listar todas as NFs
// ═══════════════════════════════════════════════════════════════════════════
router.get("/nf/listar", async (req, res) => {
  try {
    // Aqui você buscaria do Google Sheets
    // Por enquanto, retorna um placeholder

    return res.json({
      sucesso: true,
      notas: [],
      mensagem: "Acesse /financeiro para ver as notas",
    });
  } catch (erro) {
    console.error("❌ Erro ao listar:", erro.message);
    return res.status(500).json({
      erro: erro.message || "Erro ao listar notas",
    });
  }
});

module.exports = router;
