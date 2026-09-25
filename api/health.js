const { cors, authorized, hasKey } = require('../lib/ai');
module.exports = (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "Maxfiy so'z noto'g'ri" });
  res.status(200).json({ ok: true, key: hasKey(), app: "meyor-ai" });
};
