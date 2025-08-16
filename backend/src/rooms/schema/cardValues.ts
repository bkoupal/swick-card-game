export const availableSuits = ['♠︎', '♥︎', '♣︎', '♦︎'];
export const availableValues = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export type Suit = (typeof availableSuits)[number];
export type Value = (typeof availableValues)[number];

export function getRandomArrayItem<Type>(arr: Type[]) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Numeric strength for comparisons (higher is stronger). */
export const valueStrength: Record<Value, number> = {
  '7': 0, // Lowest card normally
  '8': 1,
  '9': 2,
  '10': 3,
  J: 4,
  Q: 5,
  K: 6,
  A: 7, // Highest card normally
};

/** Returns true if v1 > v2 by rank (suit/ties handled by caller). */
export function isHigherValue(v1: Value, v2: Value) {
  return valueStrength[v1] > valueStrength[v2];
}

/**
 * Get numeric value for SWICK game logic
 * Note: In SWICK, 7s are special (lowest except in 3-of-a-kind),
 * Aces are highest except in 3-of-a-kind
 */
export function getCardNumericValue(value: Value): number {
  switch (value) {
    case '7':
      return 7;
    case '8':
      return 8;
    case '9':
      return 9;
    case '10':
      return 10;
    case 'J':
      return 11;
    case 'Q':
      return 12;
    case 'K':
      return 13;
    case 'A':
      return 14; // Ace high
    default:
      return 0;
  }
}
