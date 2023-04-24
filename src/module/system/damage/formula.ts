import { DamageDicePF2e, ModifierPF2e } from "@actor/modifiers.ts";
import { DegreeOfSuccessIndex, DEGREE_OF_SUCCESS } from "@system/degree-of-success.ts";
import { groupBy, sum, sortBy } from "@util";
import {
    CriticalInclusion,
    DamageCategoryUnique,
    DamageFormulaData,
    DamageType,
    MaterialDamageEffect,
} from "./types.ts";
import { CRITICAL_INCLUSION } from "./values.ts";

/** A compiled formula with its associated breakdown */
interface AssembledFormula {
    formula: string;
    breakdown: string[];
}

/** Convert the damage definition into a final formula, depending on whether the hit is a critical or not. */
function createDamageFormula(
    damage: DamageFormulaData,
    degree: (typeof DEGREE_OF_SUCCESS)["SUCCESS" | "CRITICAL_SUCCESS"]
): AssembledFormula;
function createDamageFormula(damage: DamageFormulaData): AssembledFormula;
function createDamageFormula(damage: DamageFormulaData, degree: typeof DEGREE_OF_SUCCESS.CRITICAL_FAILURE): null;
function createDamageFormula(damage: DamageFormulaData, degree?: DegreeOfSuccessIndex): AssembledFormula | null;
function createDamageFormula(
    damage: DamageFormulaData,
    degree: DegreeOfSuccessIndex = DEGREE_OF_SUCCESS.SUCCESS
): AssembledFormula | null {
    damage = deepClone(damage);

    // Handle critical failure not dealing damage, and splash still applying on a failure
    // These are still couched on weapon/melee assumptions. They'll need to be adjusted later
    if (degree === DEGREE_OF_SUCCESS.CRITICAL_FAILURE) {
        return null;
    } else if (degree === DEGREE_OF_SUCCESS.FAILURE) {
        damage.dice = damage.dice.filter((d): d is DamageDicePF2e => d.category === "splash");
        damage.modifiers = damage.modifiers.filter((m) => m.damageCategory === "splash");
    }

    const critical = degree === DEGREE_OF_SUCCESS.CRITICAL_SUCCESS;
    const { base } = damage;

    // Group dice by damage type
    const typeMap: DamageTypeMap = new Map();
    if ((base.diceNumber && base.dieSize) || base.modifier) {
        const label = (() => {
            const diceSection = base.diceNumber ? `${base.diceNumber}${base.dieSize}` : null;
            if (!diceSection) return String(base.modifier);

            const modifier = base.modifier ? Math.abs(base.modifier) : null;
            const operator = base.modifier < 0 ? " - " : " + ";
            return [diceSection, modifier].filter((p) => p !== null).join(operator);
        })();

        typeMap.set(base.damageType, [
            {
                label,
                dice:
                    base.diceNumber && base.dieSize
                        ? { number: base.diceNumber, faces: Number(base.dieSize.replace("d", "")) }
                        : null,
                modifier: base.modifier ?? 0,
                critical: null,
                category: base.category,
                materials: base.materials ?? [],
            },
        ]);
    }

    // Dice always stack
    for (const dice of damage.dice.filter((d) => d.enabled)) {
        const dieSize = dice.dieSize || base.dieSize || null;
        if (dice.diceNumber > 0 && dieSize) {
            const damageType = dice.damageType ?? base.damageType;
            const list = typeMap.get(damageType) ?? [];
            list.push({
                label: dice.label,
                dice: { number: dice.diceNumber, faces: Number(dieSize.replace("d", "")) },
                modifier: 0,
                category: dice.category,
                critical: dice.critical,
            });
            typeMap.set(damageType, list);
        }
    }

    // Test that a damage modifier or dice partial is compatible with the prior check result
    const outcomeMatches = (m: { critical: boolean | null }): boolean => critical || m.critical !== true;

    const modifiers = damage.modifiers
        .filter((m) => m.enabled)
        .flatMap((modifier): ModifierPF2e | never[] => {
            modifier.damageType ??= base.damageType;
            return outcomeMatches(modifier) ? modifier : [];
        });

    for (const modifier of modifiers) {
        const damageType = modifier.damageType ?? base.damageType;
        const list = typeMap.get(damageType) ?? [];
        list.push({
            label: `${modifier.label} ${modifier.value < 0 ? "" : "+"}${modifier.value}`,
            dice: null,
            modifier: modifier.value,
            category: modifier.damageCategory,
            critical: modifier.critical,
        });
        typeMap.set(damageType, list);
    }

    const instances = [
        instancesFromTypeMap(typeMap, { degree }),
        instancesFromTypeMap(typeMap, { degree, persistent: true }),
    ].flat();

    const commaSeparated = instances.map((i) => i.formula).join(",");
    const breakdown = instances.flatMap((i) => i.breakdown);
    return { formula: `{${commaSeparated}}`, breakdown };
}

