/* Me'yor — rasmdan taomni aniqlash (Gemini).
   Muhit o'zgaruvchilari:
     GEMINI_API_KEY — Google AI Studio kaliti (majburiy)
     APP_TOKEN      — ilova bilan server orasidagi maxfiy so'z (tavsiya etiladi)
     GEMINI_MODEL   — ixtiyoriy, standart: gemini-flash-latest */
'use strict';
const KEY = process.env.GEMINI_API_KEY || '';
const TOKEN = process.env.APP_TOKEN || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL || 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3-flash-preview'])];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const START_BUDGET_MS = 50000; // Vercel 60 soniya chegarasidan oldin to'xtaymiz

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

async function analyzePhoto({ image, mime, hint, names }) {
  if (!KEY) throw Object.assign(new Error('Serverda GEMINI_API_KEY sozlanmagan'), { status: 500 });
  if (!image || image.length < 100) throw Object.assign(new Error("Rasm yuborilmadi"), { status: 400 });
  const system = SYSTEM.replace('{{NAMES}}', (Array.isArray(names) ? names.slice(0, 400).join(', ') : ''));
  const parts = [{ inline_data: { mime_type: mime || 'image/jpeg', data: image } }];
  parts.push({ text: hint ? `Foydalanuvchi izohi: ${String(hint).slice(0, 300)}` : 'Rasmdagi ovqatni tahlil qil.' });
  let lastErr, lastStatus = 0;
  const t0 = Date.now();
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - t0 > START_BUDGET_MS) break;
      let r, j;
      try {
        r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
          })
        });
        j = await r.json().catch(() => ({}));
      } catch (e) { lastStatus = 503; lastErr = e; await sleep(1500); continue; }
      if (r.ok) {
        const txt = ((((j.candidates || [])[0] || {}).content || {}).parts || []).filter(p => !p.thought && p.text).map(p => p.text).join('').trim();
        const clean = txt.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
        let data; try { data = JSON.parse(clean); } catch (e) { lastStatus = 502; lastErr = new Error('bad json'); break; }
        const items = (Array.isArray(data.items) ? data.items : []).map(x => ({
          name: String(x.name || '').slice(0, 80), grams: Math.max(0, Math.round(+x.grams || 0)),
          kcal100: Math.max(0, +x.kcal100 || 0), protein100: +x.protein100 || 0, fat100: +x.fat100 || 0, carbs100: +x.carbs100 || 0,
          confidence: Math.min(1, Math.max(0, +x.confidence || 0))
        })).filter(x => x.name && x.grams > 0).slice(0, 12);
        return { items, note: String(data.note || '').slice(0, 300), model };
      }
      lastStatus = r.status;
      lastErr = new Error('Gemini ' + r.status + ' (' + model + '): ' + ((j.error && j.error.message) || '').slice(0, 200));
      console.log(lastErr.message);
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Gemini kaliti ishlamayapti. Vercel'dagi GEMINI_API_KEY ni tekshiring."), { status: 500 });
      if (r.status === 503 || r.status === 500) { await sleep(1500 + attempt * 1500); continue; } // band — kutib qayta urinamiz
      break; // 404/400/429 — keyingi modelga o'tamiz
    }
  }
  if (lastStatus === 429) throw Object.assign(new Error('AI kunlik limiti tugadi'), { status: 429 });
  if (lastStatus === 503 || lastStatus === 500) throw Object.assign(new Error("Google AI serverlari hozir juda band. 1–2 daqiqadan keyin qayta urinib ko'ring."), { status: 503 });
  if (lastStatus === 502) throw Object.assign(new Error("AI javobini o'qib bo'lmadi. Qayta urinib ko'ring."), { status: 502 });
  throw Object.assign(new Error("AI bilan bog'lanib bo'lmadi. Qayta urinib ko'ring."), { status: 502 });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');
}
function authorized(req) { return !TOKEN || req.headers['x-app-token'] === TOKEN; }

module.exports = { analyzePhoto, cors, authorized, hasKey: () => !!KEY, hasToken: () => !!TOKEN };
