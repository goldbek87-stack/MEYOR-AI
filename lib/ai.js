/* Me'yor — rasmdan taomni aniqlash (Gemini, zaxirada Groq).
   Muhit o'zgaruvchilari (Vercel -> Settings -> Environment Variables):
     GEMINI_API_KEY — Google AI Studio kaliti
     GROQ_API_KEY   — ixtiyoriy, Gemini limiti tugaganda zaxira sifatida ishlatiladi
     APP_TOKEN      — ilova bilan server orasidagi maxfiy so'z (tavsiya etiladi)
     GEMINI_MODEL   — ixtiyoriy, standart: gemini-flash-latest
     GROQ_MODEL     — ixtiyoriy, rasm qabul qiladigan Groq modeli (birinchi shu sinaladi)
     PER_IP_DAILY   — ixtiyoriy, bitta IP uchun kunlik rasm limiti (standart 15)
     GLOBAL_DAILY   — ixtiyoriy, butun server uchun kunlik rasm limiti (standart 500)
   Eslatma: ikkala kalitdan kamida bittasi bo'lishi shart. */
'use strict';
const KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const TOKEN = process.env.APP_TOKEN || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3-flash-preview'])];
const GROQ_MODELS = [...new Set([process.env.GROQ_MODEL || '', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3.6-27b'].filter(Boolean))];
const PER_IP_DAILY = Math.max(1, +process.env.PER_IP_DAILY || 15);
const GLOBAL_DAILY = Math.max(1, +process.env.GLOBAL_DAILY || 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOTAL_BUDGET_MS = 55000;                          // Vercel 60 soniya chegarasidan oldin to'xtaymiz
const GEMINI_BUDGET_MS = GROQ_KEY ? 25000 : 50000;      // Groq bo'lsa, Gemini'ga kamroq vaqt beramiz
const CALL_TIMEOUT_MS = 20000;                          // bitta so'rov uchun maksimal vaqt

const SYSTEM = `Sen ovqatlanish bo'yicha mutaxassis va dietologsan. Foydalanuvchi yuborgan rasmdagi BARCHA taom va ichimliklarni aniqla, har birining og'irligini grammda (ichimlik bo'lsa ml da) taxmin qil.
Qoidalar:
- Taom nomlarini o'zbek tilida (lotin yozuvi) yoz. Iloji bo'lsa, quyidagi ro'yxatdagi nomlardan birini aynan ishlat: {{NAMES}}
- O'zbek oshxonasini yaxshi bil: palov, lag'mon, manti, somsa, shashlik, sho'rva, non va hokazo.
- Og'irlikni o'lchamga qarab taxmin qil: standart tovoq diametri ~26 sm, chinni (kosa) ~350–450 ml, piyola ~150 ml, stakan ~250 ml, obi non ~250 g, bir six shashlik ~80 g go'sht. Qoshiq, qo'l, telefon kabi narsalar ko'rinsa, ulardan o'lcham uchun foydalan.
- Yog' va go'sht miqdorini ko'rinishiga qarab hisobga ol (yog'li palov kaloriyasi yuqoriroq).
- kcal100, protein100, fat100, carbs100 — 100 g (yoki 100 ml) uchun qiymatlar, dunyo ma'lumotnomalari (USDA va boshqalar) bo'yicha.
- confidence: 0 dan 1 gacha — taomni qanchalik ishonch bilan tanidingiz.
- Rasmda ovqat bo'lmasa, items bo'sh ro'yxat bo'lsin va note maydonida sababini yoz.
- note: o'zbek tilida 1 qisqa gap (masalan, noaniq joylar haqida).
Faqat JSON qaytar, boshqa hech narsa yozma:
{"items":[{"name":"Palov","grams":350,"kcal100":230,"protein100":7,"fat100":12,"carbs100":24,"confidence":0.85}],"note":"..."}`;

/* ---------- Kunlik limitlar (xotirada; server qayta ishga tushsa nolga tushadi) ---------- */
const usage = { day: '', global: 0, ips: new Map() };
function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : (req.socket && req.socket.remoteAddress)) || 'unknown';
}
/* Limitdan oshgan bo'lsa 429 xatosini tashlaydi. Aks holda "qaytarish" funksiyasini beradi:
   AI xato bersa, foydalanuvchining limiti behuda sarflanmasligi uchun uni chaqiramiz. */
function takeQuota(req) {
  const day = new Date().toISOString().slice(0, 10);
  if (usage.day !== day) { usage.day = day; usage.global = 0; usage.ips = new Map(); }
  const ip = clientIp(req);
  const n = usage.ips.get(ip) || 0;
  if (usage.global >= GLOBAL_DAILY) throw Object.assign(new Error('AI kunlik limiti tugadi'), { status: 429 });
  if (n >= PER_IP_DAILY) throw Object.assign(new Error('Bugungi rasm limitingiz tugadi'), { status: 429 });
  usage.global++; usage.ips.set(ip, n + 1);
  let done = false;
  return () => {
    if (done || usage.day !== day) return;
    done = true;
    usage.global = Math.max(0, usage.global - 1);
    usage.ips.set(ip, Math.max(0, (usage.ips.get(ip) || 1) - 1));
  };
}

/* ---------- Yordamchi funksiyalar ---------- */
function parseJson(txt) {
  let t = String(txt || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) { /* pastda yana urinamiz */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* bo'sh */ } }
  return null;
}
function normalize(data) {
  const items = (Array.isArray(data.items) ? data.items : []).map(x => ({
    name: String(x.name || '').slice(0, 80), grams: Math.max(0, Math.round(+x.grams || 0)),
    kcal100: Math.max(0, +x.kcal100 || 0), protein100: +x.protein100 || 0, fat100: +x.fat100 || 0, carbs100: +x.carbs100 || 0,
    confidence: Math.min(1, Math.max(0, +x.confidence || 0))
  })).filter(x => x.name && x.grams > 0).slice(0, 12);
  return { items, note: String(data.note || '').slice(0, 300) };
}

/* ---------- 1) Gemini ---------- */
async function viaGemini(system, parts, t0, st) {
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - t0 > GEMINI_BUDGET_MS) return null;
      let r, j;
      try {
        r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
          })
        });
        j = await r.json().catch(() => ({}));
      } catch (e) { st.status = 503; await sleep(1500); continue; }
      if (r.ok) {
        const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('');
        const data = parseJson(txt);
        if (!data) { st.status = 502; break; }
        return { ...normalize(data), model };
      }
      st.status = r.status;
      console.log('Gemini ' + r.status + ' (' + model + '): ' + ((j.error && j.error.message) || '').slice(0, 200));
      if (r.status === 429) st.rate = true;
      if (r.status === 401 || r.status === 403) { st.keyBad = true; return null; }
      if (r.status === 503 || r.status === 500) { await sleep(1500 + attempt * 1500); continue; } // band — kutib qayta urinamiz
      break; // 404/400/429 — keyingi modelga o'tamiz
    }
  }
  return null;
}

