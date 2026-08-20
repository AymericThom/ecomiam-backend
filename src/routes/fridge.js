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

// ⚡ NOUVEAU : assaisonnements de base explicitement autorisés dans une
// recette même sans être visibles sur la photo (voir buildFridgePrompt,
// règle 3) — tout le reste de ingredientLines DOIT provenir de
// detectedItems, vérifié par recipeMatchesDetectedItems ci-dessous.
const ALLOWED_PANTRY_BASICS = /\b(sel|poivre|huile|olive|tournesol|eau)\b/i;

// Filet de sécurité serveur : le prompt interdit déjà d'inventer des
// ingrédients (voir prompts.js), mais un modèle de langage peut toujours
// dévier — on vérifie donc CÔTÉ SERVEUR que chaque ligne d'ingrédient de
// la recette générée correspond bien à un aliment réellement détecté sur
// la photo (ou fait partie du petit socle d'assaisonnements autorisés).
// Tolère 1 écart (formulations différentes du même aliment) mais pas plus.
function recipeMatchesDetectedItems(recipe, detectedItems) {
  if (!detectedItems?.length) return false;
  const normalizedDetected = detectedItems.map((d) => d.toLowerCase());
  let mismatches = 0;
  for (const line of recipe.ingredientLines) {
    const low = line.toLowerCase();
    if (ALLOWED_PANTRY_BASICS.test(low)) continue;
    const matchesAny = normalizedDetected.some(
      (d) => low.includes(d) || d.includes(low.replace(/^[\d.,]+\s*[a-zà-ÿ]*\s*/i, '').trim()),
    );
    if (!matchesAny) mismatches++;
  }
  return mismatches <= 1;
}

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

    const generate = () =>
      generateValidatedJSON({
        system,
        user,
        schema: FridgeResponseSchema(userState),
        image: { base64: pureBase64, mimeType: 'image/jpeg' },
        vision: true,
        temperature: 0.7,
        priority,
      });

    let parsed = await generate();

    // ⚡ NOUVEAU : rien de comestible détecté sur la photo (voir règle 2 du
    // prompt) — on ne force plus de recette bidon, l'app doit proposer
    // d'ajouter les ingrédients manuellement à la place.
    if (!parsed.detectedItems?.length || !parsed.recipe) {
      return res.json({ detectedItems: parsed.detectedItems || [], recipe: null });
    }

    if (violatesAllergies(parsed.recipe.ingredientLines, userState.allergies)) {
      console.warn('[fridge-scan] allergène détecté malgré le prompt, nouvelle tentative');
      parsed = await generate();
      if (!parsed.recipe) {
        return res.json({ detectedItems: parsed.detectedItems || [], recipe: null });
      }
      if (violatesAllergies(parsed.recipe.ingredientLines, userState.allergies)) {
        return res.status(422).json({ error: "Impossible de générer une recette respectant tes exclusions à partir de cette photo, réessaie." });
      }
    }

    // ⚡ NOUVEAU : la recette doit vraiment coller aux aliments détectés —
    // sinon on proposait des plats avec des ingrédients que l'utilisateur
    // n'a pas réellement sous la main (voir recipeMatchesDetectedItems).
    if (!recipeMatchesDetectedItems(parsed.recipe, parsed.detectedItems)) {
      console.warn('[fridge-scan] recette avec des ingrédients non détectés, nouvelle tentative');
      const retry = await generate();
      if (retry.recipe && recipeMatchesDetectedItems(retry.recipe, retry.detectedItems)) {
        parsed = retry;
      } else {
        return res.status(422).json({
          error: "Impossible de composer une recette qui n'utilise que les ingrédients détectés sur cette photo, réessaie ou ajoute-les manuellement.",
        });
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
