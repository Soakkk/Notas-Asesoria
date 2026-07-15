import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

// Load environment variables in development
dotenv.config();

const app = express();
// Puerto fijo 3000 en producción (Electron carga localhost:3000); en desarrollo
// puede cambiarse con la variable PORT si el 3000 está ocupado (p. ej. por la
// propia app instalada corriendo a la vez).
const PORT = parseInt(process.env.PORT || "3000", 10);

// Versión de la app: en el .exe la inyecta Electron (APP_VERSION = app.getVersion());
// en desarrollo se lee de package.json.
const APP_VERSION = (() => {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version || "dev";
  } catch {
    return "dev";
  }
})();

// Increase payload limit to handle base64 images
app.use(express.json({ limit: "20mb" }));

// Local, per-PC storage for the Gemini API key (set via the in-app Settings screen).
// This lives outside the installed app folder so it survives updates/reinstalls
// and works both in "npm run dev" and in the packaged .exe.
const CONFIG_DIR = path.join(os.homedir(), ".generador-avisos-fiscales");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Las capturas originales se guardan en disco (no en el localStorage del
// navegador, que tiene un límite de ~5MB y se llenaba con 2-3 capturas en
// base64, dejando de guardar avisos en silencio). El frontend solo conserva
// una miniatura pequeña y el id del archivo.
const CAPTURAS_DIR = path.join(CONFIG_DIR, "capturas");

// Barrido al arrancar: capturas huérfanas de más de 90 días se eliminan para
// que la carpeta no crezca sin límite (los avisos activos rara vez viven tanto).
function limpiarCapturasAntiguas() {
  try {
    if (!fs.existsSync(CAPTURAS_DIR)) return;
    const limite = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const nombre of fs.readdirSync(CAPTURAS_DIR)) {
      const ruta = path.join(CAPTURAS_DIR, nombre);
      try {
        if (fs.statSync(ruta).mtimeMs < limite) fs.unlinkSync(ruta);
      } catch { /* si un archivo falla, seguimos con el resto */ }
    }
  } catch (err) {
    console.warn("No se pudo limpiar capturas antiguas:", err);
  }
}
limpiarCapturasAntiguas();

function loadStoredApiKey(): string | undefined {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed.apiKey || undefined;
    }
  } catch (err) {
    console.error("No se pudo leer la configuración local:", err);
  }
  return undefined;
}

function saveApiKeyLocally(apiKey: string) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey }, null, 2), "utf-8");
}

// Initialize Gemini API client safely
// Note: User-Agent set to 'aistudio-build' as required
let ai: GoogleGenAI | null = null;

function initGemini(apiKey: string) {
  try {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  } catch (err) {
    console.error("Failed to initialize GoogleGenAI:", err);
    ai = null;
  }
}

const initialApiKey = loadStoredApiKey() || process.env.GEMINI_API_KEY;
if (initialApiKey) {
  initGemini(initialApiKey);
} else {
  console.warn("WARNING: No hay ninguna clave de Gemini configurada todavía.");
}

// API: Check health / whether Gemini is ready to use
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", geminiConfigured: !!ai, version: APP_VERSION });
});

// API: Read current config state (never returns the raw key back to the frontend)
app.get("/api/config", (req, res) => {
  res.json({ hasApiKey: !!ai });
});

// API: Save/update the Gemini API key from the Settings screen
app.post("/api/config", (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return res.status(400).json({ error: "La clave de API no puede estar vacía." });
  }
  try {
    saveApiKeyLocally(apiKey.trim());
    initGemini(apiKey.trim());
    res.json({ success: true, hasApiKey: !!ai });
  } catch (err: any) {
    console.error("Error guardando la clave de API:", err);
    res.status(500).json({ error: "No se pudo guardar la clave de API en este equipo." });
  }
});

