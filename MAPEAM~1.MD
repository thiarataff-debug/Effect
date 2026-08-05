# 🔍 Mapeamento: Para onde vão as vagas do Restaurante Santuzzi?

## 📋 Resumo Executivo
As informações das vagas lançadas pelos clientes (incluindo Restaurante Santuzzi) são armazenadas em um **Google Apps Script** (não no Google Sheets diretamente). Este documento mapeia o fluxo completo.

---

## 🏗️ Arquitetura Geral

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  1. CLIENTE preenche formulário (divulgacao.html)              │
│     └─ Restaurante Santuzzi → Portal do Cliente                │
│                                                                 │
│  2. DADOS enviados para backend (index.js)                     │
│     └─ POST /cliente/solicitar                                 │
│                                                                 │
│  3. BACKEND envia para Google Apps Script                       │
│     └─ axios.post(CONFIG.VAGAS_URL, {...})                    │
│        └─ acao: "salvarAnalise"                                │
│                                                                 │
│  4. GOOGLE APPS SCRIPT processa e salva em Google Sheets       │
│     └─ Planilha ID: 1Bqrwjjy0JwAVouppOg-LGCENrYrTsQCYrqn...   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📍 Locais de Armazenamento

### 1. **Google Apps Script URL** (CRÍTICO)
- **Variável:** `CONFIG.VAGAS_URL` (em `index.js`, linha 63)
- **Tipo:** URL de um Google Apps Script (não visível no código)
- **Definição:** Variável de ambiente do Railway
- **Estado:** ⚠️ **NÃO CONFIGURADA no arquivo source** — é passada via Railway
- **Função:** Recebe POST com ação `"salvarAnalise"` e salva os dados

### 2. **Google Sheets**
- **ID da Planilha:** `1Bqrwjjy0JwAVouppOg-LGCENrYrTsQCYrqntCBf9mSk` (linha 70)
- **Origem:** Apps Script acessa essa planilha para ler/escrever vagas
- **Abas esperadas:** Provavelmente algo como:
  - `Vagas` — vagas ativas disponíveis (para matching)
  - `Conversas` — histórico de interações
  - Possivelmente uma aba com vagas dos clientes (salvas pelo Apps Script)

### 3. **Banco de dados local (Railway Volume)**
- **Caminho:** `/data/contratos.json`
- **Backup:** `/tmp/contratos.json` (se volume não estiver montado)
- **Conteúdo:** Informações de contratos (incluindo vagas solicitadas)

---

## 📤 Fluxo de Envio: Vaga do Restaurante Santuzzi

### Passo 1: Cliente preenche formulário (divulgacao.html)
A página apresenta campos como:
```
- Empresa cliente: Restaurante Santuzzi
- Cargo: [Garçom, Cozinheiro, etc.]
- Cidade: [Vitória, Serra, etc.]
- Salário: [R$ X.XXX]
- Horário: [Full-time, Part-time, etc.]
- Benefícios: [Lista]
- Responsabilidades: [Texto]
- Requisitos: [Texto]
```

### Passo 2: Backend recebe (index.js:3898)
```javascript
app.post("/cliente/solicitar", async (req, res) => {
  const d = req.body;  // recebe dados do cliente
  const vagas = Array.isArray(d.vagas) ? d.vagas : [{
    cargo: d.vaga_cargo,
    quantidade: d.vaga_quantidade,
    cidade: d.vaga_cidade,
    salario: d.vaga_salario,
    horario: d.vaga_horario,
    beneficios: d.vaga_beneficios,
    beneficios_outros: d.vaga_beneficios_outros,
    responsabilidades: d.vaga_responsabilidades,
    requisitos: d.vaga_requisitos
  }];
  
  const registro = { ...d, vagas, contratoId, criadoEm: new Date().toISOString() };
  salvarContrato(registro);  // salva em /data/contratos.json
  
  // ENVIA PARA GOOGLE APPS SCRIPT:
  for (const v of vagas) {
    await axios.post(urlBase, {
      acao: "salvarAnalise",
      cargo: v.cargo,
      cliente: d.empresa_nome,  // "Restaurante Santuzzi"
      cidade: v.cidade,
      salario: v.salario,
      horario: v.horario,
      beneficios: v.beneficios,
      responsabilidades: v.responsabilidades,
      requisitos: v.requisitos,
      escolaridade: d.perfil_escolaridade,
      experiencia: d.perfil_experiencia,
      contato: d.responsavel_whatsapp,
      origem: "Portal do Cliente"
    }, { timeout: 15000 });
  }
});
```

