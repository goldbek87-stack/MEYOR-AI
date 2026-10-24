/* Me'yor — rasmdan taomni aniqlash (Gemini + zaxirada Groq).
   Muhit o'zgaruvchilari (Vercel -> Settings -> Environment Variables):
     GEMINI_API_KEY — Google AI Studio kaliti
     GROQ_API_KEY   — ixtiyoriy, zaxira (Groq) uchun
     APP_TOKEN      — ilova bilan server orasidagi maxfiy so'z (tavsiya etiladi)
     GEMINI_MODEL   — ixtiyoriy, asosiy model (standart: gemini-3.1-flash-lite)
     GROQ_MODEL     — ixtiyoriy, Groq'ning rasm qabul qiladigan modeli (standart: qwen/qwen3.8-27b)
     GROQ_REASONING — ixtiyoriy, Groq "o'ylash" darajasi (standart: none; bo'sh qoldirsangiz yuborilmaydi)
     THINKING_LEVEL — ixtiyoriy, Gemini 3.x "o'ylash" darajasi (standart: minimal)
     HEDGE_MS       — ixtiyoriy, har keyingi zaxira urinish shuncha ms dan keyin parallel boshlanadi (standart 2500)
     PER_IP_DAILY   — ixtiyoriy, bitta IP uchun kunlik rasm limiti (standart 15)
     GLOBAL_DAILY   — ixtiyoriy, butun server uchun kunlik rasm limiti (standart 500)
   Ishlash tartibi: asosiy Gemini darhol boshlanadi. U HEDGE_MS ichida javob bermasa (yoki xato bersa),
   ikkinchi Gemini (boshqa arzon model), keyin Groq, oxirida gemini-3.6-flash parallel qo'shiladi.
   Birinchi to'g'ri javob yutadi, qolganlari bekor qilinadi. */
'use strict';
const KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const TOKEN = process.env.APP_TOKEN || '';
const PRIMARY = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const LITE_MODELS = [...new Set([PRIMARY, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])].slice(0, 2);
const LAST_RESORT = 'gemini-3.6-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const GROQ_REASONING = process.env.GROQ_REASONING === undefined ? 'none' : process.env.GROQ_REASONING;
const THINK = process.env.THINKING_LEVEL || 'minimal';
const HEDGE_MS = Math.max(0, +process.env.HEDGE_MS || 2500);
const PER_IP_DAILY = Math.max(1, +process.env.PER_IP_DAILY || 15);
const GLOBAL_DAILY = Math.max(1, +process.env.GLOBAL_DAILY || 500);
const CALL_TIMEOUT_MS = 12000;                          // bitta so'rov uchun maksimal vaqt

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

/* ---------- Bekor qilish signali ---------- */
function sig(ctrl) {
  const t = AbortSignal.timeout(CALL_TIMEOUT_MS);
  return (typeof AbortSignal.any === 'function') ? AbortSignal.any([t, ctrl.signal]) : t;
}

/* ---------- 1) Gemini ---------- */
function genConfig(model) {
  const g = { responseMimeType: 'application/json', maxOutputTokens: 1200 };
  if (/gemini-3/.test(model)) g.thinkingConfig = { thinkingLevel: THINK }; // 3.x: temperature e'tiborga olinmaydi
  else g.temperature = 0.2;
  return g;
}
async function callGemini(model, system, parts, st, ctrl) {
  let r, j;
  try {
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      signal: sig(ctrl),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: genConfig(model)
      })
    });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    if (!ctrl.signal.aborted) { st.status = 503; console.log('Gemini ulanish xatosi (' + model + ')'); }
    return null;
  }
  if (r.ok) {
    const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('');
    const data = parseJson(txt);
    if (!data) { st.status = 502; console.log("Gemini noto'g'ri JSON (" + model + ')'); return null; }
    return { ...normalize(data), model };
  }
  st.status = r.status;
  console.log('Gemini ' + r.status + ' (' + model + '): ' + ((j.error && j.error.message) || '').slice(0, 200));
  if (r.status === 429) st.rate = true;
  if (r.status === 401 || r.status === 403) st.keyBad = true;
  return null;
}