// API: Probar que la clave guardada funciona de verdad contra Gemini
// (hasta ahora solo se comprobaba que había "algo" guardado, no que fuera válida).
app.post("/api/config/test", async (req, res) => {
  if (!ai) {
    return res.status(400).json({ ok: false, error: "No hay ninguna clave configurada todavía." });
  }
  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ text: "Responde únicamente con la palabra OK." }],
      }),
      15_000
    );
    const text = (response.text || "").trim();
    return res.json({ ok: true, respuesta: text });
  } catch (error: any) {
    const text = String(error?.message || error || "");
    const lower = text.toLowerCase();
    let message: string;
    if (text.includes("429") || lower.includes("quota")) {
      message = "La clave funciona pero ha agotado su cuota gratuita en este momento.";
    } else if (lower.includes("api key") || lower.includes("api_key") || lower.includes("invalid") ||
               text.includes("400") || text.includes("401") || text.includes("403")) {
      message = "La clave no es válida o ha caducado. Cree una nueva en Google AI Studio.";
    } else if (text.includes("TIMEOUT_GEMINI")) {
      message = "Gemini no ha respondido (red lenta o servicio saturado). Inténtelo de nuevo.";
    } else {
      message = "No se pudo comprobar la clave: " + text;
    }
    return res.status(400).json({ ok: false, error: message });
  }
});

// ---- Almacén de capturas en disco ----

// Guarda la captura original y devuelve un id para recuperarla después.
app.post("/api/capturas", (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64 || typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "Falta la imagen." });
  }
  try {
    fs.mkdirSync(CAPTURAS_DIR, { recursive: true });
    const clean = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(path.join(CAPTURAS_DIR, id + ".png"), Buffer.from(clean, "base64"));
    return res.json({ id });
  } catch (err) {
    console.error("Error guardando la captura:", err);
    return res.status(500).json({ error: "No se pudo guardar la captura en disco." });
  }
});

app.get("/api/capturas/:id", (req, res) => {
  // El id lo genera el servidor (base36 + guion); rechazamos cualquier otra cosa
  // para que nadie pueda pedir rutas arbitrarias del disco.
  const id = String(req.params.id || "");
  if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).end();
  const ruta = path.join(CAPTURAS_DIR, id + ".png");
  if (!fs.existsSync(ruta)) return res.status(404).json({ error: "Captura no encontrada." });
  const header = Buffer.alloc(12);
  const file = fs.openSync(ruta, 'r');
  try {
    fs.readSync(file, header, 0, header.length, 0);
  } finally {
    fs.closeSync(file);
  }
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isWebp = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  res.setHeader("Content-Type", isJpeg ? "image/jpeg" : isWebp ? "image/webp" : "image/png");
  fs.createReadStream(ruta).pipe(res);
});

app.delete("/api/capturas/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).end();
  try {
    const ruta = path.join(CAPTURAS_DIR, id + ".png");
    if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error borrando la captura:", err);
    return res.status(500).json({ error: "No se pudo borrar la captura." });
  }
});

// API: Analyze Tax Image using Gemini
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function parseImagePayload(imageBase64: unknown): { data: string; mimeType: string } {
  const raw = String(imageBase64 || '');
  const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  const mimeType = (match?.[1] || 'image/png').toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error('FORMATO_IMAGEN_NO_ADMITIDO');
  }
  return {
    mimeType,
    data: match ? raw.slice(match[0].length) : raw,
  };
}