/** Convert a damage type map to a final string formula. */
function instancesFromTypeMap(
    typeMap: DamageTypeMap,
    { degree, persistent = false }: { degree: DegreeOfSuccessIndex; persistent?: boolean }
): AssembledFormula[] {
    return Array.from(typeMap.entries()).flatMap(([damageType, typePartials]): AssembledFormula | never[] => {
        // Filter persistent (or filter out) based on persistent option
        const partials = typePartials.filter((p) => (p.category === "persistent") === persistent);
        if (partials.length === 0) return [];

        // Split into categories, which must be processed in a specific order
        const groups = groupBy(partials, (partial) => partial.category);

        const nonCriticalDamage = ((): string | null => {
            const criticalInclusion =
                degree === DEGREE_OF_SUCCESS.CRITICAL_SUCCESS
                    ? [CRITICAL_INCLUSION.DOUBLE_ON_CRIT]
                    : [CRITICAL_INCLUSION.DOUBLE_ON_CRIT, CRITICAL_INCLUSION.DONT_DOUBLE_ON_CRIT];

            // Whether to double the dice of these partials
            const doubleDice =
                degree === DEGREE_OF_SUCCESS.CRITICAL_SUCCESS &&
                criticalInclusion.includes(null) &&
                game.settings.get("pf2e", "critRule") === "doubledice";

            // If dice doubling is enabled, any doubling of dice or constants is handled by `createPartialFormulas`
            const double = degree === DEGREE_OF_SUCCESS.CRITICAL_SUCCESS && !doubleDice;
            return sumExpression(createPartialFormulas(groups, { criticalInclusion, doubleDice }), { double });
        })();

        const criticalDamage = ((): string | null => {
            if (degree !== DEGREE_OF_SUCCESS.CRITICAL_SUCCESS) return null;
            const criticalInclusion = [CRITICAL_INCLUSION.CRITICAL_ONLY, CRITICAL_INCLUSION.DONT_DOUBLE_ON_CRIT];
            return sumExpression(createPartialFormulas(groups, { criticalInclusion }));
        })();

        const summedDamage = sumExpression(degree ? [nonCriticalDamage, criticalDamage] : [nonCriticalDamage]);
        const enclosed = ensureValidFormulaHead(summedDamage);

        const flavor = ((): string => {
            const typeFlavor = damageType === "untyped" && !persistent ? [] : [damageType];
            const persistentFlavor = persistent ? ["persistent"] : [];
            const materialFlavor = typePartials.flatMap((p) => p.materials ?? []);
            const allFlavor = [typeFlavor, persistentFlavor, materialFlavor].flat().join(",");
            return allFlavor.length > 0 ? `[${allFlavor}]` : "";
        })();

        const breakdown = (() => {
            const categories = [null, "persistent", "precision", "splash"] as const;
            const flattenedDamage = categories.flatMap((c) => groups.get(c) ?? []);
            const breakdownDamage = flattenedDamage.filter((d) => d.critical !== true);
            if (degree === DEGREE_OF_SUCCESS.CRITICAL_SUCCESS) {
                breakdownDamage.push(...flattenedDamage.filter((d) => d.critical === true));
            }

            if (!breakdownDamage.length) return [];

            const damageTypeLabel =
                breakdownDamage[0].category === "persistent"
                    ? game.i18n.format("PF2E.Damage.PersistentTooltip", {
                          damageType: game.i18n.localize(CONFIG.PF2E.damageTypes[damageType] ?? damageType),
                      })
                    : game.i18n.localize(CONFIG.PF2E.damageTypes[damageType] ?? damageType);
            const labelParts = breakdownDamage.map((d) => d.label);
            labelParts[0] = `${labelParts[0].replace(/^\s+\+/, "")} ${damageTypeLabel}`;

            return labelParts;
        })();

        const formula = enclosed && flavor ? `${enclosed}${flavor}` : enclosed;
        return formula ? { formula, breakdown } : [];
    });
}

function createPartialFormulas(
    partials: Map<DamageCategoryUnique | null, DamagePartial[]>,
    { criticalInclusion, doubleDice = false }: PartialFormulaParams
): string[] {
    const categories = [null, "persistent", "precision", "splash"] as const;
    return categories.flatMap((category) => {
        const requestedPartials = (partials.get(category) ?? []).filter((p) => criticalInclusion.includes(p.critical));
        const term = ((): string => {
            const expression = combinePartialTerms(requestedPartials, { doubleDice });
            return ["precision", "splash"].includes(category ?? "") && hasOperators(expression)
                ? `(${expression})`
                : expression;
        })();
        const flavored = term && category && category !== "persistent" ? `${term}[${category}]` : term;

        return flavored || [];
    });
}

