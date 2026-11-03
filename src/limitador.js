// Limitador de intentos de login, en memoria (sin dependencias).
// Bloquea una combinación IP + usuario tras MAX_FALLOS fallos dentro de la ventana.
// Nota: se reinicia si el servidor se reinicia, y si hay varias instancias cada una cuenta aparte.
const VENTANA_MS = 15 * 60 * 1000;
const MAX_FALLOS = 5;
const MAX_FALLOS_POR_IP = 30;

const porClave = new Map(); // "ip|usuario" -> { fallos, desde }
const porIp = new Map(); // "ip" -> { fallos, desde }

function vigente(mapa, clave) {
  const r = mapa.get(clave);
  if (r && Date.now() - r.desde > VENTANA_MS) {
    mapa.delete(clave);
    return null;
  }
  return r || null;
}

function sumar(mapa, clave) {
  const r = vigente(mapa, clave) || { fallos: 0, desde: Date.now() };
  r.fallos += 1;
  mapa.set(clave, r);
}

export function estaBloqueado(ip, usuario) {
  const a = vigente(porClave, `${ip}|${usuario}`);
  const b = vigente(porIp, ip);
  return (a?.fallos ?? 0) >= MAX_FALLOS || (b?.fallos ?? 0) >= MAX_FALLOS_POR_IP;
}

export function registrarFallo(ip, usuario) {
  sumar(porClave, `${ip}|${usuario}`);
  sumar(porIp, ip);
}

export function registrarExito(ip, usuario) {
  porClave.delete(`${ip}|${usuario}`);
}

// Limpieza periódica para que los mapas no crezcan sin límite
setInterval(() => {
  for (const m of [porClave, porIp]) for (const k of m.keys()) vigente(m, k);
}, VENTANA_MS).unref();
