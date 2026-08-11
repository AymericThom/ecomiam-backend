import { Router } from 'express';
import { generateValidatedJSON, GeminiBusyError } from '../lib/gemini.js';
import { buildWeekPrompt, buildSwapPrompt } from '../lib/prompts.js';
import { WeekResponseSchema, RecipeSchemaForRequest, UserStateSchema, ExcludeLabelsSchema } from '../lib/schema.js';
import { attachGeneratedImages, generateRecipeImage } from '../lib/imageGen.js';
import { estimateRecipePricePerServing } from '../lib/priceEstimator.js';
import { pickFromBank, saveToBank, violatesAllergies } from '../lib/recipeBank.js';
import { isPremiumRequest } from '../lib/premiumCheck.js';
import { checkFreeSwapQuota } from '../middleware/checkFreeSwapQuota.js';

export const recipesRouter = Router();

// pricePerServing n'est plus généré par Gemini (il l'inventait) : on le
// calcule nous-mêmes à partir des vrais ingrédients de la recette.
function attachPrice(recipe) {
  return { ...recipe, pricePerServing: estimateRecipePricePerServing(recipe.ingredientLines, recipe.servings) };
}

// Filet de sécurité : le prompt demande à Gemini de respecter les
// exclusions, mais rien ne le VÉRIFIAIT avant de renvoyer la recette à
// l'utilisateur — un modèle qui rate une exclusion sur une allergie n'est
// pas juste un bug produit, c'est un risque santé réel. On revérifie donc
// systématiquement les recettes fraîchement générées, pas seulement celles
// qui viennent de la banque.
function dropUnsafe(recipes, allergies) {
  const safe = recipes.filter((r) => !violatesAllergies(r.ingredientLines, allergies));
  if (safe.length < recipes.length) {
    console.warn(`[recipes] ${recipes.length - safe.length} recette(s) écartée(s) : allergène détecté malgré le prompt`);
  }
  return safe;
}

// POST /api/recipes/week  { userState }
// Stratégie coût : on pioche d'abord dans la banque de recettes déjà
// générées/pré-remplies (recipe_bank — voir scripts/seedRecipeBank.js pour
// la remplir en masse une bonne fois pour toutes), et on ne demande à
// Gemini que ce qu'il manque. Les images sont générées une seule fois par
// recette (à la création) puis réutilisées à chaque pioche en banque —
// jamais régénérées à chaque requête utilisateur.
recipesRouter.post('/week', async (req, res) => {
  try {
    const userState = UserStateSchema.parse(req.body.userState);
    const priority = await isPremiumRequest(req);

    // 👇 1. On récupère le nombre cible depuis userState (ou 7 par défaut)
    const targetCount = userState.mealsCount || 7;

    // 👇 2. On utilise 'targetCount' au lieu de '7' en dur
    const fromBank = await pickFromBank(userState, targetCount);
    const missing = targetCount - fromBank.length;

    let generated = [];
    if (missing > 0) {
      // Le paramètre 'missing' transmet le nombre à générer à buildWeekPrompt
      const { system, user } = buildWeekPrompt(userState, missing);
      const parsed = await generateValidatedJSON({ system, user, schema: WeekResponseSchema(missing, userState), priority, expectedRecipeCount: missing });
      const safeDays = dropUnsafe(parsed.days, userState.allergies);
      generated = (await attachGeneratedImages(safeDays, { priority })).map(attachPrice);
      generated.forEach((r) => saveToBank(r, userState));
    }

    const days = [...fromBank, ...generated];
    res.json({ days });
  } catch (err) {
    if (err instanceof GeminiBusyError) return res.status(429).json({ error: err.message });
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Préférences invalides', detail: err.issues });
    console.error('[recipes/week]', err);
    res.status(500).json({ error: 'Génération du menu impossible' });
  }
});

// POST /api/recipes/swap  { userState, excludeLabels: string[] }
// 🔧 checkFreeSwapQuota (voir middleware) : avant, seule la limite
// FREE_SWAPS_PER_WEEK côté client empêchait les swaps illimités en gratuit —
// contournable en éditant AsyncStorage. Vérifiée en base maintenant.
recipesRouter.post('/swap', checkFreeSwapQuota, async (req, res) => {
  try {
    const userState = UserStateSchema.parse(req.body.userState);
    const excludeLabels = ExcludeLabelsSchema.parse(req.body.excludeLabels) || [];
    const priority = await isPremiumRequest(req);

    const [fromBank] = await pickFromBank(userState, 1, excludeLabels);
    if (fromBank) return res.json({ recipe: fromBank });

    const { system, user } = buildSwapPrompt(userState, excludeLabels);

    // Une seule recette ici (contrairement à /week) : si elle viole une
    // allergie, on retente une fois plutôt que de simplement l'écarter —
    // sinon l'utilisateur se retrouve avec aucun résultat du tout.
    let parsed = await generateValidatedJSON({ system, user, schema: RecipeSchemaForRequest(userState), priority });
    if (violatesAllergies(parsed.ingredientLines, userState.allergies)) {
      console.warn('[recipes/swap] allergène détecté malgré le prompt, nouvelle tentative');
      parsed = await generateValidatedJSON({ system, user, schema: RecipeSchemaForRequest(userState), priority });
      if (violatesAllergies(parsed.ingredientLines, userState.allergies)) {
        return res.status(422).json({ error: "Impossible de générer une recette respectant tes exclusions pour l'instant, réessaie." });
      }
    }

    const withImage = { ...parsed, image: await generateRecipeImage(parsed, { priority }) };
    const withPrice = attachPrice(withImage);
    saveToBank(withPrice, userState);

    res.json({ recipe: withPrice });
  } catch (err) {
    if (err instanceof GeminiBusyError) return res.status(429).json({ error: err.message });
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Requête invalide', detail: err.issues });
    console.error('[recipes/swap]', err);
    res.status(500).json({ error: 'Génération de la recette impossible' });
  }
});
