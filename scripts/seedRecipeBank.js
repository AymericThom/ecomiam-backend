import 'dotenv/config';
import { generateValidatedJSON } from '../src/lib/gemini.js';
import { buildWeekPrompt } from '../src/lib/prompts.js';
import { WeekResponseSchema } from '../src/lib/schema.js';
import { generateRecipeImage } from '../src/lib/imageGen.js';
import { estimateRecipePricePerServing } from '../src/lib/priceEstimator.js';
import { saveToBank } from '../src/lib/recipeBank.js';
import { supabaseAdmin } from '../src/lib/supabaseAdmin.js';

if (!supabaseAdmin) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants.');
  process.exit(1);
}

const DIETS = ['none', 'vegetarian', 'vegan', 'pescatarian'];
const GOAL_SETS = [['economy'], ['weight_loss'], ['muscle'], ['discover'], ['weight_loss', 'economy'], ['muscle', 'economy'], ['discover', 'economy'], ['weight_loss', 'discover', 'economy'], ['muscle', 'discover', 'economy']];
const BUDGETS = [1, 2.5, 4, 6.5];
// Tailles de foyer les plus courantes à couvrir — la banque filtre maintenant
// par servings exact (voir recipeBank.js), donc sans ça elle ne sert plus
// qu'aux foyers de 2 personnes et tout le reste retombe sur Gemini à chaque fois.
const HOUSEHOLDS = [
  { adults: 1, kids: 0 },
  { adults: 2, kids: 0 },
  { adults: 2, kids: 1 },
  { adults: 2, kids: 2 },
  { adults: 4, kids: 0 },
];
const RECIPES_PER_BATCH = 20; // 🔥 Passe à 20 pour être plus rapide !
const DELAY_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS || 4200);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Vérifie les doublons pour l'IA
async function getExistingLabels() {
  const { data } = await supabaseAdmin.from('recipe_bank').select('label');
  return data ? data.map(r => r.label) : [];
}

async function seedOneBatch(userState, excludeLabels) {
  const { system, user } = buildWeekPrompt(userState, RECIPES_PER_BATCH, excludeLabels);
  
  const parsed = await generateValidatedJSON({ 
    system, 
    user, 
    schema: WeekResponseSchema(RECIPES_PER_BATCH, userState),
    expectedRecipeCount: RECIPES_PER_BATCH,
  });

  for (const recipe of parsed.days) {
    const image = await generateRecipeImage(recipe);
    const pricePerServing = estimateRecipePricePerServing(recipe.ingredientLines, recipe.servings);
    await saveToBank({ ...recipe, image, pricePerServing }, userState);
  }
  return parsed.days.length;
}

async function main() {
  let total = 0;
  let failed = 0;
  const combos = [];
  
  for (const diet of DIETS) {
    for (const goals of GOAL_SETS) {
      for (const budget of BUDGETS) {
        for (const household of HOUSEHOLDS) {
          combos.push({ diet, goals, budget, household });
        }
      }
    }
  }

  console.log(`🌱 Lancement de l'usine ÉcoMiam : ${combos.length} profils × ${RECIPES_PER_BATCH} recettes.`);

  for (let i = 0; i < combos.length; i++) {
    const { diet, goals, budget, household } = combos[i];
    const userState = { goals, adults: household.adults, kids: household.kids, budget, time: 'around15', diet, allergies: [] };

    // On récupère les recettes existantes avant chaque lot
    const existingLabels = await getExistingLabels();

    try {
      const count = await seedOneBatch(userState, existingLabels);
      total += count;
      console.log(`[${i + 1}/${combos.length}] ✅ ${diet} / ${goals.join('+')} / ${budget}€ / ${household.adults}a+${household.kids}e → +${count} recettes (Total: ${total})`);
    } catch (e) {
      failed++;
      console.error(`[${i + 1}/${combos.length}] ❌ Erreur : ${e.message}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n🎉 Terminé ! ${total} nouvelles recettes générées sans doublons.`);
  process.exit(0);
}

main();