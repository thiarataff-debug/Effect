// calendar.js — Integração Google Calendar para a LIA (Effect Pessoas e Performance)
// Criado em: 19/06/2026
//
// Funções exportadas:
//   criarEventoEntrevista(dados)      — cria evento quando entrevista é agendada
//   buscarHorariosLivres(dataISO)    — retorna slots livres de um dia (baseado na agenda)
//   verificarDisponibilidade(d, h)   — verifica se um horário específico está livre
//   listarEventos(inicioISO, fimISO) — lista eventos do Google Calendar num período (Agenda Pessoal)
//   criarEventoPessoal(dados)        — cria compromisso pessoal (Agenda Pessoal)
//   editarEvento(eventId, dados)     — edita um evento existente (Agenda Pessoal)
//   excluirEvento(eventId)           — remove um evento (Agenda Pessoal)

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

// ─── AGENDA PESSOAL ───────────────────────────────────────────────────────────
// Categorias de compromisso pessoal → colorId do Google Calendar
// (paleta oficial do Calendar: https://developers.google.com/calendar/api/v3/reference/colors)
const CORES_AGENDA_PESSOAL = {
  pessoal: "9", // azul-lavanda
  saude: "11", // vermelho tomate
  trabalho: "7", // pavão (azul petróleo)
  financeiro: "10", // manjericão (verde escuro)
  lembrete: "5", // banana (amarelo)
  familia: "4", // flamingo (rosa)
};
const PREFIXO_PESSOAL = "🧠 "; // marca visualmente o que veio da Agenda Pessoal (não é entrevista)

function _mapEventoGoogle(ev) {
  const inicio = ev.start?.dateTime || ev.start?.date;
  const fim = ev.end?.dateTime || ev.end?.date;
  return {
    id: ev.id,
    titulo: (ev.summary || "(sem título)").replace(PREFIXO_PESSOAL, ""),
    tituloOriginal: ev.summary || "",
    descricao: ev.description || "",
    local: ev.location || "",
    inicio,
    fim,
    diaTodo: !ev.start?.dateTime,
    cor: ev.colorId || null,
    link: ev.htmlLink || "",
    origem: ev.summary && ev.summary.startsWith(PREFIXO_PESSOAL) ? "pessoal" : "outro",
  };
}

// ─── LISTAR EVENTOS (período) ─────────────────────────────────────────────────
// inicioISO / fimISO: "YYYY-MM-DD". Retorna todos os eventos do calendário no
// período (entrevistas + compromissos pessoais + tudo que estiver na agenda real).
async function listarEventos(inicioISO, fimISO) {
  try {
    const timeMin = `${inicioISO}T00:00:00-03:00`;
    const timeMax = `${fimISO}T23:59:59-03:00`;

    const cal = getCalendar();
    const res = await cal.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
    });

    const eventos = (res.data.items || []).map(_mapEventoGoogle);
    return { ok: true, eventos };
  } catch (e) {
    console.error("[Calendar] Erro listarEventos:", e.message);
    return { ok: false, erro: e.message, eventos: [] };
  }
}

// ─── CRIAR EVENTO PESSOAL ──────────────────────────────────────────────────────
// dados: { titulo, data (YYYY-MM-DD), horaInicio (HH:MM), horaFim (HH:MM, opcional),
//          diaTodo (bool), local, notas, categoria }
async function criarEventoPessoal(dados) {
  const { titulo, data, horaInicio, horaFim, diaTodo, local, notas, categoria } = dados;
  try {
    if (!titulo || !data) throw new Error("Campos obrigatórios: titulo, data");

    const evento = {
      summary: `${PREFIXO_PESSOAL}${titulo}`,
      description: notas || "",
      location: local || "",
      colorId: CORES_AGENDA_PESSOAL[categoria] || CORES_AGENDA_PESSOAL.pessoal,
    };

    if (diaTodo || !horaInicio) {
      const [ano, mes, dia] = data.split("-").map(Number);
      const fimData = new Date(Date.UTC(ano, mes - 1, dia + 1));
      evento.start = { date: data };
      evento.end = { date: fimData.toISOString().slice(0, 10) };
    } else {
      const [ano, mes, dia] = data.split("-").map(Number);
      const [h, m] = horaInicio.split(":").map(Number);
      const inicio = new Date(Date.UTC(ano, mes - 1, dia, h + 3, m));
      let fim;
      if (horaFim) {
        const [hf, mf] = horaFim.split(":").map(Number);
        fim = new Date(Date.UTC(ano, mes - 1, dia, hf + 3, mf));
      } else {
        fim = new Date(inicio.getTime() + 60 * 60 * 1000);
      }
      evento.start = { dateTime: inicio.toISOString(), timeZone: "America/Sao_Paulo" };
      evento.end = { dateTime: fim.toISOString(), timeZone: "America/Sao_Paulo" };
      evento.reminders = {
        useDefault: false,
        overrides: [{ method: "popup", minutes: 30 }],
      };
    }

    const cal = getCalendar();
    const res = await cal.events.insert({ calendarId: CALENDAR_ID, resource: evento });

    console.log(`[Calendar] Evento pessoal criado: ${res.data.summary} — ${res.data.htmlLink}`);
    return { ok: true, evento: _mapEventoGoogle(res.data) };
  } catch (e) {
    console.error("[Calendar] Erro ao criar evento pessoal:", e.message);
    return { ok: false, erro: e.message };
  }
}

