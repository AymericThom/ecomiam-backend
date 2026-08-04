import { Router } from 'express';
import { z } from 'zod';
import { estimateIngredientPrice } from '../lib/priceEstimator.js';
import { pushCartMock } from '../lib/cartProviders.js';
import { supabaseAdmin } from '../lib/supabaseAdmin.js';

export const cartRouter = Router();

const IngredientsSchema = z.object({ ingredientLines: z.array(z.string().max(200)).max(200) });

// POST /api/cart/estimate-prices  { ingredientLines: string[] }
// Remplace le Math.random() côté mobile par une estimation basée sur de
// vrais prix moyens français (voir lib/priceEstimator.js).
cartRouter.post('/estimate-prices', (req, res) => {
  try {
    const { ingredientLines } = IngredientsSchema.parse(req.body);
    const prices = ingredientLines.map((name) => ({ name, price: estimateIngredientPrice(name) }));
    res.json({ prices });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Requête invalide' });
    res.status(500).json({ error: 'Estimation impossible' });
  }
});

// POST /api/cart/push  { items: [{name, aisle}] }
// Aujourd'hui : mock "bientôt disponible". Demain : vrai push vers le Drive
// choisi (Carrefour/Leclerc/Auchan) via Miam.tech ou Awin.
cartRouter.post('/push', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const result = await pushCartMock(items);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Envoi au Drive impossible' });
  }
});

// POST /api/cart/waitlist  — capture l'intérêt utilisateur pour la feature
// Drive. Donnée précieuse à montrer à Miam.tech/Awin ("X utilisateurs
// attendent déjà cette intégration").
cartRouter.post('/waitlist', async (req, res) => {
  try {
    if (!supabaseAdmin) return res.json({ ok: true, stored: false });
    const userId = req.user?.authenticated ? req.user.id : null;
    await supabaseAdmin.from('drive_waitlist').insert({ user_id: userId });
    res.json({ ok: true, stored: true });
  } catch (err) {
    res.json({ ok: true, stored: false });
  }
});
