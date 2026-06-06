const SHEET_ID = "1Bqrwjjy0JwAVouppOg-LGCENrYrTsQCYrqntCBf9mSk";

function doGet(e) {
  const acao = e.parameter.acao;

  if (acao === "vagas") {
    return buscarVagas(e);
  }

  if (acao === "candidato") {
    return buscarCandidato(e);
  }

  return jsonResponse({
    sucesso: false,
    erro: "Ação inválida. Use ?acao=vagas ou ?acao=candidato"
  });
}

function buscarVagas(e) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName("VAGAS");

  if (!sheet) {
    return jsonResponse({
      sucesso: false,
      erro: "Aba VAGAS não encontrada"
    });
  }

  const dados = sheet.getDataRange().getValues();
  const cabecalho = dados[0];

  const vagas = [];

  for (let i = 1; i < dados.length; i++) {
    const linha = dados[i];

    const vaga = {
      idVaga: getValor(cabecalho, linha, "ID Vaga"),
      cliente: getValor(cabecalho, linha, "Cliente"),
      cargo: getValor(cabecalho, linha, "Cargo"),
      area: getValor(cabecalho, linha, "Área/Setor"),
      cidade: getValor(cabecalho, linha, "Cidade/Bairro"),
      horario: getValor(cabecalho, linha, "Escala/Horário"),
      salario: getValor(cabecalho, linha, "Salário Base"),
      beneficios: getValor(cabecalho, linha, "Benefícios"),
      genero: getValor(cabecalho, linha, "Gênero"),
      faixaEtaria: getValor(cabecalho, linha, "Faixa Etária"),
      experienciaMinima: getValor(cabecalho, linha, "Exp. Mínima"),
      perfilResumido: getValor(cabecalho, linha, "Perfil Resumido"),
      palavrasChave: getValor(cabecalho, linha, "Palavras-chave"),
      status: getValor(cabecalho, linha, "Status"),
      observacoes: getValor(cabecalho, linha, "Observações"),

      requisitoObrigatorio: getValor(cabecalho, linha, "Requisito Obrigatório"),
      aceitaSemExperiencia: getValor(cabecalho, linha, "Aceita Sem Experiência"),
      exigeFimDeSemana: getValor(cabecalho, linha, "Exige Fim de Semana"),
      exigeTransporteProprio: getValor(cabecalho, linha, "Exige Transporte Próprio"),
      exigeCltImediato: getValor(cabecalho, linha, "Exige CLT Imediato")
    };

    if (vaga.cargo && vaga.status.toString().toLowerCase() !== "inativa") {
      vagas.push(vaga);
    }
  }

  return jsonResponse({
    sucesso: true,
    total: vagas.length,
    vagas: vagas
  });
}

function buscarCandidato(e) {
  const telefone = e.parameter.telefone;

  if (!telefone) {
    return jsonResponse({
      sucesso: false,
      erro: "Telefone não informado"
    });
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName("Candidatos");

  if (!sheet) {
    return jsonResponse({
      sucesso: false,
      erro: "Aba Candidatos não encontrada"
    });
  }

  const dados = sheet.getDataRange().getValues();
  const cabecalho = dados[0];

  for (let i = 1; i < dados.length; i++) {
    const linha = dados[i];
    const telefoneLinha = getValor(cabecalho, linha, "Telefone");

    if (normalizarTelefone(telefoneLinha) === normalizarTelefone(telefone)) {
      return jsonResponse({
        sucesso: true,
        encontrado: true,
        candidato: montarObjeto(cabecalho, linha)
      });
    }
  }

  return jsonResponse({
    sucesso: true,
    encontrado: false
  });
}

function getValor(cabecalho, linha, nomeColuna) {
  const index = cabecalho.indexOf(nomeColuna);
  if (index === -1) return "";
  return linha[index] || "";
}

function montarObjeto(cabecalho, linha) {
  const obj = {};
  cabecalho.forEach((coluna, index) => {
    obj[coluna] = linha[index] || "";
  });
  return obj;
}

function normalizarTelefone(valor) {
  return String(valor || "").replace(/\D/g, "");
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
