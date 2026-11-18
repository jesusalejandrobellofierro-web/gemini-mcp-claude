# Gemini MCP connector for Claude

A small remote MCP server that gives Claude four Gemini tools. It runs on Cloudflare Workers (free plan), so there is no server to maintain.

*Versión en español más abajo.*

| Tool | What it does |
|---|---|
| `gemini_generar_texto` | Write, summarize, translate or classify text. Can use Google Search and return sources. |
| `gemini_generar_imagen` | Generate or edit images with Gemini image models (Nano Banana). Accepts up to 3 reference images. |
| `gemini_analizar_imagen` | Show images to Gemini and get text back (describe, extract text, read tables or invoices). |
| `gemini_listar_modelos` | List the models your API key can use. Useful for debugging. |

Why it exists: claude.ai custom connectors must be reachable from the internet, so a local `npx` / `uvx` MCP server does not work there. This one is a single file that deploys in a few minutes.

## Setup

1. **Gemini API key.** Create one at https://aistudio.google.com/apikey. Text works on the free tier. Image output usually needs billing enabled on the Google Cloud project behind the key.
2. **Cloudflare account.** Free at https://dash.cloudflare.com/sign-up
3. **Deploy.**
   ```bash
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
4. **Secrets.** Generate a random token with `openssl rand -hex 24`, then:
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put AUTH_TOKEN
   ```
5. **Test.**
   ```bash
   ./probar.sh https://conector-gemini.YOUR-ACCOUNT.workers.dev/mcp/YOUR-TOKEN
   ```
6. **Add it to Claude.** Settings → Connectors → Add custom connector. Paste the full URL including the token. Authentication: none.

## Notes

- **The token goes in the URL on purpose.** Claude connects from Anthropic's servers and the connector settings cannot send custom headers, so the secret travels in the path. Treat the URL like a password. If it leaks, set a new `AUTH_TOKEN` and update the connector URL.
- **Saving images as files.** By default the image comes back inside the response. To get a downloadable URL, enable R2 following the comments in `wrangler.toml`.
- **Models.** Defaults are `gemini-2.5-flash` (text) and `gemini-2.5-flash-image` (images). Every tool accepts a `modelo` parameter, and `gemini_listar_modelos` shows what your key really has.
- **Cost.** The Workers free plan allows 100,000 requests per day. The only possible cost is the Google API.

---

## En español

Servidor MCP remoto que le da a Claude cuatro herramientas de Gemini: generar texto, generar o editar imágenes, analizar imágenes y listar modelos. Corre en Cloudflare Workers con el plan gratis.

Pasos: crea una API key en AI Studio, crea una cuenta gratis de Cloudflare, despliega con `npx wrangler deploy`, carga los secretos `GEMINI_API_KEY` y `AUTH_TOKEN` (genera el token con `openssl rand -hex 24`) y agrega la URL completa con el token en Claude, en Configuración, Conectores, Agregar conector personalizado.

El token viaja en la URL: trátala como una contraseña y no la publiques.

## License

MIT
