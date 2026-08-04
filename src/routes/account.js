import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const accountRouter = Router();

// DELETE /api/account
// Supprime DÉFINITIVEMENT le compte + toutes les données associées
// (cascade SQL sur profiles/cart_items/recipes_history/push_tokens).
// Nécessite d'être authentifié (voir requireAccountAuth ci-dessous) —
// contrairement au reste de l'API, ici on EXIGE un vrai compte : impossible
// de supprimer "anonymement".
accountRouter.delete('/', requireAccountAuth, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Suppression indisponible (Supabase non configuré)' });
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[account/delete]', err);
    res.status(500).json({ error: 'Suppression du compte impossible, réessaie ou contacte le support.' });
  }
});

// Contrairement à identifyRequester (qui laisse passer l'anonyme pour les
// routes IA), la suppression de compte exige un token Supabase valide.
async function requireAccountAuth(req, res, next) {
  if (!req.user?.authenticated) return res.status(401).json({ error: 'Authentification requise' });
  next();
}
