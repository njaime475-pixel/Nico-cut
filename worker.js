const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type,Accept",
  "access-control-max-age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS
    }
  });
}

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          grams: { type: "number" },
          kcal: { type: "number" },
          protein: { type: "number" },
          carbs: { type: "number" },
          fat: { type: "number" },
          fiber: { type: "number" }
        },
        required: ["name","grams","kcal","protein","carbs","fat","fiber"]
      }
    },
    confidence: { type: "string" },
    note: { type: "string" }
  },
  required: ["items","confidence","note"]
};

function dataUrlToBlob(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Formato de imagen no válido.");

  const mime = match[1];
  const b64 = match[2];
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Blob([bytes], { type: mime });
}

function extFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "jpg";
}

async function describeImage(env, dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const ext = extFromMime(blob.type);

  const result = await env.AI.toMarkdown(
    {
      name: `meal.${ext}`,
      blob
    },
    {
      conversionOptions: {
        output: { format: "text" },
        image: { descriptionLanguage: "es" }
      }
    }
  );

  if (!result || result.format === "error") {
    throw new Error(result?.error || "No pude interpretar la imagen.");
  }

  const description = String(result.data || "").trim();
  if (!description) throw new Error("La imagen no produjo una descripción útil.");

  return description;
}

async function estimateMacros(env, description) {
  const prompt = `A partir de esta descripción automática de una foto de comida:

"${description}"

Generá una estimación nutricional VISUAL y conservadora.

Reglas:
- Identificá únicamente alimentos razonablemente presentes en la descripción.
- Estimá el peso COMESTIBLE en gramos de cada alimento.
- Calculá kcal, proteína, carbohidratos, grasas y fibra para esa cantidad.
- Si hay un envase o producto cuya etiqueta no se puede leer con precisión, usá valores típicos y aclaralo.
- No inventes aceites, salsas ni ingredientes ocultos.
- Si no hay comida o no se puede hacer una estimación razonable, devolvé items vacío.
- confidence debe ser "alta", "media" o "baja".
- note debe recordar que es una estimación visual y qué parte genera más incertidumbre.`;

  return await env.AI.run(TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content: "Sos un asistente de registro nutricional. Priorizá valores plausibles y conservadores. No exageres la precisión."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: 900,
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: ANALYSIS_SCHEMA
    }
  });
}

function normalizeAnalysis(result) {
  let value = result?.response ?? result?.result ?? result;

  if (typeof value === "string") {
    const cleaned = value
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    value = JSON.parse(cleaned);
  }

  if (!value || typeof value !== "object") {
    throw new Error("La IA devolvió una respuesta sin estructura válida.");
  }

  const analysis = value;
  if (!Array.isArray(analysis.items)) analysis.items = [];

  analysis.items = analysis.items.slice(0, 12).map((x) => ({
    name: String(x?.name || "Alimento").slice(0, 80),
    grams: Math.max(0, Number(x?.grams) || 0),
    kcal: Math.max(0, Number(x?.kcal) || 0),
    protein: Math.max(0, Number(x?.protein) || 0),
    carbs: Math.max(0, Number(x?.carbs) || 0),
    fat: Math.max(0, Number(x?.fat) || 0),
    fiber: Math.max(0, Number(x?.fiber) || 0)
  }));

  analysis.confidence = String(analysis.confidence || "media").slice(0, 20);
  analysis.note = String(
    analysis.note || "Estimación visual; corregí cantidades si conocés el peso real."
  ).slice(0, 400);

  return analysis;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "nico-cut-ai",
        version: "0.3.3",
        ai: Boolean(env.AI),
        assets: Boolean(env.ASSETS)
      });
    }

    if (url.pathname === "/api/analyze") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Usá POST para analizar una imagen." }, 405);
      }

      try {
        const body = await request.json();

        if (!body?.image || typeof body.image !== "string") {
          return json({ ok: false, error: "Falta la imagen." }, 400);
        }
        if (!body.image.startsWith("data:image/")) {
          return json({ ok: false, error: "Formato de imagen no válido." }, 400);
        }
        if (body.image.length > 9_000_000) {
          return json({ ok: false, error: "La foto es demasiado grande." }, 413);
        }
        if (!env.AI) {
          return json({ ok: false, error: "El binding de IA no está disponible." }, 500);
        }

        const description = await describeImage(env, body.image);
        const raw = await estimateMacros(env, description);
        const analysis = normalizeAnalysis(raw);

        if (!analysis.items.length) {
          return json({
            ok: false,
            error: analysis.note || "No pude identificar alimentos con suficiente seguridad.",
            description,
            analysis
          }, 422);
        }

        return json({
          ok: true,
          description,
          analysis
        });
      } catch (err) {
        console.error("analyze error", err);
        return json({
          ok: false,
          error: String(err?.message || err || "Error analizando la foto.")
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
