const GOAL_LABELS = {
  weight_loss: 'perte de poids (Déficit calorique, volume alimentaire élevé, max 450 kcal/portion)',
  muscle: 'prise de masse (Hypercalorique, minimum 35g de protéines/portion)',
  economy: 'économies (Ingrédients bruts bon marché, zéro gaspillage)',
  discover: 'découverte (Recettes du monde adaptées aux supermarchés français)',
};

const DIET_LABELS = {
  none: 'Omnivore',
  vegetarian: 'Végétarien (aucune chair animale)',
  vegan: 'Végétalien strict (aucun produit d\'origine animale)',
  pescatarian: 'Pesco-végétarien (poissons/crustacés autorisés, aucune viande)',
};

const TIME_LABELS = {
  under10: 'moins de 10 minutes de préparation',
  around15: 'environ 15 minutes de préparation',
  over15: "plus de 15 minutes, l'utilisateur aime prendre son temps",
};

function currentSeasonFR() {
  const month = new Date().getMonth() + 1;
  if ([12, 1, 2].includes(month)) return 'hiver';
  if ([3, 4, 5].includes(month)) return 'printemps';
  if ([6, 7, 8].includes(month)) return 'été';
  return 'automne';
}

const RECIPE_JSON_SHAPE = `{
  "label": "Nom du plat en français (unique et descriptif)",
  "searchQuery": "3 mots-clés en anglais TRÈS spécifiques au plat exact pour la recherche photo (ex: 'grilled salmon asparagus' plutôt que 'fish dinner')",
  "totalTime": 20,
  "servings": 2,
  "difficulty": "Facile" | "Moyen" | "Difficile",
  "calories": 450,
  "protein": 30,
  "carbs": 40,
  "fat": 15,
  "equipment": ["plaques", "four"], 
  "ingredientLines": ["200g de blanc de poulet", "150g de riz basmati", "1 gousse d'ail", "..."],
  "steps": ["Étape 1 : action précise, quantité exacte, durée et température si besoin (ex: 'Faites chauffer 1 c.à.s d'huile d'olive à feu moyen (thermostat 6), puis faites revenir les 200g de poulet coupé en dés pendant 5-6 minutes en remuant régulièrement, jusqu'à ce qu'il soit doré sur toutes les faces')...", "Étape 2...", "..."],
  "tips": ["Conseil du chef (technique, astuce de dressage, ou variante) — optionnel mais toujours pertinent", "..."]
}`;