function isRetryableGeminiError(error: any): boolean {
  const text = String(error?.message || error || "");
  return (
    text.includes("503") || text.includes("UNAVAILABLE") || text.includes("overloaded") ||
    text.includes("high demand") || text.includes("TIMEOUT_GEMINI")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Corta la espera si Gemini no responde en este tiempo. Se ha comprobado que la
// API se cuelga de forma intermitente en las llamadas con imagen (no responde ni
// da error). Las llamadas correctas tardan ~8-15s, así que 30s separa bien un
// cuelgue de una respuesta lenta legítima. Cuenta como fallo "reintentable".
const GEMINI_TIMEOUT_MS = 30_000;
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT_GEMINI: sin respuesta de Gemini")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Gemini a veces devuelve 503 ("high demand") cuando el modelo está saturado.
// Es un error temporal de Google, no del código: reintentamos con espera creciente.
async function generateContentWithRetry(params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]) {
  // 4 intentos: los cuelgues son intermitentes (~1 de cada 3), así que casi
  // siempre entra a la segunda o tercera antes de agotar los reintentos.
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(ai!.models.generateContent(params), GEMINI_TIMEOUT_MS);
    } catch (error: any) {
      const isLastAttempt = attempt === maxAttempts;
      if (!isRetryableGeminiError(error) || isLastAttempt) throw error;
      const waitMs = 1500 * attempt;
      console.warn(`Gemini saturado o sin respuesta (intento ${attempt}/${maxAttempts}), reintentando en ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
  throw new Error("No se pudo contactar con Gemini tras varios intentos.");
}

// Esquema compartido por la lectura principal y la segunda lectura de verificación.
const TAX_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    modelo: {
      type: Type.STRING,
      description: "Número del modelo tributario, p. ej. '303', '111', '115', '130', '190', '200', '202'"
    },
    modelo_nombre: {
      type: Type.STRING,
      description: "Nombre oficial o descriptivo del impuesto, p. ej. 'Impuesto sobre el Valor Añadido' o 'Retenciones de IRPF'"
    },
    periodo: {
      type: Type.STRING,
      description: "Periodo o trimestre, p. ej. '1T', '2T', '3T', '4T', '01', '10', '12'"
    },
    ejercicio: {
      type: Type.STRING,
      description: "Ejercicio fiscal, p. ej. '2026' o '2025'"
    },
    cliente_nif: {
      type: Type.STRING,
      description: "NIF, CIF o NIE del declarante o cliente"
    },
    cliente_nombre: {
      type: Type.STRING,
      description: "Nombre completo, apellidos y nombre, o denominación social del cliente"
    },
    importe: {
      type: Type.NUMBER,
      description: "Importe neto resultante de la liquidación como número real positivo o negativo, p. ej. 818.55"
    },
    tipo_resultado: {
      type: Type.STRING,
      enum: ['Domiciliaci?n', 'A ingresar', 'A compensar', 'Resultado negativo', 'Resultado cero / Sin actividad', 'Devoluci?n'],
      description: "Tipo de resultado. Debe ser exactamente uno de estos valores: 'Domiciliación', 'A ingresar', 'A compensar', 'Resultado negativo', 'Resultado cero / Sin actividad', 'Devolución'. " +
        "Usa 'Resultado negativo' cuando el resultado de la declaración sea NEGATIVO y la AEAT no devuelva nada, sino que ese importe se descuente en declaraciones posteriores: " +
        "es el caso típico del modelo 130/131 con resultado negativo (aparece marcado como 'Negativa' o 'A deducir', y se arrastra a la casilla 'A deducir trimestres anteriores' del ejercicio). " +
        "Usa 'Devolución' SOLO si la AEAT va a ingresar el dinero al cliente (casilla de devolución con cuenta de abono), nunca por el mero hecho de que el importe sea negativo. " +
        "Usa 'A compensar' para el IVA (modelo 303) con saldo a compensar en periodos siguientes."
    },
    iban: {
      type: Type.STRING,
      description: "Código IBAN completo sin espacios si se muestra en el formulario de pago, p. ej. 'ES2900811016100006298239'. Si no hay o es parcial, ponlo también."
    },
    fecha_presentacion: {
      type: Type.STRING,
      description: "Fecha en la que se presentó la declaración, SOLO si aparece en la captura: suele estar junto al estado 'PRESENTADA' o el CSV, en un recuadro tipo 'Datos Present. Fecha: 15/07/2026'. " +
        "Formato dd/mm/aaaa. NO la confundas con la fecha de cargo, la fecha límite, el periodo ni el ejercicio, y NO la deduzcas ni la inventes: si no se ve una fecha de presentación en la captura, devuelve cadena vacía."
    }
  },
  required: ["modelo", "periodo", "ejercicio", "cliente_nif", "cliente_nombre", "importe", "tipo_resultado"]
};

app.post("/api/gemini/analyze-tax", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({
        error: "El servicio de IA no está configurado. Ve a 'Ajustes' y pega tu clave de la API de Gemini."
      });
    }

    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "Falta la imagen en formato base64." });
    }

    const { data: cleanBase64, mimeType } = parseImagePayload(imageBase64);

    const promptText = "Analiza detenidamente esta captura de un modelo tributario de la Agencia Tributaria Española (AEAT) " +
      "o de un programa fiscal como A3 o SAGE y extrae únicamente los datos visibles según el esquema. " +
      "Transcribe con precisión el modelo, ejercicio, período, NIF, nombre completo y forma de pago. " +
      "Si aparecen varios importes, usa el resultado final o total de la declaración, nunca una base, cuota intermedia o pago previo. " +
      "Conserva el signo del importe y convierte correctamente la coma decimal española: 1.234,56 significa 1234.56. " +
      "No inventes el IBAN ni la fecha de presentación: solo devuélvelos cuando se vean completos. " +
      "Distingue una devolución real de un resultado negativo o a compensar. Si un dato obligatorio no es legible, " +
      "devuelve una cadena vacía, o 0 en el importe, para que la aplicación obligue a revisarlo.";

    const response = await generateContentWithRetry({
      // gemini-2.5-flash en vez de 3.5-flash: se comprobó que 3.5-flash se cuelga
      // de forma sistemática en las llamadas con imagen (no responde), mientras
      // que 2.5-flash las resuelve en 1-3s de forma fiable. Es la causa real del
      // "se queda en generando aviso...".
      model: "gemini-2.5-flash",
      contents: [
        {
          inlineData: {
            mimeType,
            data: cleanBase64
          }
        },
        { text: promptText }
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: TAX_SCHEMA
      }
    });

    const textResult = response.text;
    if (!textResult) {
      throw new Error("No se pudo obtener una respuesta estructurada de Gemini.");
    }

    const parsedData = JSON.parse(textResult.trim());
    return res.json(parsedData);
  } catch (error: any) {
    console.error("Error analyzing tax image with Gemini:", error);
    const text = String(error?.message || error || "");
    const lower = text.toLowerCase();
    let message: string;
    if (text.includes("TIMEOUT_GEMINI")) {
      message = "Gemini no ha respondido tras varios intentos (a veces se satura o se cuelga). Vuelva a pegar la captura en unos segundos.";
    } else if (text.includes("429") || lower.includes("quota") || lower.includes("rate limit")) {
      message = "Ha alcanzado el límite de uso de la clave de Gemini (cuota). Espere un minuto y vuelva a intentarlo, o use una clave con más cuota.";
    } else if (text.includes("400") || text.includes("401") || text.includes("403") ||
               lower.includes("api key") || lower.includes("api_key") || lower.includes("invalid") ||
               lower.includes("expired") || lower.includes("permission")) {
      message = "La clave de Gemini no es válida o ha caducado. Ve a 'Ajustes' y pega una clave nueva creada en Google AI Studio (aistudio.google.com/apikey).";
    } else if (isRetryableGeminiError(error)) {
      message = "Gemini está saturado en este momento (mucha demanda en Google). Espere unos segundos y vuelva a pegar la captura.";
    } else {
      message = "Error al procesar la imagen con Gemini: " + (error.message || error);
    }
    return res.status(503).json({ error: message });
  }
});

// ---- Segunda lectura de verificación ----
// Vuelve a leer la MISMA captura con un prompt distinto, centrado en transcribir
// dígito a dígito los campos críticos, y compara con la primera lectura. Si dos
// lecturas independientes coinciden (y además el checksum del IBAN/NIF pasa en el
// frontend), la probabilidad de que un dígito esté mal leído es mínima.

function normalizarCampo(campo: string, valor: any): string {
  const s = valor === undefined || valor === null ? "" : String(valor);
  switch (campo) {
    case "iban":
    case "cliente_nif":
      return s.replace(/[\s.-]+/g, "").toUpperCase();
    case "periodo":
      return s.trim().toUpperCase();
    case "cliente_nombre":
      // Sin acentos, mayúsculas y espacios colapsados: "José Pérez " == "JOSE PEREZ"
      return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
    case "fecha_presentacion": {
      const match = s.trim().match(/^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})$/);
      if (!match) return s.trim();
      const [, first, month, last] = match;
      const yearFirst = first.length === 4;
      const year = yearFirst ? first : last;
      const day = yearFirst ? last : first;
      if (year.length !== 4) return s.trim();
      return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
    }
    case "importe":
      return (Math.round((parseFloat(s) || 0) * 100) / 100).toFixed(2);
    default:
      return s.trim();
  }
}

app.post("/api/gemini/verify-tax", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: "El servicio de IA no está configurado." });
    }
    const { imageBase64, extracted } = req.body;
    if (!imageBase64 || !extracted) {
      return res.status(400).json({ error: "Faltan la imagen o los datos a verificar." });
    }
    const { data: cleanBase64, mimeType } = parseImagePayload(imageBase64);

    const promptText = "Eres un transcriptor de documentos fiscales españoles. Lee esta captura de forma independiente " +
      "y copia con exactitud, dígito a dígito, el IBAN, importe final, NIF/CIF, nombre, modelo, período y ejercicio. " +
      "Comprueba especialmente los decimales y el signo del resultado. No confundas el importe final con bases o cuotas intermedias. " +
      "Transcribe la fecha de presentación solo cuando aparezca expresamente en la captura. " +
      "Para el tipo de resultado elige únicamente la opción del esquema que describa lo visible. No inventes ni completes datos ausentes.";

    // Segunda lectura con un modelo ligero y distinto al principal. Se evita
    // gemini-2.0-flash porque ya está retirado y no aporta ningún contraste.
    // 2.5 Flash-Lite queda como respaldo estable si el modelo preferido no está disponible.
    const VERIFY_MODELS = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"];
    let segunda: any = null;
    let modeloUsado = "";
    let ultimoError: any = null;
    for (const model of VERIFY_MODELS) {
      try {
        const response = await generateContentWithRetry({
          model,
          contents: [
            { inlineData: { mimeType, data: cleanBase64 } },
            { text: promptText }
          ],
          config: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: TAX_SCHEMA
          }
        });
        const textResult = response.text;
        if (!textResult) throw new Error("Sin respuesta estructurada en la verificación.");
        segunda = JSON.parse(textResult.trim());
        modeloUsado = model;
        break;
      } catch (err: any) {
        ultimoError = err;
        console.warn(`Verificación con ${model} no disponible o fallida, probando el siguiente modelo...`);
      }
    }
    if (!segunda) throw ultimoError || new Error("Ningún modelo de verificación disponible.");

    // Solo comparamos los campos donde un error tiene consecuencias reales.
    const camposCriticos = ["iban", "importe", "cliente_nif", "cliente_nombre", "modelo", "periodo", "ejercicio", "tipo_resultado", "fecha_presentacion"];
    const discrepancias: { campo: string; primera: string; segunda: string }[] = [];
    for (const campo of camposCriticos) {
      const v1 = normalizarCampo(campo, (extracted as any)[campo]);
      const v2 = normalizarCampo(campo, segunda[campo]);
      // Si ninguna de las dos lecturas vio el campo, no hay nada que comparar.
      if (!v1 && !v2) continue;
      if (v1 !== v2) {
        discrepancias.push({
          campo,
          primera: String((extracted as any)[campo] ?? ""),
          segunda: String(segunda[campo] ?? ""),
        });
      }
    }

    return res.json({ coincide: discrepancias.length === 0, discrepancias, segunda, modeloVerificacion: modeloUsado });
  } catch (error: any) {
    console.error("Error en la verificación con segunda lectura:", error);
    // La verificación es una red de seguridad: si falla (cuota, red...), no
    // bloqueamos el flujo; el frontend lo marca como "sin verificar".
    return res.status(503).json({ error: "No se pudo completar la segunda lectura de verificación." });
  }
});

// Setup Vite development middleware or serve production build assets
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Loaded dynamically so the production bundle (used inside the packaged .exe,
    // which doesn't ship devDependencies) never needs to resolve 'vite' at all.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // __dirname (no process.cwd()): tras empaquetar, este archivo vive dentro
    // de resources/app.asar/dist junto al resto de los estáticos. process.cwd()
    // depende de desde dónde se lanzó el .exe (varía según acceso directo/carpeta)
    // y en producción normalmente NO es la carpeta de la app, lo que causaba
    // "Not Found" al abrir la app instalada en otro PC.
    const distPath = __dirname;
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Bind only to localhost: this is a private desktop app, no other device
  // on the network should be able to reach it or spend your Gemini quota.
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
