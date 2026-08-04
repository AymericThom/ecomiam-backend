// Banque de recettes — dès qu'une recette est générée par l'IA, elle est
// sauvegardée ici (table Supabase `recipe_bank`). La prochaine fois qu'un
// profil similaire (mêmes objectifs/régime/saison) a besoin d'un menu, on
// PIOCHE d'abord dans cette banque au lieu de rappeler l'IA.
//
// Résultat concret : plus l'app a d'utilisateurs, moins elle appelle Gemini
// (donc moins ça coûte), tout en gardant des menus variés puisque la banque
// grossit en continu avec de vraies recettes déjà validées par le format JSON.

import { supabaseAdmin } from './supabaseAdmin.js';

function currentSeasonFR() {
  const month = new Date().getMonth() + 1;
  if ([12, 1, 2].includes(month)) return 'hiver';
  if ([3, 4, 5].includes(month)) return 'printemps';
  if ([6, 7, 8].includes(month)) return 'été';
  return 'automne';
}

const ALLERGY_KEYWORDS = {
  'gluten-free': /pâtes|farine|pain|blé|semoule|couscous/i,
  'dairy-free': /lait|fromage|crème|beurre|yaourt/i,
  'peanut-free': /cacahuète|arachide/i,
  'pork-free': /porc|lardons|jambon|bacon|saucisse/i,
};

// Exportée : réutilisée aussi pour vérifier les recettes FRAÎCHEMENT
// générées par Gemini (routes/recipes.js, routes/fridge.js) — avant, seules
// les recettes de la banque étaient revérifiées ; une recette tout juste
// générée était renvoyée à l'utilisateur en faisant confiance aveuglément
// au prompt, sans aucun filet de sécurité si le modèle ratait une exclusion.
export function violatesAllergies(ingredientLines, allergies = []) {
  const text = (ingredientLines || []).join(' ');
  return allergies.some((a) => ALLERGY_KEYWORDS[a]?.test(text));
}

// Cherche jusqu'à `count` recettes réutilisables pour ce profil. Retourne
// un tableau (potentiellement plus court que `count` si la banque est encore
// petite) — à l'appelant de compléter le manque via l'IA.
export async function pickFromBank(userState, count, excludeLabels = []) {
  if (!supabaseAdmin) return [];

  const totalDiners = (userState.adults || 2) + (userState.kids || 0);

  let query = supabaseAdmin
    .from('recipe_bank')
    .select('*')
    .eq('diet', userState.diet)
    .eq('season', currentSeasonFR())
    // Le foyer doit matcher exactement : une recette "pour 2" servie à un
    // foyer de 4 personnes reproduit exactement le bug signalé, juste caché
    // derrière le cache au lieu de la génération fraîche.
    .eq('servings', totalDiners)
    .lte('price_per_serving', userState.budget)
    .not('label', 'in', `(${excludeLabels.map((l) => `"${l}"`).join(',') || '""'})`)
    .order('use_count', { ascending: true }) // fait tourner les recettes les moins vues
    .limit(count * 6); // marge plus large : on filtre encore par goals + allergies + tirage ensuite

  // Filtre par objectif santé : sans ça, une recette taguée "prise de masse"
  // (hypercalorique, riche en protéines) pouvait ressortir pour un profil
  // "perte de poids", en contradiction directe avec ce que l'utilisateur a demandé.
  if (userState.goals?.length) {
    query = query.overlaps('goals', userState.goals);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  const safe = data.filter((r) => !violatesAllergies(r.ingredient_lines, userState.allergies));
  const shuffled = safe.sort(() => Math.random() - 0.5).slice(0, count);

  // Incrémente le compteur d'usage en tâche de fond (pas besoin d'attendre
  // la réponse pour renvoyer les recettes à l'utilisateur).
  shuffled.forEach(async (r) => {
    // Avec un "async" dans le forEach, ça reste une tâche de fond non-bloquante.
    // Et on supprime le .catch() car Supabase ne "throw" pas d'erreur par défaut (il renvoie {error}).
    await supabaseAdmin.rpc('increment_recipe_use_count', { recipe_id: r.id });
  });

  return shuffled.map(fromBankRow);
}

// Convertit une ligne Supabase vers le format recette utilisé par l'app mobile.
function fromBankRow(row) {
  return {
    label: row.label,
    searchQuery: row.search_query,
    image: row.image,
    totalTime: row.total_time,
    servings: row.servings,
    difficulty: row.difficulty,
    pricePerServing: Number(row.price_per_serving),
    calories: row.calories,
    protein: row.protein,
    carbs: row.carbs,
    fat: row.fat,
    equipment: row.equipment || [],
    ingredientLines: row.ingredient_lines,
    steps: row.steps,
  };
}

// Sauvegarde une recette fraîchement générée par l'IA dans la banque, taguée
// avec le profil qui l'a déclenchée (pour qu'elle ressorte pour des profils
// similaires plus tard).
export async function saveToBank(recipe, userState) {
  if (!supabaseAdmin) return;
  try {
    await supabaseAdmin.from('recipe_bank').insert({
      label: recipe.label,
      search_query: recipe.searchQuery,
      image: recipe.image,
      total_time: recipe.totalTime,
      servings: recipe.servings,
      difficulty: recipe.difficulty,
      price_per_serving: recipe.pricePerServing,
      calories: recipe.calories,
      protein: recipe.protein,
      carbs: recipe.carbs,
      fat: recipe.fat,
      equipment: recipe.equipment || [], // <-- LIGNE À AJOUTER
      ingredient_lines: recipe.ingredientLines,
      steps: recipe.steps,
      goals: userState.goals,
      diet: userState.diet,
      season: currentSeasonFR(),
    });
  } catch (e) {
    console.error('[recipeBank] échec sauvegarde', e.message);
  }
}