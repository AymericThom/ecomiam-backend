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

// ⚡ CORRIGÉ + ÉTENDU : les clés ci-dessous doivent correspondre aux
// identifiants réellement utilisés par l'appli (voir Step5Allergies dans
// AppUI.js : "gluten", "lactose", "crustaces", "oeufs", "poissons", "soja",
// "arachides", "fruits_coque", "celeri", "moutarde", "mollusques",
// "sesame"). Les anciennes clés ("gluten-free", "dairy-free",
// "peanut-free", "pork-free") ne correspondaient à AUCUN de ces
// identifiants : ce filet de sécurité ne se déclenchait donc en réalité
// JAMAIS, quelle que soit l'allergie choisie par l'utilisateur — le prompt
// envoyé à l'IA était la SEULE protection, sans aucune double vérification
// derrière. Cette liste était aussi beaucoup trop courte (quelques mots par
// catégorie) : elle est maintenant nettement plus complète, avec les noms
// courants, dérivés et plats qui contiennent typiquement chaque allergène.
const ALLERGY_KEYWORDS = {
  gluten:
    /\bbl[ée]\b|froment|farine(?! de riz| de ma[iï]s| de sarrasin| de sarazin| sans gluten)|\bpain\b|panure|chapelure|p[âa]tes?\b|spaghetti|macaroni|tagliatelle|lasagne|gnocchi|semoule|couscous|boulgour|orge|seigle|avoine(?! sans gluten)|[ée]peautre|kamut|seitan|pizza|brioche|croissant|viennoiserie|biscuit|g[âa]teau|crêpe|gaufre|roux\b|b[ée]chamel|bouillon[- ]cube|chapon|biscotte|cracker|pâte feuilletée|pâte brisée|pâte à tarte|beignet|pané|panée|malt|bière(?! sans gluten)/i,
  lactose:
    /\blait\b(?! de coco| de soja| d'amande| d'avoine| de riz)|cr[èe]me\s*(fra[îi]che|liquide|épaisse|fleurette|entière)?|fromage|comt[ée]|emmental|mozzarella|parmesan|ch[èe]vre|feta|ricotta|mascarpone|gruy[èe]re|cheddar|\bbrie\b|camembert|beurre(?! de cacahuète| d'arachide)|yaourt|yogourt|fromage blanc|petit[- ]suisse|lactos[ée]rum|babeurre|ghee|lait concentr[ée]|lait en poudre|chantilly|raclette|tomme|reblochon|roquefort|b[ée]chamel|gratin[ée]/i,
  crustaces:
    /crevette|gambas|langoustine|\bcrabe\b|homard|langouste|[ée]crevisse|tourteau|bisque|d[ée]capode/i,
  oeufs:
    /\bœuf|\boeuf|mayonnaise|a[iï]oli|meringue|omelette|quiche|p[âa]te à choux|g[ée]noise|\bflan\b|cr[èe]me anglaise|cr[èe]me p[âa]tissi[èe]re|pân[ée]|panure(?=.*œuf)|p[âa]tes fra[îi]ches|brioche/i,
  poissons:
    /poisson|saumon|\bthon\b|cabillaud|colin|merlu|\bsole\b|truite|sardine|maquereau|anchois|morue|hareng|tarama|nuoc[- ]m[âa]m|bouillabaisse|fumet de poisson|worcestershire|surimi|[ée]glefin|dorade|bar\b|lieu noir|raie\b/i,
  soja:
    /\bsoja\b|\btofu\b|edamame|tempeh|sauce soja|shoyu|tamari|\bmiso\b|l[ée]cithine de soja|prot[ée]ines? de soja|tonyu|lait de soja/i,
  arachides:
    /cacahu[èe]te|arachide|beurre de cacahu[èe]te|huile d'arachide|satay/i,
  fruits_coque:
    /amande|noisette|noix(?! de coco| de muscade)|noix de caj?ou|noix de p[ée]can|noix de macadamia|noix du br[ée]sil|pistache|pralin[ée]?|nutella|marzipan|massepain/i,
  celeri: /c[ée]leri([- ]rave| branche)?|sel de c[ée]leri/i,
  moutarde: /moutarde/i,
  mollusques:
    /\bmoules?\b|hu[îi]tres?|coquilles? saint[- ]jacques|calamars?|encornets?|poulpe|\bseiches?\b|bulots?|escargots?|palourdes?|praires?|bigorneaux?/i,
  sesame: /s[ée]same|tahin[ée]?|houmous|hummus/i,
  // Catégories historiques (peu de personnes cochent "sans porc" comme
  // allergie à proprement parler, mais on la garde par compatibilité avec
  // d'éventuelles données existantes qui utiliseraient encore cette clé).
  'pork-free': /\bporc\b|lardons?|jambon|bacon|saucisse|chorizo|charcuterie/i,
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