/* ---------- 2) Groq (zaxira) ---------- */
async function callGroq(model, system, image, mime, hintText, st, ctrl) {
  const body = withReasoning => JSON.stringify({
    model, temperature: 0.2, max_tokens: 1500,
    ...(withReasoning ? { reasoning_effort: GROQ_REASONING } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text: hintText },
        { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/jpeg') + ';base64,' + image } }
      ] }
    ]
  });
  for (const withReasoning of (GROQ_REASONING ? [true, false] : [false])) {
    let r, j;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        signal: sig(ctrl),
        body: body(withReasoning)
      });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      if (!ctrl.signal.aborted) console.log('Groq ulanish xatosi (' + model + ')');
      return null;
    }
    if (r.ok) {
      const txt = (((j.choices || [])[0] || {}).message || {}).content || '';
      const data = parseJson(txt);
      if (!data) { console.log("Groq noto'g'ri JSON (" + model + ')'); return null; }
      return { ...normalize(data), model: 'groq:' + model };
    }
    console.log('Groq ' + r.status + ' (' + model + '): ' + ((j.error && j.error.message) || '').slice(0, 200));
    if (r.status === 400 && withReasoning) continue; // reasoning_effort qabul qilinmadi — usiz qayta urinamiz
    if (r.status === 429) st.rate = true;
    return null;
  }
  return null;
}

/* ---------- Bosqichma-bosqich parallel urinishlar ----------
   Birinchi urinish darhol boshlanadi. Keyingisi: oldingisi xato bersa — darhol, aks holda gapMs dan keyin.
   Birinchi to'g'ri javob yutadi. */
function staggered(attempts, run, gapMs) {
  return new Promise(resolve => {
    let next = 0, failed = 0, won = false, timer = null;
    const settle = v => {
      if (won) return;
      if (v) { won = true; clearTimeout(timer); return resolve(v); }
      failed++;
      if (failed >= attempts.length) return resolve(null);
      if (next < attempts.length) launch();
    };
    const launch = () => {
      if (won || next >= attempts.length) return;
      const a = attempts[next++];
      Promise.resolve().then(() => run(a)).then(settle, () => settle(null));
      clearTimeout(timer);
      if (next < attempts.length) timer = setTimeout(launch, gapMs);
    };
    if (!attempts.length) return resolve(null);
    launch();
  });
}

/* ---------- Asosiy funksiya ---------- */
async function analyzePhoto({ image, mime, hint, names }) {
  if (!KEY && !GROQ_KEY) throw Object.assign(new Error('Serverda GEMINI_API_KEY (yoki GROQ_API_KEY) sozlanmagan'), { status: 500 });
  if (!image || image.length < 100) throw Object.assign(new Error('Rasm yuborilmadi'), { status: 400 });
  const system = SYSTEM.replace('{{NAMES}}', (Array.isArray(names) ? names.slice(0, 400).join(', ') : ''));
  const hintText = hint ? `Foydalanuvchi izohi: ${String(hint).slice(0, 300)}` : 'Rasmdagi ovqatni tahlil qil.';
  const parts = [{ inline_data: { mime_type: mime || 'image/jpeg', data: image } }, { text: hintText }];
  const st = { status: 0, rate: false, keyBad: false };
  const ctrl = new AbortController();
  const t0 = Date.now();

  const attempts = [];
  if (KEY) LITE_MODELS.forEach(m => attempts.push({ kind: 'gemini', model: m }));
  if (GROQ_KEY) attempts.push({ kind: 'groq', model: GROQ_MODEL });
  if (KEY && !LITE_MODELS.includes(LAST_RESORT)) attempts.push({ kind: 'gemini', model: LAST_RESORT });

  const run = a => a.kind === 'gemini'
    ? callGemini(a.model, system, parts, st, ctrl)
    : callGroq(a.model, system, image, mime, hintText, st, ctrl);

  const out = await staggered(attempts, run, HEDGE_MS);
  ctrl.abort(); // yutqazganlarni to'xtatamiz
  if (out) { out.ms = Date.now() - t0; console.log('AI javob: ' + out.model + ' ' + out.ms + 'ms'); return out; }

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
