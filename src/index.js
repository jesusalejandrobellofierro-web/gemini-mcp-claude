/**
 * Conector MCP de Gemini para Claude
 * Servidor MCP remoto (Streamable HTTP) sobre Cloudflare Workers.
 *
 * Endpoint: POST https://<tu-worker>.workers.dev/mcp/<AUTH_TOKEN>
 * Secrets necesarios: GEMINI_API_KEY, AUTH_TOKEN
 * Opcional (para guardar las imagenes y tener URL): binding R2 IMAGENES + variable PUBLIC_URL
 */

const SERVER_NAME = "gemini";
const SERVER_VERSION = "1.0.0";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL = "2025-06-18";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODELO_TEXTO = "gemini-2.5-flash";
const MODELO_IMAGEN = "gemini-2.5-flash-image";
const MAX_REF_BYTES = 7 * 1024 * 1024;

const TOOLS = [
  {
    name: "gemini_generar_texto",
    description:
      "Genera o transforma texto con Gemini: redactar, resumir, traducir, clasificar, razonar sobre un texto largo. " +
      "Si buscar_en_google es true, Gemini consulta la web y se devuelven las fuentes al final.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "La instruccion o pregunta para Gemini." },
        sistema: { type: "string", description: "Instruccion de sistema opcional: rol, tono, reglas de formato." },
        modelo: { type: "string", description: "ID del modelo. Por defecto " + MODELO_TEXTO + ". Mira gemini_listar_modelos para ver los disponibles." },
        temperatura: { type: "number", description: "De 0 a 2. Mas bajo es mas literal." },
        max_tokens: { type: "integer", description: "Limite de tokens de salida." },
        buscar_en_google: { type: "boolean", description: "Activa la busqueda de Google como fuente. Por defecto false." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "gemini_generar_imagen",
    description:
      "Genera o edita una imagen con los modelos de imagen de Gemini (Nano Banana). " +
      "Si pasas referencias, Gemini las toma como base para editar, combinar o mantener un producto o personaje. " +
      "Aviso: la salida de imagen normalmente exige facturacion activada en el proyecto de Google.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Descripcion de la imagen, o la edicion a aplicar sobre las referencias." },
        referencias: {
          type: "array",
          items: { type: "string" },
          description: "Hasta 3 imagenes de partida, como URL https publica o como data URI base64."
        },
        relacion_aspecto: { type: "string", description: "Por ejemplo 1:1, 16:9, 9:16, 4:5, 3:2." },
        modelo: { type: "string", description: "ID del modelo de imagen. Por defecto " + MODELO_IMAGEN + "." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "gemini_analizar_imagen",
    description:
      "Le muestra una o varias imagenes a Gemini y devuelve texto: describir la imagen, sacar el texto que aparece, " +
      "leer una tabla o una factura, comparar dos piezas, revisar un diseno.",
    inputSchema: {
      type: "object",
      properties: {
        pregunta: { type: "string", description: "Que se quiere saber de las imagenes." },
        imagenes: {
          type: "array",
          items: { type: "string" },
          description: "URLs https publicas o data URI base64 de las imagenes."
        },
        modelo: { type: "string", description: "Por defecto " + MODELO_TEXTO + "." }
      },
      required: ["pregunta", "imagenes"]
    }
  },
  {
    name: "gemini_listar_modelos",
    description:
      "Lista los modelos que esta API key tiene habilitados y lo que soporta cada uno. " +
      "Usalo cuando un modelo falle o para saber que version de Nano Banana esta disponible.",
    inputSchema: {
      type: "object",
      properties: {
        filtro: { type: "string", description: "Texto para filtrar por nombre, por ejemplo image o flash." }
      }
    }
  }
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cabeceras() });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        servidor: SERVER_NAME,
        version: SERVER_VERSION,
        endpoint: "/mcp/<AUTH_TOKEN>",
        api_key_configurada: Boolean(env.GEMINI_API_KEY),
        token_configurado: Boolean(env.AUTH_TOKEN),
        r2_configurado: Boolean(env.IMAGENES)
      });
    }

    const ruta = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!ruta) return json({ error: "ruta no encontrada" }, 404);

    if (!env.AUTH_TOKEN || !comparaSegura(decodeURIComponent(ruta[1]), env.AUTH_TOKEN)) {
      return json({ error: "token invalido" }, 401);
    }

    if (request.method !== "POST") {
      return new Response("metodo no permitido", { status: 405, headers: cabeceras() });
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "falta el secret GEMINI_API_KEY en el worker" }, 500);
    }

    let cuerpo;
    try {
      cuerpo = await request.json();
    } catch (e) {
      return json(rpcError(null, -32700, "JSON invalido"), 400);
    }

    if (Array.isArray(cuerpo)) {
      const salida = [];
      for (const mensaje of cuerpo) {
        const r = await atender(mensaje, env);
        if (r) salida.push(r);
      }
      return salida.length ? json(salida) : new Response(null, { status: 202, headers: cabeceras() });
    }

    const respuesta = await atender(cuerpo, env);
    if (!respuesta) return new Response(null, { status: 202, headers: cabeceras() });
    return json(respuesta);
  }
};

