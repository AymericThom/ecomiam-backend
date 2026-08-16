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

// ⚡ NOUVEAU : avant, les allergies étaient envoyées à l'IA comme un simple
// mot ("gluten", "lactose"...) — le modèle pouvait très bien laisser passer
// un ingrédient dérivé qu'il n'associe pas immédiatement à ce mot (ex:
// "semoule" pour "gluten", ou "comté" pour "lactose"). On explicite
// maintenant, pour chaque allergie cochée, la liste concrète des familles
// d'aliments à exclure — la même logique "un mot = toute une famille
// d'aliments" que le filet de sécurité côté backend (voir ALLERGY_KEYWORDS
// dans recipeBank.js), pour que le prompt et la vérification après coup
// soient cohérents entre eux.
const ALLERGY_EXCLUSION_DETAILS = {
  gluten:
    'gluten (blé, froment, farine de blé, pain, pâtes classiques, semoule, couscous, boulgour, orge, seigle, avoine non certifiée sans gluten, épeautre, kamut, chapelure/panure, pâte à tarte/feuilletée, pizza, biscuits, gâteaux, brioche, roux/béchamel classique)',
  lactose:
    'lait et produits laitiers (lait de vache, crème fraîche/liquide, tous fromages, beurre, yaourt, fromage blanc, béchamel, gratin au fromage — le lait végétal comme lait de coco/soja/amande/avoine reste autorisé)',
  crustaces:
    'crustacés (crevettes, gambas, langoustines, crabe, homard, langouste, écrevisses, tourteau, bisque de crustacés)',
  oeufs:
    "œufs (œufs entiers, mayonnaise, aïoli, meringue, omelette, quiche, pâte à choux, génoise, crème anglaise/pâtissière, panure à l'œuf)",
  poissons:
    'poissons (saumon, thon, cabillaud, colin, sole, truite, sardine, maquereau, anchois, morue, sauce nuoc-mâm/worcestershire, fumet de poisson, surimi)',
  soja: 'soja (tofu, edamame, tempeh, sauce soja, miso, lécithine de soja, lait de soja)',
  arachides: "arachides/cacahuètes (cacahuètes, beurre de cacahuète, huile d'arachide, sauce satay)",
  fruits_coque:
    'fruits à coque (amandes, noisettes, noix, noix de cajou/pécan/macadamia, pistaches, praliné, Nutella, marzipan)',
  celeri: 'céleri (céleri branche, céleri-rave, sel de céleri)',
  moutarde: 'moutarde (graines et sauce moutarde)',
  mollusques:
    'mollusques (moules, huîtres, coquilles Saint-Jacques, calamars, poulpe, seiche, escargots, palourdes)',
  sesame: 'sésame (graines de sésame, tahini, houmous)',
};

