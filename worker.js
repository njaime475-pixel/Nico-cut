const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

function json(data, status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
  });
}

async function runVision(env, image){
  const prompt = `Analizá la foto de este plato para registrar nutrición.
Identificá SOLO alimentos razonablemente visibles. Estimá gramos y macros de cada alimento.
No afirmes precisión: una foto no permite conocer peso, aceite, salsas ni ingredientes ocultos exactamente.
Respondé SOLO JSON válido, sin markdown:
{"items":[{"name":"alimento","grams":150,"kcal":250,"protein":30,"carbs":20,"fat":6,"fiber":2}],"confidence":"alta|media|baja","note":"aclaración breve"}
Usá números, no strings. Si no es una comida o la imagen no permite estimar, devolvé items vacío y explicalo en note.`;

  const args = {
    messages:[
      {role:"system",content:"Sos un asistente de registro nutricional. Priorizá estimaciones conservadoras y explícitamente aproximadas."},
      {role:"user",content:prompt}
    ],
    image,
    max_tokens:700,
    temperature:0.1
  };

  try{
    return await env.AI.run(MODEL,args);
  }catch(err){
    const msg=String(err?.message||err);
    if(/agree|license|acceptable use/i.test(msg)){
      await env.AI.run(MODEL,{prompt:"agree"});
      return await env.AI.run(MODEL,args);
    }
    throw err;
  }
}

export default {
  async fetch(request, env){
    const url=new URL(request.url);

    if(url.pathname==="/api/health"){
      return json({ok:true,service:"nico-cut-ai",ai:!!env.AI});
    }

    if(url.pathname==="/api/analyze"){
      if(request.method!=="POST") return json({ok:false,error:"Usá POST."},405);
      try{
        const body=await request.json();
        if(!body?.image || typeof body.image!=="string") return json({ok:false,error:"Falta la imagen."},400);
        if(body.image.length>9_000_000) return json({ok:false,error:"La foto es demasiado grande."},413);

        const result=await runVision(env,body.image);
        let text=result?.response ?? result?.result ?? result;
        if(typeof text!=="string") text=JSON.stringify(text);
        text=text.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/,"").trim();

        let analysis;
        try{analysis=JSON.parse(text)}
        catch{ return json({ok:false,error:"La IA respondió, pero no pude interpretar la estimación.",raw:text},502); }

        if(!Array.isArray(analysis.items)) analysis.items=[];
        analysis.items=analysis.items.slice(0,12).map(x=>({
          name:String(x.name||"Alimento").slice(0,80),
          grams:Number(x.grams)||0,kcal:Number(x.kcal)||0,
          protein:Number(x.protein)||0,carbs:Number(x.carbs)||0,
          fat:Number(x.fat)||0,fiber:Number(x.fiber)||0
        }));
        return json({ok:true,analysis});
      }catch(err){
        return json({ok:false,error:String(err?.message||"Error analizando la foto.")},500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