async function atender(mensaje, env) {
  const tieneId = mensaje && typeof mensaje === "object" && "id" in mensaje && mensaje.id !== null;
  const id = tieneId ? mensaje.id : null;
  const metodo = mensaje && mensaje.method;

  if (!metodo) return tieneId ? rpcError(id, -32600, "peticion invalida") : null;
  if (!tieneId) return null;

  try {
    switch (metodo) {
      case "initialize": {
        const pedida = mensaje.params && mensaje.params.protocolVersion;
        const version = SUPPORTED_PROTOCOLS.includes(pedida) ? pedida : FALLBACK_PROTOCOL;
        return rpcOk(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
        });
      }
      case "ping":
        return rpcOk(id, {});
      case "tools/list":
        return rpcOk(id, { tools: TOOLS });
      case "resources/list":
        return rpcOk(id, { resources: [] });
      case "prompts/list":
        return rpcOk(id, { prompts: [] });
      case "tools/call":
        return rpcOk(id, await ejecutar(mensaje.params || {}, env));
      default:
        return rpcError(id, -32601, "metodo no soportado: " + metodo);
    }
  } catch (e) {
    return rpcError(id, -32603, texto(e));
  }
}

async function ejecutar(params, env) {
  const nombre = params.name;
  const a = params.arguments || {};
  try {
    if (nombre === "gemini_generar_texto") return await generarTexto(a, env);
    if (nombre === "gemini_generar_imagen") return await generarImagen(a, env);
    if (nombre === "gemini_analizar_imagen") return await analizarImagen(a, env);
    if (nombre === "gemini_listar_modelos") return await listarModelos(a, env);
    return errorTool("herramienta desconocida: " + nombre);
  } catch (e) {
    return errorTool(texto(e));
  }
}

async function generarTexto(a, env) {
  if (!a.prompt) return errorTool("falta el prompt");
  const modelo = a.modelo || MODELO_TEXTO;

  const cuerpo = { contents: [{ role: "user", parts: [{ text: a.prompt }] }] };
  if (a.sistema) cuerpo.systemInstruction = { parts: [{ text: a.sistema }] };

  const gen = {};
  if (typeof a.temperatura === "number") gen.temperature = a.temperatura;
  if (typeof a.max_tokens === "number") gen.maxOutputTokens = a.max_tokens;
  if (Object.keys(gen).length) cuerpo.generationConfig = gen;

  if (a.buscar_en_google) cuerpo.tools = [{ google_search: {} }];

  const datos = await llamarGemini(modelo, cuerpo, env);
  const partes = sacarPartes(datos);

  let salida = partes
    .filter(function (p) { return typeof p.text === "string"; })
    .map(function (p) { return p.text; })
    .join("\n")
    .trim();

  const fuentes = sacarFuentes(datos);
  if (fuentes) salida += "\n\nFuentes:\n" + fuentes;

  if (!salida) {
    const razon = sacarRazonCorte(datos);
    salida = "Gemini no devolvio texto" + (razon ? " (motivo: " + razon + ")" : "") + ". Respuesta: " + recorta(datos);
  }

  return { content: [{ type: "text", text: salida }] };
}

