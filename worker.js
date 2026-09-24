const GEMINI_MODEL = "gemini-3.1-flash-lite";
const CLOUDFLARE_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          grams: { type: "NUMBER" },
          kcal: { type: "NUMBER" },
          protein: { type: "NUMBER" },
          carbs: { type: "NUMBER" },
          fat: { type: "NUMBER" },
          fiber: { type: "NUMBER" },
          confidence: { type: "STRING", enum: ["alta", "media", "baja"] },
          note: { type: "STRING" }
        },
        required: ["name", "grams", "kcal", "protein", "carbs", "fat", "fiber", "confidence", "note"]
      }
    },
    totals: {
      type: "OBJECT",
      properties: {
        kcal: { type: "NUMBER" },
        protein: { type: "NUMBER" },
        carbs: { type: "NUMBER" },
        fat: { type: "NUMBER" },
        fiber: { type: "NUMBER" }
      },
      required: ["kcal", "protein", "carbs", "fat", "fiber"]
    },
    confidence: { type: "STRING", enum: ["alta", "media", "baja"] },
    note: { type: "STRING" }
  },
  required: ["items", "totals", "confidence", "note"]
};

function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!m) throw new Error("Formato de imagen inválido.");
  const mimeType = m[1].toLowerCase();
  if (!mimeType.startsWith("image/")) throw new Error("El archivo no es una imagen.");
  return { mimeType, data: m[2] };
}