function describeAllergyExclusions(ids) {
  if (!ids?.length) return null;
  return ids
    .map((id) => ALLERGY_EXCLUSION_DETAILS[id] || id)
    .join(' ; ');
}

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
  "tips": ["Conseil du chef (technique, astuce de dressage, ou variante) — optionnel mais toujours pertinent", "..."],
  "usedDislikedIngredient": false,
  "dislikedIngredientNote": ""
}`;

function baseContext(userState) {
  const goals = (userState.goals || []).map((g) => GOAL_LABELS[g] || g).join(', ') || 'Équilibre';
  const adults = userState.adults || 2;
  const kids = userState.kids || 0;
  const totalDiners = adults + kids;
  const foyer = kids > 0 ? `${adults} adulte(s) + ${kids} enfant(s) = ${totalDiners} convives au total` : `${adults} adulte(s), pas d'enfant`;

  // 1. Fusion des allergies classiques et personnalisées — les allergies
  // prédéfinies sont maintenant détaillées en familles d'aliments (voir
  // describeAllergyExclusions), pas juste un mot isolé, pour que l'IA
  // n'oublie pas un dérivé (ex: la semoule pour "gluten").
  const predefinedAllergyDetails = describeAllergyExclusions(userState.allergies);
  const allAllergies = [predefinedAllergyDetails, ...(userState.customAllergies || [])]
    .filter(Boolean)
    .join(' ; ') || 'Aucune';

  // 2. Traitement des goûts (mémoire IA)
  // ⚡ CHANGÉ : les ingrédients détestés ne sont plus une exclusion stricte
  // (contrairement aux allergies, qui restent un vrai interdit médical/de
  // confort). "Ne pas aimer" un ingrédient est une préférence, pas un
  // danger — on demande donc à l'IA de les éviter EN PRIORITÉ, mais de
  // pouvoir quand même les utiliser s'il n'y a pas d'alternative crédible
  // pour le plat, plutôt que de se retrouver bloquée. Voir aussi la règle 7
  // plus bas et le champ "usedDislikedIngredient" attendu dans le JSON.
  const loved = (userState.lovedIngredients || []).join(', ') || 'Aucun en particulier';
  const disliked = (userState.dislikedIngredients || []).join(', ') || 'Aucun';

  return `
Tu es un diététicien-nutritionniste clinique et un chef de bistrot passionné par la gastronomie familiale française.
Objectif : Créer des recettes parfaitement saines, réconfortantes et familières avec des produits trouvables dans la grande distribution française (Leclerc, Carrefour, etc.).
IMPORTANT : Privilégie des plats familiaux typiquement français (gratins, plats en sauce légers, quiches, hachis, classiques de brasserie). Fuis absolument les plats trop américanisés, les 'bowls' complexes, ou les ingrédients exotiques inutiles.

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
3. COMPLÉTUDE OBLIGATOIRE — NIVEAU DÉBUTANT ABSOLU : L'utilisateur n'a jamais cuisiné de sa vie. Tu DOIS décomposer chaque action de manière chirurgicale et atomique (minimum 6 à 10 étapes). Interdit de dire "Faites cuire les pâtes", tu dois dire "Étape X: Prenez une grande casserole, remplissez-la d'eau au 3/4. Étape Y: Allumez la plaque à feu vif et portez à ébullition. Étape Z: Plongez les pâtes et laissez cuire 10 minutes". Chaque étape précise le geste exact, la quantité et le matériel. Une seule action principale par étape ! Ajoute un champ "tips" avec 1 à 3 conseils de chef.
4. QUANTITÉS PARTOUT : chaque ligne de "ingredientLines" a une quantité précise (g, ml, unité, cuillère...) — jamais "un peu de" ou "au goût" sauf pour sel/poivre. Chaque étape qui utilise un ingrédient répète sa quantité (ex: "Faites revenir les 200g de poulet coupé en dés").
5. FAISABILITÉ RÉELLE : les temps de cuisson, températures et étapes doivent être culinairement exacts et réalisables avec les ustensiles listés — pas d'approximation ni d'étape inventée pour faire joli.
6. PORTIONS RÉELLES DU FOYER : "servings" doit être EXACTEMENT ${totalDiners}, et TOUTES les quantités de "ingredientLines" doivent être calculées pour ${totalDiners} convives — jamais une quantité générique "pour 2" par défaut. Si des enfants sont présents, adapte leurs portions à une quantité réaliste plus petite qu'un adulte, mais ${totalDiners} reste le total de "servings".
7. GOÛTS — ALLERGIES vs PRÉFÉRENCES (traitement différent, ne pas confondre) :
   - "Exclusions strictes" (allergies) : INTERDIT ABSOLU, sans exception. Ne les utilise JAMAIS, même en trace.
   - "Ingrédients DÉTESTÉS" : ce sont des préférences, pas des dangers. ÉVITE-les en priorité et cherche une alternative crédible (ex: un autre légume, une autre viande). Mais si le plat n'a vraiment aucune bonne alternative sans dénaturer la recette, tu PEUX quand même utiliser un ingrédient détesté plutôt que de bloquer — dans ce cas uniquement, mets "usedDislikedIngredient": true et écris dans "dislikedIngredientNote" une courte phrase honnête et sympathique à destination de l'utilisateur expliquant pourquoi (ex: "Malgré votre aversion pour les champignons, ils sont essentiels ici pour la texture de la sauce — heureusement, ils sont finement mixés et presque indétectables." ou "Difficile de faire un vrai risotto sans céleri en fond aromatique — on en met juste une petite touche."). Si aucun ingrédient détesté n'est utilisé, laisse "usedDislikedIngredient": false et "dislikedIngredientNote": "".
   - Essaie d'incorporer intelligemment les "Ingrédients ADORÉS" si cela a du sens culinairement.
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