async function generarImagen(a, env) {
  if (!a.prompt) return errorTool("falta el prompt");
  const modelo = a.modelo || MODELO_IMAGEN;

  const partes = [{ text: a.prompt }];
  const refs = Array.isArray(a.referencias) ? a.referencias.slice(0, 3) : [];
  for (const ref of refs) {
    partes.push({ inline_data: await aInline(ref) });
  }

  const base = { contents: [{ role: "user", parts: partes }] };
  const conf = {};
  if (a.relacion_aspecto) conf.imageConfig = { aspectRatio: a.relacion_aspecto };

  let datos;
  try {
    datos = await llamarGemini(modelo, Object.assign({}, base, {
      generationConfig: Object.assign({}, conf, { responseModalities: ["TEXT", "IMAGE"] })
    }), env);
  } catch (e) {
    const m = texto(e);
    if (/modalit/i.test(m)) {
      datos = await llamarGemini(modelo, Object.assign({}, base, {
        generationConfig: Object.assign({}, conf, { responseModalities: ["IMAGE"] })
      }), env);
    } else {
      throw e;
    }
  }

  const devueltas = sacarPartes(datos);
  const content = [];
  let nota = "";

  for (const p of devueltas) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      const tipo = inline.mimeType || inline.mime_type || "image/png";
      content.push({ type: "image", data: inline.data, mimeType: tipo });

      if (env.IMAGENES && env.PUBLIC_URL) {
        try {
          const clave = "img/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + extension(tipo);
          await env.IMAGENES.put(clave, base64ABytes(inline.data), { httpMetadata: { contentType: tipo } });
          nota += "\nArchivo: " + String(env.PUBLIC_URL).replace(/\/+$/, "") + "/" + clave;
        } catch (e) {
          nota += "\nNo se pudo guardar en R2: " + texto(e);
        }
      }
    } else if (typeof p.text === "string" && p.text.trim()) {
      nota += "\n" + p.text.trim();
    }
  }

  if (!content.length) {
    const razon = sacarRazonCorte(datos);
    return errorTool(
      "Gemini no devolvio imagen" + (razon ? " (motivo: " + razon + ")" : "") + ". " +
      (nota.trim() || recorta(datos))
    );
  }

  content.push({ type: "text", text: ("Modelo: " + modelo + nota).trim() });
  return { content: content };
}

async function analizarImagen(a, env) {
  if (!a.pregunta) return errorTool("falta la pregunta");
  if (!Array.isArray(a.imagenes) || !a.imagenes.length) return errorTool("falta al menos una imagen");

  const modelo = a.modelo || MODELO_TEXTO;
  const partes = [{ text: a.pregunta }];
  for (const img of a.imagenes.slice(0, 8)) {
    partes.push({ inline_data: await aInline(img) });
  }

  const datos = await llamarGemini(modelo, { contents: [{ role: "user", parts: partes }] }, env);
  const salida = sacarPartes(datos)
    .filter(function (p) { return typeof p.text === "string"; })
    .map(function (p) { return p.text; })
    .join("\n")
    .trim();

  return { content: [{ type: "text", text: salida || ("Gemini no devolvio texto. " + recorta(datos)) }] };
}