### Passo 3: Apps Script salva na planilha
O Google Apps Script (URL não visível no source):
1. Recebe o POST com `acao: "salvarAnalise"`
2. Adiciona uma nova linha na planilha do Google Sheets
3. Armazena: cargo, cliente (Santuzzi), cidade, salário, horário, beneficios, requisitos, etc.

---

## 🔎 Onde Buscar as Vagas do Santuzzi?

### Opção 1: Google Sheets (mais fácil)
1. Abra: https://docs.google.com/spreadsheets/d/`1Bqrwjjy0JwAVouppOg-LGCENrYrTsQCYrqntCBf9mSk`
2. Procure pela aba que contém as vagas dos clientes
3. Filtre por `cliente = "Restaurante Santuzzi"`
4. ✅ As vagas devem estar lá (se a integração do Apps Script estiver funcionando)

### Opção 2: Arquivo de contratos (local)
- **Arquivo:** `contratos.json` (em `/data/` no Railway ou `./data/` localmente)
- **Formato:** JSON com array de contratos
- **Buscar:** Procure por `"empresa_nome": "Restaurante Santuzzi"`
- **Problemas:** Apenas armazena ID do contrato; os dados de vagas podem estar em `vagas` array

### Opção 3: Apps Script (requer acesso)
- Você precisa ter acesso ao Google Apps Script que processa as requisições
- URL: `process.env.VAGAS_URL` (não visível no código source)
- Deve ser uma URL tipo: `https://script.google.com/macros/s/[ID]/exec`
- Lá dentro está a lógica de como os dados são salvos na planilha

---

## ⚠️ Possíveis Problemas

### 1. **VAGAS_URL não configurada**
- Se a variável de ambiente no Railway não for definida, os POST falharão
- As vagas NÃO serão salvas no Apps Script/Google Sheets
- **Solução:** Configurar `VAGAS_URL` nas variáveis de ambiente do Railway

### 2. **Apps Script com erro**
- Se o Apps Script tiver bug, pode receber POST mas não salvar
- **Solução:** Verificar logs do Apps Script no Google Cloud

### 3. **Permissões insuficientes**
- Se o Apps Script não tiver permissão de escrever na planilha
- **Solução:** Verificar compartilhamento e permissões da planilha

### 4. **Formato esperado diferente**
- Se a aba não existe ou tem nome diferente
- **Solução:** Criar aba com nome esperado ou atualizar código

---

## 🔗 Referências Rápidas

| Arquivo | Linha | O quê |
|---------|-------|-------|
| index.js | 63 | CONFIG.VAGAS_URL (chave) |
| index.js | 70 | SHEETS_ID (planilha) |
| index.js | 3898-3967 | Função `/cliente/solicitar` (salva vagas) |
| index.js | 4595-4616 | Função `buscarVagas()` (lê vagas) |
| index.js | 5507-5513 | Função `salvarAnaliseNaPlanilha()` (salva análise) |
| divulgacao.html | 1-300 | Interface do cliente para criar vagas |

---

## ✅ Próximos Passos para Investigação

1. **Verificar Railway:**
   - Acessar https://railway.app
   - Procurar pela variável de ambiente `VAGAS_URL`
   - Confirmar se está configurada e qual é a URL

2. **Verificar Google Sheets:**
   - Abrir a planilha `1Bqrwjjy0JwAVouppOg-LGCENrYrTsQCYrqntCBf9mSk`
   - Procurar por abas que contenham vagas do "Restaurante Santuzzi"
   - Verificar se há dados recentes

3. **Verificar Google Apps Script:**
   - Acessar o Apps Script vinculado à planilha
   - Procurar pela função que processa `acao: "salvarAnalise"`
   - Verificar logs de execução

4. **Verificar dados locais:**
   - Conectar ao Railway via SSH ou verificar logs
   - Procurar `/data/contratos.json` por "Santuzzi"
   - Verificar timestamps de criação

---

**Autor:** Investigação automática do projeto Effect  
**Data:** 05/08/2026  
**Status:** ⚠️ INVESTIGAÇÃO CONCLUÍDA — Aguardando configuração de VAGAS_URL
