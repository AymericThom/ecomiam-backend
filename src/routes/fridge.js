import { Router } from 'express';
import { generateValidatedJSON, GeminiBusyError } from '../lib/gemini.js';
import { buildFridgePrompt } from '../lib/prompts.js';
import { FridgeResponseSchema, UserStateSchema, HintSchema } from '../lib/schema.js';
import { generateRecipeImage } from '../lib/imageGen.js';
import { estimateRecipePricePerServing } from '../lib/priceEstimator.js';
import { saveToBank, violatesAllergies } from '../lib/recipeBank.js';
import { isPremiumRequest } from '../lib/premiumCheck.js';

export const fridgeRouter = Router();

// Taille max raisonnable pour une photo compressée côté mobile avant envoi
// (voir mobile/src/utils/imageCompression.js — ~5 Mo en base64 max)
const MAX_BASE64_LENGTH = 7_000_000;

// POST /api/fridge-scan  { userState, imageBase64, hint? }
fridgeRouter.post('/', async (req, res) => {
  try {
    const userState = UserStateSchema.parse(req.body.userState);
    const hint = HintSchema.parse(req.body.hint);
    const { imageBase64 } = req.body;
    // Le scan du frigo est déjà réservé aux abonnés PRO côté app, mais on
    // revérifie quand même ici plutôt que de supposer priority=true —
    // cohérent avec le reste (jamais confiance en un flag côté client).
    const priority = await isPremiumRequest(req);

    // 🔧 Correction d'une vraie faille : `priority` n'était utilisé QUE pour
    // la priorité dans la file Gemini, pas pour bloquer l'accès — un
    // utilisateur non-PRO (ou un statut isPremium patché localement en
    // AsyncStorage) pouvait scanner le frigo sans limite jusqu'au quota
    // journalier générique, alors que c'est explicitement une fonctionnalité
    // PRO (vision + génération d'image à chaque appel, le scan le plus
    // coûteux de l'app). On bloque maintenant ici, côté serveur, à partir du
    // même `is_pro` vérifié en base — pas du flag client.
    if (!priority) {
      return res.status(403).json({
        error: 'Le scan de frigo est réservé aux abonnés PRO.',
        code: 'PRO_REQUIRED',
      });
    }

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 manquant' });
    }
    if (imageBase64.length > MAX_BASE64_LENGTH) {
      return res.status(413).json({ error: 'Image trop volumineuse (max ~5 Mo). Réessaie, la compression automatique a dû échouer.' });
    }

    const pureBase64 = imageBase64.startsWith('data:') ? imageBase64.split(',')[1] : imageBase64;
    const { system, user } = buildFridgePrompt(userState, hint);

    let parsed = await generateValidatedJSON({
      system,
      user,
      schema: FridgeResponseSchema(userState),
      image: { base64: pureBase64, mimeType: 'image/jpeg' },
      vision: true,
      temperature: 0.7,
      priority,
    });

    if (violatesAllergies(parsed.recipe.ingredientLines, userState.allergies)) {
      console.warn('[fridge-scan] allergène détecté malgré le prompt, nouvelle tentative');
      parsed = await generateValidatedJSON({
        system,
        user,
        schema: FridgeResponseSchema(userState),
        image: { base64: pureBase64, mimeType: 'image/jpeg' },
        vision: true,
        temperature: 0.7,
        priority,
      });
      if (violatesAllergies(parsed.recipe.ingredientLines, userState.allergies)) {
        return res.status(422).json({ error: "Impossible de générer une recette respectant tes exclusions à partir de cette photo, réessaie." });
      }
    }

    const image = await generateRecipeImage(parsed.recipe, { priority });
    const pricePerServing = estimateRecipePricePerServing(parsed.recipe.ingredientLines, parsed.recipe.servings);
    const recipe = { ...parsed.recipe, image, pricePerServing };
    saveToBank(recipe, userState);

    res.json({ detectedItems: parsed.detectedItems, recipe });
  } catch (err) {
    if (err instanceof GeminiBusyError) return res.status(429).json({ error: err.message });
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Requête invalide', detail: err.issues });
    console.error('[fridge-scan]', err);
    res.status(500).json({ error: 'Analyse du frigo impossible' });
  }
});
