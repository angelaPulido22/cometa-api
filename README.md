# API Club Cometa

## Puesta en marcha
1. Instala Node.js 18 o superior.
2. `npm install`
3. Copia `.env.example` a `.env` y cambia `JWT_SECRET`.
4. Con MongoDB corriendo y la base `cometa` cargada: `npm start`
   (o `npm run dev` para que se reinicie al guardar).

## Endpoints (todos con `Authorization: Bearer <token>`, menos el login)
| Método | Ruta | Qué hace |
|---|---|---|
| POST | /api/auth/login | `{usuario, password}` devuelve el token |
| GET / PUT | /api/perfil | Ver o editar nombre, apellido y usuario |
| PUT | /api/perfil/password | `{actual, nueva}` |
| GET / POST | /api/categorias | Listar o crear (`{nombre}`) |
| GET / POST | /api/categorias/:categoriaId/items | Listar o crear ítems (`{nombre, valor?}`) |
| GET / POST | /api/deportistas | Listar o crear (`{nombre}`) |
| GET | /api/items/:itemId/pagos | Deportistas con su estado de pago |
| PATCH | /api/items/:itemId/pagos/:deportistaId | `{pagado: true/false}` |
