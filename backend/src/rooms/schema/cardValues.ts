export const availableSuits = ['♠︎', '♥︎', '♣︎', '♦︎'];
export const availableValues = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export type Suit = (typeof availableSuits)[number];
export type Value = (typeof availableValues)[number];

export function getRandomArrayItem<Type>(arr: Type[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Numeric strength for comparisons (higher is stronger). */
export const valueStrength: Record<Value, number> = availableValues.reduce(
  (acc, v, idx) => {
    acc[v] = idx; // 7=0 … A=7
    return acc;
  },
  {} as Record<Value, number>
);

/** Returns true if v1 > v2 by rank (suit/ties handled by caller). */
export function isHigherValue(v1: Value, v2: Value) {
  return valueStrength[v1] > valueStrength[v2];
}
