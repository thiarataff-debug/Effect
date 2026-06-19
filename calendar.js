// calendar.js — Integração Google Calendar para a LIA (Effect Pessoas e Performance)
// Criado em: 19/06/2026
//
// Funções exportadas:
//   criarEventoEntrevista(dados)      — cria evento quando entrevista é agendada
//   buscarHorariosLivres(dataISO)    — retorna slots livres de um dia (baseado na agenda)
//   verificarDisponibilidade(d, h)   — verifica se um horário específico está livre

const { google } = require("googleapis");

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "thiara.taff@gmail.com";

function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não configurado");
  const credentials = typeof raw === "string" ? JSON.parse(raw) : raw;
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

function getCalendar() {
  return google.calendar({ version: "v3", auth: getAuthClient() });
}

// ─── CRIAR EVENTO ─────────────────────────────────────────────────────────────
// dados: { candidato, cargo, empresa, data (YYYY-MM-DD), hora (HH:MM),
//          tipo ('Online'|'Presencial'), local, telefone }
async function criarEventoEntrevista(dados) {
  const { candidato, cargo, empresa, data, hora, tipo, local, telefone } = dados;
  try {
    const [ano, mes, dia] = data.split("-").map(Number);
    const [h, m] = hora.split(":").map(Number);

    // Evento dura 1 hora por padrão
    const inicio = new Date(Date.UTC(ano, mes - 1, dia, h + 3, m)); // UTC-3
    const fim = new Date(inicio.getTime() + 60 * 60 * 1000);

    const descricao = [
      `📱 WhatsApp: +${telefone}`,
      `💼 Cargo: ${cargo}`,
      empresa ? `🏢 Empresa: ${empresa}` : "",
      `📍 Formato: ${tipo}`,
      local
        ? `${tipo === "Online" ? "🔗 Link" : "📍 Endereço"}: ${local}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const evento = {
      summary: `🤝 ${candidato} — ${cargo}`,
      description: descricao,
      location: tipo === "Online" ? local || "" : local || "",
      start: {
        dateTime: inicio.toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      end: {
        dateTime: fim.toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      colorId: "5", // banana (amarelo)
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 60 },
          { method: "popup", minutes: 10 },
        ],
      },
    };

    const cal = getCalendar();
    const res = await cal.events.insert({
      calendarId: CALENDAR_ID,
      resource: evento,
    });

    console.log(
      `[Calendar] Evento criado: ${res.data.summary} — ${res.data.htmlLink}`
    );
    return { ok: true, link: res.data.htmlLink, eventId: res.data.id };
  } catch (e) {
    console.error("[Calendar] Erro ao criar evento:", e.message);
    return { ok: false, erro: e.message };
  }
}

// ─── HORÁRIOS LIVRES ──────────────────────────────────────────────────────────
// Retorna slots de 1h das 08:00 às 18:00 que estão livres na agenda
// dataISO: "YYYY-MM-DD"
async function buscarHorariosLivres(dataISO) {
  try {
    const timeMin = `${dataISO}T08:00:00-03:00`;
    const timeMax = `${dataISO}T18:00:00-03:00`;

    const cal = getCalendar();
    const res = await cal.freebusy.query({
      resource: {
        timeMin,
        timeMax,
        timeZone: "America/Sao_Paulo",
        items: [{ id: CALENDAR_ID }],
      },
    });

    const ocupados = res.data.calendars?.[CALENDAR_ID]?.busy || [];

    const slots = [];
    for (let hora = 8; hora < 18; hora++) {
      for (const min of [0, 30]) {
        const slotStart = new Date(`${dataISO}T${String(hora).padStart(2, "0")}:${String(min).padStart(2, "0")}:00-03:00`);
        const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

        const ocupado = ocupados.some((b) => {
          const bS = new Date(b.start);
          const bE = new Date(b.end);
          return slotStart < bE && slotEnd > bS;
        });

        if (!ocupado) {
          slots.push(
            `${String(hora).padStart(2, "0")}:${String(min).padStart(2, "0")}`
          );
        }
      }
    }

    return { ok: true, slots, totalOcupados: ocupados.length };
  } catch (e) {
    console.error("[Calendar] Erro buscarHorariosLivres:", e.message);
    return { ok: false, erro: e.message, slots: [] };
  }
}

// ─── VERIFICAR DISPONIBILIDADE ────────────────────────────────────────────────
// dataISO: "YYYY-MM-DD", hora: "HH:MM"
async function verificarDisponibilidade(dataISO, hora) {
  try {
    const [h, m] = hora.split(":").map(Number);
    const slotStart = new Date(
      `${dataISO}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-03:00`
    );
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

    const cal = getCalendar();
    const res = await cal.freebusy.query({
      resource: {
        timeMin: slotStart.toISOString(),
        timeMax: slotEnd.toISOString(),
        timeZone: "America/Sao_Paulo",
        items: [{ id: CALENDAR_ID }],
      },
    });

    const ocupados = res.data.calendars?.[CALENDAR_ID]?.busy || [];
    return { ok: true, livre: ocupados.length === 0 };
  } catch (e) {
    console.error("[Calendar] Erro verificarDisponibilidade:", e.message);
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  criarEventoEntrevista,
  buscarHorariosLivres,
  verificarDisponibilidade,
};
