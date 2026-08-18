const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

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

async function runVision(env, image) {
  const prompt = `Analizá esta foto para registrar una comida.
Identificá solamente alimentos razonablemente visibles.
Estimá el peso comestible en gramos de cada alimento y sus macronutrientes para esa cantidad.
La estimación es visual: no inventes ingredientes ocultos, aceite o salsas que no sean evidentes.
Si ves un producto envasado pero no podés leer la etiqueta, estimá por el alimento visible y aclaralo.
Si la imagen no contiene comida o no permite una estimación razonable, devolvé items vacío.
protein, carbs, fat y fiber se expresan en gramos; kcal en kilocalorías.`;

  return await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content: "Sos un asistente de registro nutricional. Priorizá estimaciones conservadoras y aclaraciones breves."
      },
      { role: "user", content: prompt }
    ],
    image,
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
    grams: Number(x?.grams) || 0,
    kcal: Number(x?.kcal) || 0,
    protein: Number(x?.protein) || 0,
    carbs: Number(x?.carbs) || 0,
    fat: Number(x?.fat) || 0,
    fiber: Number(x?.fiber) || 0
  }));

  analysis.confidence = String(analysis.confidence || "media").slice(0, 20);
  analysis.note = String(
    analysis.note || "Estimación visual; corregí cantidades si conocés el peso real."
  ).slice(0, 300);

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
        version: "0.3.2",
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

        const result = await runVision(env, body.image);
        const analysis = normalizeAnalysis(result);

        if (!analysis.items.length) {
          return json({
            ok: false,
            error: analysis.note || "No pude identificar alimentos con suficiente seguridad.",
            analysis
          }, 422);
        }

        return json({ ok: true, analysis });
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