/* ---------- 2) Groq (zaxira) ---------- */
async function viaGroq(system, image, mime, hintText, t0, st) {
  if (!GROQ_KEY) return null;
  for (const model of GROQ_MODELS) {
    if (Date.now() - t0 > TOTAL_BUDGET_MS - CALL_TIMEOUT_MS) return null;
    let r, j;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        body: JSON.stringify({
          model, temperature: 0.2, max_tokens: 2000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: [
              { type: 'text', text: hintText },
              { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/jpeg') + ';base64,' + image } }
            ] }
          ]
        })
      });
      j = await r.json().catch(() => ({}));
    } catch (e) { console.log('Groq ulanish xatosi (' + model + ')'); continue; }
    if (r.ok) {
      const txt = (((j.choices || [])[0] || {}).message || {}).content || '';
      const data = parseJson(txt);
      if (!data) { console.log('Groq noto\'g\'ri JSON (' + model + ')'); continue; }
      return { ...normalize(data), model: 'groq:' + model };
    }
    console.log('Groq ' + r.status + ' (' + model + '): ' + ((j.error && j.error.message) || '').slice(0, 200));
    if (r.status === 429) st.rate = true;
    if (r.status === 401) return null; // kalit noto'g'ri — boshqa modelni sinash foydasiz
  }
  return null;
}

/* ---------- Asosiy funksiya ---------- */
async function analyzePhoto({ image, mime, hint, names }) {
  if (!KEY && !GROQ_KEY) throw Object.assign(new Error('Serverda GEMINI_API_KEY (yoki GROQ_API_KEY) sozlanmagan'), { status: 500 });
  if (!image || image.length < 100) throw Object.assign(new Error('Rasm yuborilmadi'), { status: 400 });
  const system = SYSTEM.replace('{{NAMES}}', (Array.isArray(names) ? names.slice(0, 400).join(', ') : ''));
  const hintText = hint ? `Foydalanuvchi izohi: ${String(hint).slice(0, 300)}` : 'Rasmdagi ovqatni tahlil qil.';
  const parts = [{ inline_data: { mime_type: mime || 'image/jpeg', data: image } }, { text: hintText }];
  const st = { status: 0, rate: false, keyBad: false };
  const t0 = Date.now();

  let out = KEY ? await viaGemini(system, parts, t0, st) : null;
  if (!out) out = await viaGroq(system, image, mime, hintText, t0, st);
  if (out) { console.log('AI javob: ' + out.model); return out; }

  if (st.keyBad && !GROQ_KEY) throw Object.assign(new Error("Gemini kaliti ishlamayapti. Vercel'dagi GEMINI_API_KEY ni tekshiring."), { status: 500 });
  if (st.rate) throw Object.assign(new Error('AI kunlik limiti tugadi'), { status: 429 });
  if (st.status === 503 || st.status === 500) throw Object.assign(new Error("AI serverlari hozir juda band. 1–2 daqiqadan keyin qayta urinib ko'ring."), { status: 503 });
  if (st.status === 502) throw Object.assign(new Error("AI javobini o'qib bo'lmadi. Qayta urinib ko'ring."), { status: 502 });
  throw Object.assign(new Error("AI bilan bog'lanib bo'lmadi. Qayta urinib ko'ring."), { status: 502 });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
}
function authorized(req) { return !TOKEN || req.headers['x-app-token'] === TOKEN; }

module.exports = { analyzePhoto, cors, authorized, takeQuota, hasKey: () => !!(KEY || GROQ_KEY), hasToken: () => !!TOKEN };
