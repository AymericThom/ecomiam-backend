import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const accountRouter = Router();

// ⚡ NOUVEAU : GET /api/account/export — droit à la portabilité des
// données (RGPD art. 20). Renvoie tout ce que Kaba sait sur le compte, en
// JSON brut téléchargeable. Interrogé table par table avec un filet de
// sécurité individuel : si une table n'existe pas ou qu'une requête
// échoue, on l'omet du résultat plutôt que de faire échouer tout l'export
// pour une table annexe.
accountRouter.get('/export', requireAccountAuth, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Export indisponible (Supabase non configuré)' });

    const userId = req.user.id;
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);

    const safeQuery = async (table, builderFn) => {
      try {
        const { data, error } = await builderFn(supabaseAdmin.from(table));
        if (error) return null;
        return data;
      } catch {
        return null;
      }
    };

    const [profile, pushTokens, cartItems, recipesHistory, familyGroupOwned] = await Promise.all([
      safeQuery('profiles', (q) => q.select('*').eq('id', userId).single()),
      safeQuery('push_tokens', (q) => q.select('expo_push_token, created_at').eq('user_id', userId)),
      safeQuery('cart_items', (q) => q.select('*').eq('user_id', userId)),
      safeQuery('recipes_history', (q) => q.select('*').eq('user_id', userId)),
      safeQuery('family_groups', (q) => q.select('id, name, created_at').eq('owner_id', userId)),
    ]);

    // ⚡ NOUVEAU : le groupe famille dont on est MEMBRE (pas seulement celui
    // qu'on a créé) manquait — on ne voyait que la moitié du lien famille.
    const familyGroupMember = profile?.family_group_id
      ? await safeQuery('family_groups', (q) =>
          q.select('id, name, created_at, owner_id').eq('id', profile.family_group_id).single(),
        )
      : null;

    // ⚡ NOUVEAU : le JSON complet (profil brut avec tout le household en
    // JSONB imbriqué) est exhaustif mais peu lisible tel quel — un résumé à
    // plat en tête d'export rend visible d'un coup d'œil ce que Kaba sait
    // réellement, plutôt que de devoir fouiller dans la structure imbriquée
    // pour s'en rendre compte.
    const household = profile?.household || {};
    const resume = {
      pseudo: household.displayName || null,
      budget_hebdo: household.budget ?? null,
      devise: household.currency || null,
      regime: household.diet || null,
      allergies: household.allergies || [],
      aliments_evites: household.dislikedIngredients || [],
      aliments_preferes: household.lovedIngredients || [],
      equipement_cuisine: household.equipment || [],
      statut_abonnement: profile
        ? {
            pro: !!profile.is_pro,
            origine: profile.pro_source || 'own',
            expire_le: profile.subscription_expires_at || null,
            periode_essai: !!profile.is_trial,
          }
        : null,
      gamification: profile
        ? {
            xp_total: profile.xp || 0,
            serie_actuelle: profile.current_streak || 0,
            meilleure_serie: profile.longest_streak || 0,
          }
        : null,
      parrainage: profile
        ? {
            mon_code: profile.referral_code || null,
            parrainé_par: profile.referred_by || null,
            filleuls_confirmés: profile.referral_confirmed_count || 0,
          }
        : null,
    };

    res.setHeader('Content-Disposition', 'attachment; filename="kaba-mes-donnees.json"');
    res.json({
      export_genere_le: new Date().toISOString(),
      compte: {
        id: userId,
        email: authUser?.user?.email || null,
        cree_le: authUser?.user?.created_at || null,
      },
      resume,
      profil_complet: profile || null,
      tokens_notifications: pushTokens || [],
      panier: cartItems || [],
      historique_recettes: recipesHistory || [],
      groupe_famille_cree: familyGroupOwned || [],
      groupe_famille_membre: familyGroupMember || null,
    });
  } catch (err) {
    console.error('[account/export]', err);
    res.status(500).json({ error: "Export impossible, réessaie ou contacte le support." });
  }
});

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
