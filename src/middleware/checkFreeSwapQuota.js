import { supabaseAdmin } from '../lib/supabaseAdmin.js';

// 🔧 Corrige une vraie faille : FREE_SWAPS_PER_WEEK (mobile/App.js) n'était
// jusqu'ici imposé QUE côté client (swapsUsed en AsyncStorage) — n'importe
// qui pouvait éditer ce fichier localement pour repasser ce compteur à 0 et
// obtenir des swaps illimités gratuitement. Ce middleware réimpose la même
// limite côté serveur, à partir de `profiles.is_pro` (vérifié en base, pas
// déclaré par le client) — donc impossible à contourner par ce biais.
//
// Ne s'applique qu'aux utilisateurs identifiés par compte réel : les
// requêtes anonymes (X-Device-Id) ne peuvent de toute façon pas persister
// de favoris ni de compte, et restent bornées par le quota IA quotidien
// (checkDailyQuota) + le rate-limit IP.
const FREE_SWAPS_PER_WEEK = 2; // ⚠️ Garder synchronisé avec FREE_SWAPS_PER_WEEK dans mobile/App.js

// Numéro de semaine ISO (lundi comme premier jour), pour que le compteur se
// réinitialise au même rythme que côté client plutôt que sur un simple
// "date - 7 jours" glissant.
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export async function checkFreeSwapQuota(req, res, next) {
  // Utilisateur anonyme (pas de compte) : rien à faire ici, voir commentaire ci-dessus.
  if (!supabaseAdmin || !req.user?.authenticated) return next();

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('is_pro, swaps_used_week, swaps_week_key')
    .eq('id', req.user.id)
    .single();

  if (!profile || profile.is_pro) return next(); // PRO : illimité, rien à compter

  const currentWeek = isoWeekKey();
  const isNewWeek = profile.swaps_week_key !== currentWeek;
  const currentCount = isNewWeek ? 0 : profile.swaps_used_week || 0;

  if (currentCount >= FREE_SWAPS_PER_WEEK) {
    return res.status(403).json({
      error: `Limite de ${FREE_SWAPS_PER_WEEK} changements de plats gratuits par semaine atteinte. Passe PRO pour des swaps illimités.`,
      code: 'FREE_SWAP_LIMIT_REACHED',
    });
  }

  await supabaseAdmin
    .from('profiles')
    .update({ swaps_used_week: currentCount + 1, swaps_week_key: currentWeek })
    .eq('id', req.user.id);

  next();
}