function normalizeAnalysis(a) {
  const n = v => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;
  const items = Array.isArray(a?.items) ? a.items.slice(0, 12).map(it => ({
    name: String(it?.name || "Alimento").trim().slice(0, 120),
    grams: n(it?.grams),
    kcal: n(it?.kcal),
    protein: n(it?.protein),
    carbs: n(it?.carbs),
    fat: n(it?.fat),
    fiber: n(it?.fiber),
    confidence: ["alta", "media", "baja"].includes(it?.confidence) ? it.confidence : "media",
    note: String(it?.note || "").slice(0, 240)
  })) : [];

  const totals = items.reduce((t, it) => ({
    kcal: t.kcal + it.kcal,
    protein: t.protein + it.protein,
    carbs: t.carbs + it.carbs,
    fat: t.fat + it.fat,
    fiber: t.fiber + it.fiber
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

  return {
    items,
    totals,
    confidence: ["alta", "media", "baja"].includes(a?.confidence) ? a.confidence : "media",
    note: String(a?.note || "Estimación visual; corregí los gramos si pesaste la comida.").slice(0, 300)
  };
}

async function cloudflareAnalysis(env, image, prompt, corsHeaders) {
  if (!env.AI) throw new Error("Cloudflare AI no está configurado.");
  const result = await env.AI.run(CLOUDFLARE_MODEL, {
    messages: [
      { role: "system", content: "Respondé únicamente JSON válido para estimación nutricional visual." },
      { role: "user", content: `${prompt}\nRespondé SOLO JSON con items (name, grams, kcal, protein, carbs, fat, fiber, confidence, note), confidence y note.` }
    ],
    image,
    temperature: 0.2,
    max_tokens: 1400
  });
  const responseText = String(result?.response ?? result?.result ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(responseText);
  const analysis = normalizeAnalysis(parsed);
  if (!analysis.items.length) throw new Error("Cloudflare no reconoció alimentos en la imagen.");
  return jsonResponse({ ok: true, provider: "cloudflare-workers-ai", model: CLOUDFLARE_MODEL, analysis }, 200, corsHeaders);
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") return jsonResponse({ ok: false, error: "Usá POST." }, 405, corsHeaders);

    const url = new URL(request.url);
    if (url.pathname !== "/api/analyze") {
      return jsonResponse({ ok: false, error: "Ruta no encontrada." }, 404, corsHeaders);
    }

    try {
      const body = await request.json();
      const { mimeType, data } = parseDataUrl(body.image);
      const weightGramsRaw = Number(body.weightGrams);
      const weightGrams = Number.isFinite(weightGramsRaw) && weightGramsRaw > 0 ? Math.min(weightGramsRaw, 5000) : null;
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 300) : "";

      // Evita enviar fotos absurdamente grandes al proveedor.
      // 12 MB en base64 ronda ~9 MB binarios; la app ya debería comprimir antes.
      if (data.length > 12_000_000) {
        return jsonResponse({ ok: false, error: "La foto es demasiado grande. Probá con una imagen más liviana." }, 413, corsHeaders);
      }

      const userContext = [
        weightGrams ? `Peso total informado por el usuario: ${weightGrams} g.` : "",
        description ? `Descripción informada por el usuario: ${description}` : ""
      ].filter(Boolean).join("\n");

      const prompt = `
Analizá esta foto de una comida para un registro nutricional.
${userContext ? `\nDATOS APORTADOS POR EL USUARIO (priorizalos sobre una inferencia visual cuando no haya contradicción evidente):\n${userContext}\n` : ""}
Identificá cada alimento visible por separado y estimá calorías, proteínas, carbohidratos, grasas y fibra correspondientes A ESA PORCIÓN, no por 100 g.

Reglas importantes:
- Si el usuario informó el peso total, NO vuelvas a adivinar el peso total: tomalo como dato conocido. Si hay varios alimentos, distribuí ese peso entre los items de forma razonable y hacé que la suma de grams sea aproximadamente ese peso.
- Si el usuario dio una descripción del alimento/plato, usala como contexto principal para identificarlo. Por ejemplo, si dice "scone de queso", no lo renombres como pan común solo porque visualmente se parezca.
- Si NO hay peso informado, una sola foto no permite conocer pesos exactos: estimá con prudencia.
- La descripción puede revelar ingredientes o preparación que no se distinguen bien en la imagen; usalos si son plausibles y no contradicen claramente la foto.
- No inventes ingredientes ocultos que ni la foto ni la descripción sugieran. Si aceite, salsa, relleno o método de cocción siguen siendo inciertos, indicá la incertidumbre en note.
- Si el alimento parece empanado/rebozado/frito, reflejalo en la estimación solo cuando sea visualmente razonable o esté indicado en la descripción.
- Separá acompañamientos distintos (por ejemplo pollo, arroz, queso) en items distintos.
- No dupliques alimentos.
- Si no podés reconocer comida con suficiente confianza, devolvé items vacío y confidence baja.
- Los totales deben corresponder a la suma de los items.
- Es una estimación nutricional, no un diagnóstico médico.
`;

      // Primero Cloudflare; Gemini cubre fallas o respuestas no utilizables.
      let cloudflareError;
      try { return await cloudflareAnalysis(env, body.image, prompt, corsHeaders); }
      catch (err) { cloudflareError = err; }

      if (!env.GEMINI_API_KEY) {
        throw new Error(`No se pudo analizar la foto con Cloudflare: ${cloudflareError?.message || "servicio no disponible"}. Gemini no está configurado.`);
      }

      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { inlineData: { mimeType, data } },
                { text: prompt }
              ]
            }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 1200,
              responseMimeType: "application/json",
              responseSchema: RESPONSE_SCHEMA
            }
          })
        }
      );

      const raw = await geminiResponse.text();
      if (!geminiResponse.ok) {
        let detail = raw;
        try { detail = JSON.parse(raw)?.error?.message || raw; } catch {}
        return jsonResponse({ ok: false, error: `Gemini: ${String(detail).slice(0, 500)}` }, geminiResponse.status, corsHeaders);
      }

      let payload;
      try { payload = JSON.parse(raw); }
      catch { throw new Error("Gemini devolvió una respuesta HTTP inválida."); }

      const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("")?.trim();
      if (!text) {
        const reason = payload?.candidates?.[0]?.finishReason || "sin contenido";
        throw new Error(`Gemini no devolvió análisis (${reason}).`);
      }

      let parsed;
      try { parsed = JSON.parse(text); }
      catch { throw new Error("Gemini respondió, pero el JSON nutricional no pudo interpretarse."); }

      return jsonResponse({
        ok: true,
        provider: "google-gemini",
        model: GEMINI_MODEL,
        analysis: normalizeAnalysis(parsed)
      }, 200, corsHeaders);
    } catch (err) {
      return jsonResponse({ ok: false, error: err?.message || "Error analizando la imagen." }, 500, corsHeaders);
    }
  }
};
