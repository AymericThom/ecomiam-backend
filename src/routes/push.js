import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const pushRouter = Router();

// POST /api/push/register { token } — à appeler côté mobile juste après
// Notifications.getExpoPushTokenAsync(), pour chaque appareil. Alimente la
// table push_tokens utilisée par lib/retentionJobs.js (relance streak,
// inactivité, palier de parrainage). Nécessite un compte réel : un
// utilisateur anonyme (device-id seulement) n'a pas d'identité stable assez
// fiable pour qu'on lui envoie des notifications ciblées côté serveur.
pushRouter.post('/register', async (req, res) => {
  try {
    if (!req.user?.authenticated) return res.status(401).json({ error: 'Authentification requise' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Indisponible (Supabase non configuré)' });

    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    const { error } = await supabaseAdmin
      .from('push_tokens')
      .upsert({ user_id: req.user.id, expo_push_token: token }, { onConflict: 'expo_push_token' });
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    console.error('[push/register]', err);
    res.status(500).json({ error: "Impossible d'enregistrer ce token" });
  }
});

// DELETE /api/push/register { token } — désinscription (l'utilisateur
// désactive les notifs dans les réglages de l'app).
pushRouter.delete('/register', async (req, res) => {
  try {
    if (!req.user?.authenticated) return res.status(401).json({ error: 'Authentification requise' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Indisponible (Supabase non configuré)' });

    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    await supabaseAdmin.from('push_tokens').delete().eq('user_id', req.user.id).eq('expo_push_token', token);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/register:delete]', err);
    res.status(500).json({ error: 'Impossible de supprimer ce token' });
  }
});