// ─── EDITAR EVENTO ─────────────────────────────────────────────────────────────
// eventId: id do evento no Google Calendar. dados: mesmo formato de criarEventoPessoal.
async function editarEvento(eventId, dados) {
  const { titulo, data, horaInicio, horaFim, diaTodo, local, notas, categoria } = dados;
  try {
    if (!eventId) throw new Error("eventId obrigatório");

    const patch = {};
    if (titulo !== undefined) patch.summary = `${PREFIXO_PESSOAL}${titulo}`;
    if (notas !== undefined) patch.description = notas;
    if (local !== undefined) patch.location = local;
    if (categoria !== undefined) patch.colorId = CORES_AGENDA_PESSOAL[categoria] || CORES_AGENDA_PESSOAL.pessoal;

    if (data) {
      if (diaTodo || !horaInicio) {
        const [ano, mes, dia] = data.split("-").map(Number);
        const fimData = new Date(Date.UTC(ano, mes - 1, dia + 1));
        patch.start = { date: data };
        patch.end = { date: fimData.toISOString().slice(0, 10) };
      } else {
        const [ano, mes, dia] = data.split("-").map(Number);
        const [h, m] = horaInicio.split(":").map(Number);
        const inicio = new Date(Date.UTC(ano, mes - 1, dia, h + 3, m));
        let fim;
        if (horaFim) {
          const [hf, mf] = horaFim.split(":").map(Number);
          fim = new Date(Date.UTC(ano, mes - 1, dia, hf + 3, mf));
        } else {
          fim = new Date(inicio.getTime() + 60 * 60 * 1000);
        }
        patch.start = { dateTime: inicio.toISOString(), timeZone: "America/Sao_Paulo" };
        patch.end = { dateTime: fim.toISOString(), timeZone: "America/Sao_Paulo" };
      }
    }

    const cal = getCalendar();
    const res = await cal.events.patch({ calendarId: CALENDAR_ID, eventId, resource: patch });

    console.log(`[Calendar] Evento editado: ${res.data.summary}`);
    return { ok: true, evento: _mapEventoGoogle(res.data) };
  } catch (e) {
    console.error("[Calendar] Erro ao editar evento:", e.message);
    return { ok: false, erro: e.message };
  }
}

// ─── EXCLUIR EVENTO ─────────────────────────────────────────────────────────────
async function excluirEvento(eventId) {
  try {
    if (!eventId) throw new Error("eventId obrigatório");
    const cal = getCalendar();
    await cal.events.delete({ calendarId: CALENDAR_ID, eventId });
    console.log(`[Calendar] Evento excluído: ${eventId}`);
    return { ok: true };
  } catch (e) {
    // Google retorna 410 se o evento já foi excluído — tratamos como sucesso
    if (e.code === 410 || e.code === 404) return { ok: true };
    console.error("[Calendar] Erro ao excluir evento:", e.message);
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  criarEventoEntrevista,
  buscarHorariosLivres,
  verificarDisponibilidade,
  listarEventos,
  criarEventoPessoal,
  editarEvento,
  excluirEvento,
};
