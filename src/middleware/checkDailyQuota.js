import { supabaseAdmin } from '../lib/supabaseAdmin.js';

// Plafond de générations IA par jour — protège ton budget OpenAI. Ne
// s'applique qu'aux utilisateurs identifiés (compte réel) : les requêtes
// anonymes restent protégées par le seul rate-limit IP (voir server.js).
const FREE_DAILY_LIMIT = 30;
const PRO_DAILY_LIMIT = 120;

export async function checkDailyQuota(req, res, next) {
  if (!supabaseAdmin || !req.user?.authenticated) return next();

  const today = new Date().toISOString().slice(0, 10);
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('ai_generations_count, ai_generations_date, is_pro')
    .eq('id', req.user.id)
    .single();

  if (!profile) return next(); // profil pas encore créé (trigger en cours) — on laisse passer

  const isNewDay = profile.ai_generations_date !== today;
  const currentCount = isNewDay ? 0 : profile.ai_generations_count || 0;
  const limit = profile.is_pro ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;

  if (currentCount >= limit) {
    return res.status(429).json({ error: 'Limite quotidienne de générations atteinte. Réessaie demain ou passe PRO.' });
  }

  await supabaseAdmin
    .from('profiles')
    .update({ ai_generations_count: currentCount + 1, ai_generations_date: today })
    .eq('id', req.user.id);

  next();
}
