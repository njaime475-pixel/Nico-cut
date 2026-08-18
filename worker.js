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
  const prompt = `Analizá esta descripción automática de una FOTO DE UN PLATO DE COMIDA:

"${description}"

Tu tarea es estimar SOLO LOS ALIMENTOS QUE FORMAN PARTE DEL PLATO PRINCIPAL que la persona fotografió para registrar.

REGLAS DE SELECCIÓN — MUY IMPORTANTES:
- Ignorá por completo objetos no comestibles: plato, bandeja, cubiertos, cuchillo, tenedor, cuchara, vaso, servilleta, mantel, mesa, envases, recipientes, decoración, celular, etc.
- Ignorá alimentos u objetos que aparezcan de fondo, fuera del plato principal o como decoración accidental.
- No incluyas agua, hielo, limón decorativo, bebidas ni acompañamientos externos salvo que sea evidente que son parte central de la ingesta fotografiada.
- Si un elemento tiene 0 kcal y 0 macronutrientes, NO lo incluyas como item.
- No conviertas objetos visibles en "alimentos" solo porque aparezcan en la descripción.
- Preferí 1 a 4 alimentos principales plausibles antes que una lista larga de objetos.

REGLAS NUTRICIONALES:
- Estimá el peso COMESTIBLE en gramos de cada alimento principal.
- Calculá kcal, proteína, carbohidratos, grasas y fibra PARA ESA CANTIDAD.
- Cada item debe tener sus propios macros; no repartas por error los macros totales del plato en un solo alimento.
- Aplicá coherencia nutricional básica:
  * carnes, pollo, pescado y huevos simples tienen aproximadamente 0 g de carbohidratos salvo empanado, salsa o preparación que claramente los aporte;
  * puré, arroz, pasta, papa, batata, pan y cereales aportan principalmente carbohidratos;
  * aceites y manteca aportan principalmente grasas;
  * verduras y frutas suelen aportar carbohidratos y fibra, pero cantidades moderadas de proteína y grasa.
- Si un valor contradice claramente el tipo de alimento, corregilo antes de responder.
- Comprobá que las kcal sean aproximadamente compatibles con proteína*4 + carbohidratos*4 + grasas*9. No hace falta que coincida exacto por fibra/redondeos.
- No inventes aceites, salsas, queso, azúcar ni ingredientes ocultos si no son visibles o razonablemente inferibles.
- Si no podés distinguir con seguridad dos preparaciones, usá nombres genéricos ("puré", "pollo a la plancha") y confidence baja/media.
- Si no hay comida principal identificable, devolvé items vacío.

EJEMPLO DE COHERENCIA:
Si ves pechuga de pollo a la plancha y puré, deben salir DOS items separados. El pollo debería tener carbohidratos cercanos a 0; los carbohidratos principales deberían corresponder al puré.

confidence debe ser "alta", "media" o "baja".
note debe ser breve y aclarar que es una estimación visual y cuál es la mayor incertidumbre.`;

  return await env.AI.run(TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content: "Sos un asistente de registro nutricional especializado en fotos de platos. Tu prioridad es reconocer solo comida del plato principal, descartar objetos y producir macros fisiológicamente plausibles. Ante duda, omití objetos y bajá la confianza en vez de inventar."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: 1000,
    temperature: 0.05,
    response_format: {
      type: "json_schema",
      json_schema: ANALYSIS_SCHEMA
    }
  });
}

const NON_FOOD_TERMS = [
  "cuchillo","tenedor","cuchara","cubierto","cubiertos","plato","bandeja","servilleta",
  "mantel","mesa","vaso","taza","botella","envase","recipiente","bowl","bol","celular",
  "teléfono","telefono","fondo","decoración","decoracion","utensilio"
];

const ZERO_VALUE_NOISE = [
  "agua","hielo"
];

const SIMPLE_ANIMAL_PROTEINS = [
  "pollo","pechuga","carne","bife","vacío","vacio","lomo","cerdo","bondiola","pescado",
  "merluza","salmón","salmon","atún","atun","huevo","huevos","pavo"
];

function containsAny(name, terms) {
  const s = String(name || "").toLowerCase();
  return terms.some(t => s.includes(t));
}

function plausibilityFix(item) {
  const x = { ...item };
  const name = String(x.name || "").toLowerCase();

  // Carnes/pollo/pescado/huevo simples no deberían tener cargas absurdas de CHO.
  const isSimpleAnimal = containsAny(name, SIMPLE_ANIMAL_PROTEINS);
  const hasCarbPreparation =
    /empanad|rebozad|milanes|salsa|agridulce|teriyaki|barbacoa|bbq|rellen|panad|harina|masa/.test(name);

  if (isSimpleAnimal && !hasCarbPreparation && x.carbs > 3) {
    x.carbs = 0;
    x.fiber = 0;
  }

  // Valores imposibles por 1 g o cantidades grotescas: limitar a algo físicamente posible.
  const g = Math.max(0, Number(x.grams) || 0);
  if (g > 0) {
    x.protein = Math.min(x.protein, g);
    x.carbs = Math.min(x.carbs, g);
    x.fat = Math.min(x.fat, g);
    x.fiber = Math.min(x.fiber, g);
  }

  // Recalcular kcal solo si hay una incoherencia enorme.
  const macroKcal = x.protein * 4 + x.carbs * 4 + x.fat * 9;
  if (macroKcal > 0 && (x.kcal < macroKcal * 0.55 || x.kcal > macroKcal * 1.65)) {
    x.kcal = Math.round(macroKcal);
  }

  return x;
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

  analysis.items = analysis.items
    .slice(0, 12)
    .map((x) => ({
      name: String(x?.name || "Alimento").slice(0, 80),
      grams: Math.max(0, Number(x?.grams) || 0),
      kcal: Math.max(0, Number(x?.kcal) || 0),
      protein: Math.max(0, Number(x?.protein) || 0),
      carbs: Math.max(0, Number(x?.carbs) || 0),
      fat: Math.max(0, Number(x?.fat) || 0),
      fiber: Math.max(0, Number(x?.fiber) || 0)
    }))
    // Filtro duro de objetos no comestibles.
    .filter((x) => !containsAny(x.name, NON_FOOD_TERMS))
    // Quita "agua/hielo" y cualquier ruido con cero nutrición.
    .filter((x) => {
      const zeroNutrition = x.kcal === 0 && x.protein === 0 && x.carbs === 0 && x.fat === 0 && x.fiber === 0;
      if (zeroNutrition) return false;
      if (containsAny(x.name, ZERO_VALUE_NOISE)) return false;
      return true;
    })
    .map(plausibilityFix)
    // Evita items residuales sin cantidad ni aporte.
    .filter((x) => x.grams > 0 && (x.kcal > 0 || x.protein > 0 || x.carbs > 0 || x.fat > 0))
    .slice(0, 6);

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
        version: "0.3.4-photo-fix",
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
