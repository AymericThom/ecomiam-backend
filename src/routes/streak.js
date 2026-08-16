import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const streakRouter = Router();

// GET /api/streak/me — pour affichage type "🔥 12 jours d'affilée" côté
// mobile. Le tracking lui-même se fait tout seul en arrière-plan à chaque
// appel API authentifié (voir lib/streaks.js + middleware/requireAuth.js) —
// cette route ne fait que LIRE le compteur, elle ne l'incrémente jamais.
streakRouter.get('/me', async (req, res) => {
  try {
    if (!req.user?.authenticated) return res.json({ currentStreak: 0, longestStreak: 0 });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Indisponible (Supabase non configuré)' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('current_streak, longest_streak, last_active_date')
      .eq('id', req.user.id)
      .single();

    res.json({
      currentStreak: profile?.current_streak || 0,
      longestStreak: profile?.longest_streak || 0,
      lastActiveDate: profile?.last_active_date || null,
    });
  } catch (err) {
    console.error('[streak/me]', err);
    res.status(500).json({ error: 'Impossible de récupérer ta série' });
  }
});
