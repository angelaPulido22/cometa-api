# API Club Cometa

API REST para que el entrenador de un club de voleibol controle los pagos (mensualidades, torneos, uniformes)
de sus deportistas y sepa quién está al día, quién está próximo a vencer y quién ya venció.

Stack: Node.js + Express 5 + MongoDB, autenticación con JWT.

## Puesta en marcha
1. Instala Node.js 18 o superior.
2. `npm install`
3. Copia `.env.example` a `.env` y cambia `JWT_SECRET` (y `MONGODB_URI` si usas MongoDB Atlas).
4. Con MongoDB disponible y la base `cometa` cargada: `npm start`
   (o `npm run dev` para que se reinicie al guardar).
5. Si cargaste el entrenador desde un JSON y el login no funciona, ejecuta `npm run reparar`
   (sube los campos anidados en `"0"` y convierte la contraseña en texto plano a hash bcrypt;
   se puede ejecutar varias veces sin riesgo).

## Modelo de datos
```
entrenadores 1 ──< categorias 1 ──< items >──< pagos >──1 deportistas >── 1 entrenadores
```
- **categoria**: grupo del club (ej. "Sub-17").
- **item**: un cobro de esa categoría (ej. "Mensualidad noviembre", "Torneo regional", "Uniforme"), con `valor` y `fecha_vencimiento`.
- **deportista**: pertenece a un entrenador; `identificacion` opcional y única por entrenador.
- **pago**: cruce ítem + deportista con `pagado` y `fecha_pago`. Se crean solos: al crear un ítem se genera un pago pendiente por cada deportista activo, y al crear un deportista, uno por cada ítem existente.

## Endpoints (todos con `Authorization: Bearer <token>`, menos el login)
| Método | Ruta | Qué hace | Respuestas |
|---|---|---|---|
| POST | /api/auth/login | `{usuario, password}` devuelve el token | 200, 400, 401, 429 |
| GET / PUT | /api/perfil | Ver o editar nombre, apellido y usuario | 200, 400, 409 |
| PUT | /api/perfil/password | `{actual, nueva}` | 200, 400, 401 |
| GET / POST | /api/categorias | Listar o crear (`{nombre}`) | 200, 201, 400 |
| GET / PUT / DELETE | /api/categorias/:categoriaId | Detalle, editar, eliminar (409 si tiene ítems) | 200, 204, 400, 404, 409 |
| GET / POST | /api/categorias/:categoriaId/items | Listar o crear ítems (`{nombre, valor?, fecha_vencimiento?}`) | 200, 201, 400, 404 |
| GET / PUT / DELETE | /api/items/:itemId | Detalle, editar, eliminar (409 si ya tiene pagos pagados) | 200, 204, 400, 404, 409 |
| GET | /api/deportistas?buscar=texto | Listar; `buscar` filtra por nombre o identificación (sin tildes ni mayúsculas) | 200, 400 |
| POST | /api/deportistas | Crear (`{nombre, identificacion?}`) | 201, 400, 409 |
| GET / PUT / DELETE | /api/deportistas/:deportistaId | Detalle, editar, desactivar | 200, 204, 400, 404, 409 |
| GET | /api/items/:itemId/pagos?estado= | Deportistas con su estado de pago en un ítem + `resumen` | 200, 400, 404 |
| PATCH | /api/items/:itemId/pagos/:deportistaId | `{pagado: true/false}` | 200, 400, 404 |
| GET | /api/pagos?estado=&deportistaId= | Todos los pagos del entrenador, ordenados por vencimiento ("¿quién me debe?") | 200, 400 |

## Regla de negocio: vencimientos
El estado de cada pago lo calcula **el servidor** (nunca la app) a partir de `fecha_vencimiento` del ítem y de la fecha de hoy en la zona horaria del club (`ZONA_HORARIA`, por defecto `America/Bogota`):

| Estado | Cuándo |
|---|---|
| `pagado` | Ya se marcó como pagado (aunque la fecha haya pasado) |
| `vencido` | No pagado y la fecha de vencimiento ya pasó |
| `proximo` | No pagado y vence hoy o en los próximos 3 días |
| `pendiente` | No pagado y vence más adelante, o el ítem no tiene fecha |

Cada pago incluye también `dias_restantes` (negativo si ya venció, 0 si vence hoy). Filtros: `?estado=vencido|proximo|pendiente|pagado`. Un valor distinto responde `400`.

## Otras reglas y comportamiento
- **Aislamiento:** cada entrenador sólo ve y modifica sus propias categorías, ítems, deportistas y pagos. Si un recurso es de otro entrenador, la API responde `404` como si no existiera.
- **Integridad:** no se elimina una categoría con ítems (`409`) ni un ítem que ya tiene pagos pagados (`409`). Los deportistas no se borran, se desactivan (`204`), así se conserva el historial. La identificación no se puede repetir entre deportistas activos del mismo entrenador (`409`).
- **Validaciones:** nombre obligatorio, `valor` número ≥ 0, `fecha_vencimiento` fecha real `AAAA-MM-DD` (rechaza `2026-02-31`).
- **Ids:** se generan con un contador atómico (colección `counters`) más índices únicos; si un id choca, se reintenta con el siguiente.
- **Login:** valida que usuario y contraseña sean texto, y bloquea con `429` tras 5 intentos fallidos (misma IP y usuario) durante 15 minutos. Detrás de un proxy (Render, Railway...) pon `TRUST_PROXY=1`.
- **Errores:** siempre JSON con `{ "error": "mensaje" }`. JSON mal formado responde `400`; fallos inesperados, `500`.

## Despliegue en la nube (resumen)
1. Crea un clúster gratis en MongoDB Atlas y copia su cadena de conexión.
2. Sube el código a GitHub (el `.env` NO se sube; está en `.gitignore`).
3. En Render/Railway crea un servicio web con `npm install` / `npm start` y define las variables: `MONGODB_URI`, `DB_NAME`, `JWT_SECRET` (uno nuevo), `ZONA_HORARIA`, `TRUST_PROXY=1`.
4. Carga el entrenador inicial en la base (y ejecuta `npm run reparar` si hace falta).

## Pruebas
Necesitan una MongoDB accesible (crean y borran una base temporal):
```
MONGODB_URI=mongodb://localhost:27017 npm test
```