async function listarModelos(a, env) {
  const r = await fetch(API_BASE + "/models?pageSize=200&key=" + encodeURIComponent(env.GEMINI_API_KEY));
  const bruto = await r.text();
  let datos;
  try { datos = JSON.parse(bruto); } catch (e) { datos = {}; }

  if (!r.ok) {
    const msg = (datos.error && datos.error.message) || bruto.slice(0, 600);
    return errorTool("Google respondio " + r.status + ": " + msg);
  }

  let lista = (datos.models || []).map(function (m) {
    return {
      id: String(m.name || "").replace(/^models\//, ""),
      nombre: m.displayName || "",
      metodos: m.supportedGenerationMethods || []
    };
  });

  if (a.filtro) {
    const f = String(a.filtro).toLowerCase();
    lista = lista.filter(function (m) {
      return (m.id + " " + m.nombre).toLowerCase().indexOf(f) !== -1;
    });
  }

  const salida = lista
    .map(function (m) {
      return "- " + m.id + (m.nombre ? " (" + m.nombre + ")" : "") + " [" + m.metodos.join(", ") + "]";
    })
    .join("\n");

  return { content: [{ type: "text", text: salida || "sin resultados" }] };
}

async function llamarGemini(modelo, cuerpo, env) {
  const url = API_BASE + "/models/" + encodeURIComponent(modelo) + ":generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo)
  });

  const bruto = await r.text();
  let datos;
  try { datos = JSON.parse(bruto); } catch (e) { datos = { bruto: bruto }; }

  if (!r.ok) {
    const msg = (datos.error && datos.error.message) || bruto.slice(0, 600);
    throw new Error("Google respondio " + r.status + ": " + msg);
  }
  return datos;
}

async function aInline(ref) {
  const valor = String(ref || "");

  if (/^data:/.test(valor)) {
    const m = valor.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (!m) throw new Error("data URI invalido");
    return { mime_type: m[1], data: m[2].replace(/\s+/g, "") };
  }

  if (!/^https:\/\//.test(valor)) {
    throw new Error("las referencias deben ser URL https publicas o data URI base64");
  }

  const r = await fetch(valor);
  if (!r.ok) throw new Error("no se pudo bajar la imagen (" + r.status + "): " + valor);

  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_REF_BYTES) throw new Error("la imagen pesa mas de 7 MB: " + valor);

  return {
    mime_type: (r.headers.get("content-type") || "image/png").split(";")[0],
    data: aBase64(buf)
  };
}

function sacarPartes(d) {
  const c = (d && d.candidates || [])[0];
  return (c && c.content && c.content.parts) || [];
}

function sacarRazonCorte(d) {
  const c = (d && d.candidates || [])[0];
  if (c && c.finishReason) return String(c.finishReason);
  if (d && d.promptFeedback && d.promptFeedback.blockReason) return "bloqueado: " + d.promptFeedback.blockReason;
  return "";
}

function sacarFuentes(d) {
  const c = (d && d.candidates || [])[0];
  const g = c && c.groundingMetadata;
  if (!g) return "";
  return (g.groundingChunks || [])
    .map(function (ch) {
      if (!ch.web || !ch.web.uri) return null;
      return "- " + (ch.web.title || ch.web.uri) + ": " + ch.web.uri;
    })
    .filter(Boolean)
    .join("\n");
}

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const trozo = 0x8000;
  for (let i = 0; i < bytes.length; i += trozo) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + trozo));
  }
  return btoa(bin);
}

function base64ABytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function extension(mime) {
  const m = String(mime || "");
  if (m.indexOf("jpeg") !== -1 || m.indexOf("jpg") !== -1) return "jpg";
  if (m.indexOf("webp") !== -1) return "webp";
  return "png";
}

function comparaSegura(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function recorta(d) {
  try { return JSON.stringify(d).slice(0, 1200); } catch (e) { return "sin detalle"; }
}

function texto(e) {
  return String((e && e.message) || e);
}

function errorTool(msg) {
  return { content: [{ type: "text", text: "Error: " + msg }], isError: true };
}

function rpcOk(id, result) {
  return { jsonrpc: "2.0", id: id, result: result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id, error: { code: code, message: message } };
}

function cabeceras() {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id"
  };
}

function json(datos, estado) {
  return new Response(JSON.stringify(datos), { status: estado || 200, headers: cabeceras() });
}
