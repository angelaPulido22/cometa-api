// Lógica de vencimientos. Todo se calcula en el servidor, nunca en la app.
//
// Estado de un pago (según la fecha de vencimiento del ítem y si ya se pagó):
//   pagado     -> ya se marcó como pagado (sin importar la fecha)
//   vencido    -> no está pagado y la fecha de vencimiento ya pasó
//   proximo    -> no está pagado y vence hoy o dentro de los próximos DIAS_AVISO días
//   pendiente  -> no está pagado y vence más adelante (o el ítem no tiene fecha)

export const ESTADOS = ["pagado", "pendiente", "proximo", "vencido"];
export const DIAS_AVISO = 3;

const MS_DIA = 24 * 60 * 60 * 1000;

// Fecha de hoy (AAAA-MM-DD) en la zona horaria del club, no en UTC.
// Así, a las 8 p. m. en Colombia no se "adelanta" al día siguiente.
export function hoyISO(zona = process.env.ZONA_HORARIA || "America/Bogota") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Acepta solo fechas reales con formato AAAA-MM-DD (rechaza 2026-02-31, "mañana", etc.)
export function fechaValida(f) {
  if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return false;
  const d = new Date(f + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
}

// Días que faltan para la fecha (negativo si ya pasó, 0 si es hoy). null si no hay fecha.
export function diasRestantes(fechaVencimiento, hoy = hoyISO()) {
  if (!fechaVencimiento) return null;
  return Math.round((Date.parse(fechaVencimiento) - Date.parse(hoy)) / MS_DIA);
}

export function estadoPago(pagado, fechaVencimiento, hoy = hoyISO()) {
  if (pagado) return "pagado";
  const dias = diasRestantes(fechaVencimiento, hoy);
  if (dias === null) return "pendiente";
  if (dias < 0) return "vencido";
  if (dias <= DIAS_AVISO) return "proximo";
  return "pendiente";
}
