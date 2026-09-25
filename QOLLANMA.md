# Me'yor — AI server (rasm orqali hisoblash)

Gemini kaliti ilovada emas, shu serverda saqlanadi. Server bepul.

## 1. Gemini kaliti
1. https://aistudio.google.com ga Google akkaunt bilan kiring.
2. "Get API key" → "Create API key" → kalitni nusxalab oling.
   (ORIF uchun olingan kalit bo'lsa, o'shani ishlatsangiz ham bo'ladi.)

## 2. GitHub
Yangi repository oching, masalan `meyor-ai`, va zip ichidagi hamma fayllarni yuklang:
`api/`, `lib/`, `index.js`, `package.json`, `vercel.json`.

## 3. Vercel (tavsiya etiladi)
Render'dagi 750 soatlik bepul limitni botlaringiz ishlatyapti, shuning uchun bu serverni Vercel'ga qo'yamiz.
Vercel'da soat limiti yo'q, server uxlamaydi, javob tez keladi.

1. https://vercel.com → "Sign Up" → "Continue with GitHub".
2. "Add New…" → "Project" → `meyor-ai` repository'ni tanlang → "Import".
3. "Framework Preset": **Other** bo'lib qolsin. Build sozlamalariga tegmang.
4. "Environment Variables" bo'limiga ikkita o'zgaruvchi qo'shing:
   - `GEMINI_API_KEY` = Gemini kalitingiz
   - `APP_TOKEN` = o'zingiz o'ylab topgan maxfiy so'z, masalan `meyor-2026-abc`
5. "Deploy" ni bosing. 1 daqiqada tayyor bo'ladi.
6. Loyiha sahifasidagi "Domains" manzilini nusxalang (masalan `https://meyor-ai.vercel.app`).

Tekshirish: brauzerda `https://SIZNING-MANZIL/api/health` ni oching.
`Maxfiy so'z noto'g'ri` degan javob chiqsa — server ishlayapti (brauzer maxfiy so'z yubormaydi, bu normal).

## 3-B. Render (muqobil)
Web Service → Runtime: Node → Build: `npm install` → Start: `npm start` → Free.
Environment'ga o'sha ikki o'zgaruvchini qo'shing. Eslatma: bepul Render 15 daqiqa ishlatilmasa uxlaydi,
birinchi rasm 30–60 soniya kutadi.

## 4. Ilovada ulash
Me'yor → Profil → "Rasm orqali hisoblash (AI)":
- Server manzili: Vercel bergan manzil
- Maxfiy so'z: APP_TOKEN qiymati
"Saqlash va tekshirish" → "✓ Ulandi" chiqishi kerak.

## Limitlar
Gemini bepul tarifida kunlik so'rovlar soni cheklangan (odatda yuzlab rasm — oddiy foydalanish uchun yetarli).
Limit tugasa, ilova buni aytadi va matn bilan yozish ishlayveradi.
Boshqa model ishlatish uchun `GEMINI_MODEL` o'zgaruvchisini qo'shing (standart: `gemini-flash-latest`).