/** Combines damage dice and modifiers into a single formula, ignoring the damage type and category. */
function combinePartialTerms(terms: DamagePartialTerm[], { doubleDice }: { doubleDice?: boolean } = {}): string {
    const constant = terms.reduce((total, p) => total + p.modifier, 0);

    // Group dice by number of faces
    const dice = terms
        .filter((p): p is DamagePartial & { dice: NonNullable<DamagePartial["dice"]> } => !!p.dice && p.dice.number > 0)
        .sort(sortBy((t) => -t.dice.faces));

    // Combine dice into dice-expression strings
    const byFace = [...groupBy(dice, (t) => t.dice.faces).values()];
    const combinedDice = byFace.map((terms) => ({
        ...terms[0],
        dice: { ...terms[0].dice, number: sum(terms.map((d) => d.dice.number)) },
    }));
    const positiveDice = combinedDice.filter((t) => t.dice.number > 0);
    const diceTerms = positiveDice.map((term) => {
        const number = doubleDice ? term.dice.number * 2 : term.dice.number;
        const faces = term.dice.faces;
        return doubleDice ? `(${number}d${faces}[doubled])` : `${number}d${faces}`;
    });

    // Create the final term. Double the modifier here if dice doubling is enabled
    return [diceTerms.join(" + "), Math.abs(constant)]
        .filter((e) => !!e)
        .map((e) => (typeof e === "number" && doubleDice ? `2 * ${e}` : e))
        .join(constant > 0 ? " + " : " - ");
}

/**
 * Given a simple flavor-less formula with only +/- operators, returns a list of damage partial terms.
 * All subtracted terms become negative terms.
 */
function parseTermsFromSimpleFormula(formula: string | Roll): DamagePartialTerm[] {
    const roll = formula instanceof Roll ? formula : new Roll(formula);

    // Parse from right to left so that when we hit an operator, we already have the term.
    return roll.terms.reduceRight((result, term) => {
        // Ignore + terms, we assume + by default
        if (term.expression === " + ") return result;

        // - terms modify the last term we parsed
        if (term.expression === " - ") {
            const termToModify = result[0];
            if (termToModify) {
                if (termToModify.modifier) termToModify.modifier *= -1;
                if (termToModify.dice) termToModify.dice.number *= -1;
            }
            return result;
        }

        result.unshift({
            modifier: term instanceof NumericTerm ? term.number : 0,
            dice: term instanceof Die ? { faces: term.faces, number: term.number } : null,
        });

        return result;
    }, <DamagePartialTerm[]>[]);
}

interface PartialFormulaParams {
    /** Whether critical damage is to be inconcluded in the generated formula and also doubled */
    criticalInclusion: CriticalInclusion[];
    /** Whether to double the dice of these partials */
    doubleDice?: boolean;
}

function sumExpression(terms: (string | null)[], { double = false } = {}): string | null {
    if (terms.every((t) => !t)) return null;

    const summed = terms.filter((p): p is string => !!p).join(" + ") || null;
    const enclosed = double && hasOperators(summed) ? `(${summed})` : summed;

    return double ? `2 * ${enclosed}` : enclosed;
}

/** Helper for helpers */
function hasOperators(formula: string | null): boolean {
    return /[-+*/]/.test(formula ?? "");
}

/** Ensures the formula is valid as a damage instance formula before flavor is attached */
function ensureValidFormulaHead(formula: string | null): string | null {
    if (!formula) return null;
    const isWrapped = /^\(.*\)$/.test(formula);
    const isSimple = /^\d+(d\d+)?$/.test(formula);
    return isWrapped || isSimple ? formula : `(${formula})`;
}

/** A pool of damage dice & modifiers, grouped by damage type. */
type DamageTypeMap = Map<DamageType, DamagePartial[]>;

interface DamagePartialTerm {
    /** The static amount of damage of the current damage type and category. */
    modifier: number;
    /** Maps the die face ("d4", "d6", "d8", "d10", "d12") to the number of dice of that type. */
    dice: { number: number; faces: number } | null;
}

interface DamagePartial extends DamagePartialTerm {
    /** Used to create the corresponding breakdown tag */
    label: string;
    category: DamageCategoryUnique | null;
    critical: boolean | null;
    materials?: MaterialDamageEffect[];
}

export { AssembledFormula, DamagePartialTerm, combinePartialTerms, createDamageFormula, parseTermsFromSimpleFormula };
