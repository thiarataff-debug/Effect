# 🤖 Effect WhatsApp Bot — Guia de Instalação

## O que esse código faz
- Recebe mensagens do WhatsApp Business
- Envia para o Claude (IA da Anthropic)
- Devolve a resposta automaticamente ao cliente
- Analisa currículos enviados como texto

---

## Passo 1 — Configurar as chaves no código

Abra o arquivo `index.js` e substitua:

```js
CLAUDE_API_KEY: "SUA_CHAVE_CLAUDE_AQUI",   // sua chave sk-ant-...
WHATSAPP_TOKEN: "SEU_TOKEN_META_AQUI",      // seu token EAAA...
```

---

## Passo 2 — Subir no Railway

1. Acesse [railway.app](https://railway.app) e crie uma conta (gratuito)
2. Clique em **"New Project"** → **"Deploy from GitHub"**
   - Ou use **"Deploy from local"** e faça upload dos arquivos
3. O Railway vai detectar o `package.json` e instalar tudo automaticamente
4. Após o deploy, copie a **URL pública** gerada (ex: `https://effect-bot.railway.app`)

---

## Passo 3 — Configurar o Webhook na Meta

1. No painel do app na Meta, vá em **WhatsApp → Configuração**
2. Em **Webhook**, clique em **"Configurar"**
3. Preencha:
   - **URL do callback:** `https://SUA-URL.railway.app/webhook`
   - **Token de verificação:** `effect_webhook_2024`
4. Clique em **"Verificar e salvar"**
5. Ative o campo **"messages"** nas assinaturas

---

## Passo 4 — Testar

1. No painel da Meta, adicione seu número pessoal como número de teste
2. Mande uma mensagem para o número +1 (555) 655-5712 no WhatsApp
3. A IA deve responder automaticamente!

---

## Custo estimado
| Item | Valor/mês |
|---|---|
| Railway (hospedagem) | Grátis até $5 de uso |
| Claude API | ~$15-30 |
| WhatsApp Business API | Grátis até 1000 conversas |
| **Total inicial** | **~$15-30/mês** |

---

## Dúvidas?
Entre em contato com quem configurou este sistema.
