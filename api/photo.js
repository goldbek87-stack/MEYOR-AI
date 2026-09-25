const { analyzePhoto, cors, authorized } = require('../lib/ai');
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Faqat POST' });
  if (!authorized(req)) return res.status(401).json({ error: "Maxfiy so'z noto'g'ri" });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    res.status(200).json(await analyzePhoto(body));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
