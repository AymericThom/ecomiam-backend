import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';
import { getOrCreateReferralCode } from '../lib/referralCode.js';
import { grantPromotionalDays } from '../lib/revenuecatAdmin.js';

export const referralRouter = Router();

// Récompense IMMÉDIATE du FILLEUL à la validation du code (avant même
// d'avoir prouvé sa rétention) — "donner avant de demander" maximise
// l'activation dès la toute première session. La récompense du PARRAIN,
// elle, est différée et conditionnée à la rétention réelle du filleul (voir
// lib/retentionJobs.js) — c'est cette dissymétrie qui protège des abus tout
// en gardant un onboarding généreux.
const NEW_USER_WELCOME_DAYS = 7;

function requireAuth(req, res, next) {
  if (!req.user?.authenticated) return res.status(401).json({ error: 'Authentification requise' });
  next();
}

// GET /api/referral/me — code perso, lien de partage, stats de parrainage
referralRouter.get('/me', requireAuth, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Parrainage indisponible (Supabase non configuré)' });

    const code = await getOrCreateReferralCode(req.user.id);
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('referral_confirmed_count, referred_by')
      .eq('id', req.user.id)
      .single();

    // 🐛 CORRIGÉ (nouvelle demande) : doit rester synchronisé avec
    // MILESTONE_BONUS_DAYS dans lib/retentionJobs.js (même paliers, même
    // ordre) — palier à 1 filleul ajouté avant le 3.
    const milestones = [1, 3, 5, 10];
    const confirmedCount = profile?.referral_confirmed_count || 0;
    const nextMilestone = milestones.find((m) => m > confirmedCount) || null;

    res.json({
      code,
      shareLink: `https://kaba-app.fr/r/${code}`,
      confirmedReferrals: confirmedCount,
      alreadyUsedACode: !!profile?.referred_by,
      nextMilestone,
    });
  } catch (err) {
    console.error('[referral/me]', err);
    res.status(500).json({ error: 'Impossible de récupérer ton code de parrainage' });
  }
});

// POST /api/referral/redeem { code } — le NOUVEL utilisateur entre le code
// reçu de son parrain. Une seule fois par compte, jamais son propre code.
referralRouter.post('/redeem', requireAuth, async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Parrainage indisponible (Supabase non configuré)' });

    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code manquant' });

    const { data: me } = await supabaseAdmin
      .from('profiles')
      .select('referred_by, referral_code')
      .eq('id', req.user.id)
      .single();

    if (me?.referred_by) return res.status(409).json({ error: 'Tu as déjà utilisé un code de parrainage' });
    if (me?.referral_code && me.referral_code === code) {
      return res.status(400).json({ error: 'Tu ne peux pas utiliser ton propre code' });
    }

    const { data: referrer } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('referral_code', code)
      .single();
    if (!referrer) return res.status(404).json({ error: 'Code de parrainage invalide' });
    if (referrer.id === req.user.id) return res.status(400).json({ error: 'Tu ne peux pas utiliser ton propre code' });

    await supabaseAdmin
      .from('profiles')
      .update({ referred_by: referrer.id, referral_redeemed_at: new Date().toISOString() })
      .eq('id', req.user.id);

    let welcomeReward = null;
    try {
      await grantPromotionalDays(req.user.id, NEW_USER_WELCOME_DAYS);
      welcomeReward = { days: NEW_USER_WELCOME_DAYS };
    } catch (err) {
      // Le code est validé même si l'octroi RevenueCat échoue (ex : clé mal
      // configurée) — on ne veut jamais bloquer l'onboarding pour ça, quitte
      // à rattraper le cadeau manuellement une fois le vrai problème identifié.
      console.error('[referral/redeem] octroi PRO filleul échoué', err);
    }

    res.json({ ok: true, welcomeReward });
  } catch (err) {
    console.error('[referral/redeem]', err);
    res.status(500).json({ error: 'Impossible de valider ce code' });
  }
});
