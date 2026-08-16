import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { touchStreak } from '../lib/streaks.js';

// Identifie qui fait la requête, SANS bloquer l'usage anonyme (l'app doit
// rester utilisable sans compte). Trois cas :
//  1. Token Supabase valide  → req.user = { id: <uuid réel>, authenticated: true }
//     → bénéficie du quota IA nominatif (checkDailyQuota) et de la sync cloud.
//  2. Header X-Device-Id présent (généré une fois par le mobile, voir
//     mobile/src/config.js) → req.user = { id: 'device:<uuid>', authenticated: false }
//     → protégé uniquement par le rate-limit IP (pas de quota nominatif).
//  3. Rien du tout → requête anonyme générique, rate-limitée par IP seulement.
export async function identifyRequester(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token && supabaseAdmin) {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && data?.user) {
      req.user = { id: data.user.id, authenticated: true };
      // ⚡ NOUVEAU : fire-and-forget — jamais attendu, jamais laissé faire
      // planter la requête en cours (voir lib/streaks.js). Comme ce
      // middleware tourne sur quasi toutes les routes authentifiées, le
      // tracking de série démarre pour tout le monde sans rien changer côté
      // mobile ni ajouter d'appel réseau dédié.
      touchStreak(data.user.id).catch(() => {});
      return next();
    }
    // Token présent mais invalide/expiré → on ne bloque pas, on redégrade en anonyme.
  }

  const deviceId = req.headers['x-device-id'];
  req.user = { id: deviceId ? `device:${deviceId}` : 'anonymous', authenticated: false };
  next();
}
