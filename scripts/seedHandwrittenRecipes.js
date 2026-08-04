/**
 * Insère les recettes écrites à la main (handwrittenRecipes.js) dans la
 * banque de recettes. AUCUN appel au modèle TEXTE Gemini ici (c'est le texte
 * qui coûte le plus cher en quota) — mais les photos passent quand même par
 * la génération d'image Gemini (imageGen.js) plutôt que Pexels, pour que
 * TOUTES les photos de l'app (générées ou écrites à la main) partagent la
 * même identité visuelle cohérente. C'est le script à lancer en tout
 * premier, avant même de te soucier des quotas Gemini texte : il te donne
 * un socle de recettes utilisable immédiatement.
 *
 * Usage :
 *   cd backend
 *   npm run seed:handwritten
 */
import 'dotenv/config';
import { HANDWRITTEN_RECIPES } from './handwrittenRecipes.js';
import { generateRecipeImage } from '../src/lib/imageGen.js';
import { estimateRecipePricePerServing } from '../src/lib/priceEstimator.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

if (!supabaseAdmin) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants — impossible de remplir la banque.');
  process.exit(1);
}

async function main() {
  let inserted = 0;
  let failed = 0;

  for (const recipe of HANDWRITTEN_RECIPES) {
    const image = await generateRecipeImage(recipe);
    const seasons = recipe.seasons?.length ? recipe.seasons : ['printemps', 'été', 'automne', 'hiver'];

    for (const season of seasons) {
      try {
        const { error } = await supabaseAdmin.from('recipe_bank').insert({
          label: recipe.label,
          search_query: recipe.searchQuery,
          image,
          total_time: recipe.totalTime,
          servings: recipe.servings,
          difficulty: recipe.difficulty,
          price_per_serving: estimateRecipePricePerServing(recipe.ingredientLines, recipe.servings),
          calories: recipe.calories,
          protein: recipe.protein,
          carbs: recipe.carbs,
          fat: recipe.fat,
          equipment: recipe.equipment || ['plaques'],
          ingredient_lines: recipe.ingredientLines,
          steps: recipe.steps,
          goals: recipe.goals || [],
          diet: recipe.diet,
          season,
        });
        if (error) throw error;
        inserted++;
        console.log(`✅ ${recipe.label} (${recipe.diet}, ${season})`);
      } catch (e) {
        failed++;
        console.error(`❌ ${recipe.label} (${season}) — ${e.message}`);
      }
    }
  }

  console.log(`\n🎉 Terminé. ${inserted} lignes insérées dans recipe_bank, ${failed} échecs.`);
  console.log('Aucun appel Gemini n\'a été fait — cette banque est utilisable immédiatement.');
  process.exit(0);
}

main();
