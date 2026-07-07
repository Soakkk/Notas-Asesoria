import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

// Load environment variables in development
dotenv.config();

const app = express();
const PORT = 3000;

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

// API: Analyze Tax Image using Gemini 3.5 Flash
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

    // Clean base64 data if it contains the data:image/png;base64, prefix
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const promptText = "Analiza detenidamente esta captura de pantalla de un modelo tributario de la Agencia Tributaria Española (AEAT) " +
      "u otro programa de gestión fiscal (como A3, SAGE o la Sede Electrónica) y extrae la información solicitada en formato JSON " +
      "según el esquema proporcionado. Fíjate bien en el número del modelo (ej. 303, 111, 115, 130, etc.), el ejercicio fiscal (ej. 2026), " +
      "el período (ej. 2T, 3T, 1T, 01, 12, etc.), el NIF del cliente, el nombre completo del cliente, el importe total a ingresar o devolver, " +
      "la modalidad de pago (especialmente si es Domiciliación o Ingreso) y el IBAN si figura en pantalla (limpiando espacios).";

    const response = await generateContentWithRetry({
      // gemini-2.5-flash en vez de 3.5-flash: se comprobó que 3.5-flash se cuelga
      // de forma sistemática en las llamadas con imagen (no responde), mientras
      // que 2.5-flash las resuelve en 1-3s de forma fiable. Es la causa real del
      // "se queda en generando aviso...".
      model: "gemini-2.5-flash",
      contents: [
        {
          inlineData: {
            mimeType: "image/png",
            data: cleanBase64
          }
        },
        { text: promptText }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
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
              description: "Tipo de resultado. Debe ser exactamente uno de estos valores: 'Domiciliación', 'A ingresar', 'A compensar', 'Resultado cero / Sin actividad', 'Devolución'" 
            },
            iban: { 
              type: Type.STRING, 
              description: "Código IBAN completo sin espacios si se muestra en el formulario de pago, p. ej. 'ES2900811016100006298239'. Si no hay o es parcial, ponlo también." 
            }
          },
          required: ["modelo", "periodo", "ejercicio", "cliente_nif", "cliente_nombre", "importe", "tipo_resultado"]
        }
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