function baseContext(userState) {
  const goals = (userState.goals || []).map((g) => GOAL_LABELS[g] || g).join(', ') || 'Équilibre';
  const adults = userState.adults || 2;
  const kids = userState.kids || 0;
  const totalDiners = adults + kids;
  const foyer = kids > 0 ? `${adults} adulte(s) + ${kids} enfant(s) = ${totalDiners} convives au total` : `${adults} adulte(s), pas d'enfant`;

  // 1. Fusion des allergies classiques et personnalisées
  const allAllergies = [...(userState.allergies || []), ...(userState.customAllergies || [])].join(', ') || 'Aucune';
  
  // 2. Traitement des goûts (mémoire IA)
  const loved = (userState.lovedIngredients || []).join(', ') || 'Aucun en particulier';
  const disliked = (userState.dislikedIngredients || []).join(', ') || 'Aucun';

  return `
Tu es un diététicien-nutritionniste clinique et un chef de la gastronomie française.
Objectif : Créer des recettes parfaitement saines avec des produits trouvables dans la grande distribution française.

PROFIL :
- Foyer : ${foyer}
- Régime : ${DIET_LABELS[userState.diet] || 'Omnivore'}
- Exclusions strictes (Allergies) : ${allAllergies}
- Ingrédients ADORÉS (à privilégier) : ${loved}
- Ingrédients DÉTESTÉS (à bannir totalement) : ${disliked}
- Objectif santé : ${goals}
- Budget max : ${userState.budget || 4}€ / personne
- Temps souhaité : ${TIME_LABELS[userState.time] || '15 minutes'}
- Saison : ${currentSeasonFR()} (Respecte la saisonnalité des légumes)

RÈGLES DE VALIDATION EXPERT (une recette qui ne les respecte pas TOUTES est rejetée automatiquement) :
1. MACROS EXACTES : La règle mathématique (Protéines x 4) + (Glucides x 4) + (Lipides x 9) DOIT être égale à la valeur "calories" à 60 kcal près (calories = par portion, pas pour tout le plat). Recalcule après avoir fixé tes quantités, ne les invente pas en parallèle.
2. USTENSILES : Le tableau "equipment" ne doit contenir QUE des éléments parmi : "four", "micro-ondes", "plaques", "air_fryer", "blender" (utilise "blender" si pertinent pour des soupes, sauces, ou smoothies).
3. COMPLÉTUDE OBLIGATOIRE — RECETTE ULTRA DÉTAILLÉE : minimum 3 ingrédients ET minimum 5 étapes réelles (davantage si la recette est complexe). Chaque étape doit être ATOMIQUE : une seule action principale par étape, jamais deux actions regroupées ("Faites revenir puis ajoutez..." est INTERDIT, il faut deux étapes séparées). Une étape du type "Cuire et servir" est INVALIDE. Chaque étape précise : le geste exact, la quantité concernée, la durée en minutes, et la température/thermostat/puissance quand c'est pertinent (feu doux/moyen/vif, four à X°C, micro-ondes à X watts). La toute dernière étape décrit le dressage/service (comment disposer le plat dans l'assiette). Ajoute un champ "tips" avec 1 à 3 conseils de chef concrets (technique, astuce anti-ratage, ou variante) — jamais vide ou générique.
4. QUANTITÉS PARTOUT : chaque ligne de "ingredientLines" a une quantité précise (g, ml, unité, cuillère...) — jamais "un peu de" ou "au goût" sauf pour sel/poivre. Chaque étape qui utilise un ingrédient répète sa quantité (ex: "Faites revenir les 200g de poulet coupé en dés").
5. FAISABILITÉ RÉELLE : les temps de cuisson, températures et étapes doivent être culinairement exacts et réalisables avec les ustensiles listés — pas d'approximation ni d'étape inventée pour faire joli.
6. PORTIONS RÉELLES DU FOYER : "servings" doit être EXACTEMENT ${totalDiners}, et TOUTES les quantités de "ingredientLines" doivent être calculées pour ${totalDiners} convives — jamais une quantité générique "pour 2" par défaut. Si des enfants sont présents, adapte leurs portions à une quantité réaliste plus petite qu'un adulte, mais ${totalDiners} reste le total de "servings".
7. RESPECT DES GOÛTS : N'utilise JAMAIS les ingrédients listés dans "Exclusions strictes" et "Ingrédients DÉTESTÉS". Essaie d'incorporer intelligemment les "Ingrédients ADORÉS" si cela a du sens culinairement.
8. JSON PUR : Renvoie uniquement le JSON valide, sans texte autour.
`.trim();
}

export function buildWeekPrompt(userState, count = 7, excludeLabels = []) {
  const system = `Tu es une API nutritionnelle générant un array JSON de recettes.`;
  const user = `${baseContext(userState)}

Génère ${count} recettes de dîner strictement différentes.
INTERDICTION ABSOLUE de proposer ces recettes : [${excludeLabels.join(', ')}].

FORMAT ATTENDU :
{
  "days": [ ${RECIPE_JSON_SHAPE} ] // Exactement ${count} objets
}`;
  return { system, user };
}

export function buildSwapPrompt(userState, excludeLabels = []) {
  const system = `Tu es une API nutritionnelle générant une recette JSON.`;
  const user = `${baseContext(userState)}

Génère UNE recette de remplacement.
INTERDICTION ABSOLUE de proposer ces recettes : [${excludeLabels.join(', ')}].

FORMAT ATTENDU :
${RECIPE_JSON_SHAPE}`;
  return { system, user };
}

export function buildFridgePrompt(userState, detectedHint = '') {
  const system = `Tu es un chef cuisinier expert en cuisine anti-gaspillage.`;
  const user = `${baseContext(userState)}

Analyse la photo fournie. Liste les ingrédients identifiés, puis propose une recette anti-gaspi.
${detectedHint ? `Indice supplémentaire : ${detectedHint}` : ''}

Réponds avec un JSON de cette forme :
{
  "detectedItems": ["demi-courgette", "3 oeufs"],
  "recipe": ${RECIPE_JSON_SHAPE}
}`;
  return { system, user };
}