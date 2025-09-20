import { Schema, MapSchema, type, ArraySchema, filter } from '@colyseus/schema';
import gameConfig from '../../game.config';
import {
  availableSuits,
  availableValues,
  getRandomArrayItem,
  Suit,
  Value,
} from './cardValues';
import { RoomMetadata } from './RoomMetadata';

/**
 * Represents the value (suit and value) of a single card
 */
export class CardValue extends Schema {
  @type('string') suit: string;
  @type('string') value: string;
}

/**
 * Represents a single card
 */
export class Card extends Schema {
  @type('boolean') visible: boolean;
  @type('boolean') selected: boolean = false;

  @filter(function (this: Card) {
    return this.visible;
  })
  @type(CardValue)
  value?: CardValue;

  constructor(suit?: Suit, value?: Value, visible = true) {
    super();

    this.visible = visible;
    this.selected = false;

    if (suit && value) {
      this.value = new CardValue({
        suit: suit,
        value: value,
      });
    } else {
      // Fallback for backwards compatibility
      this.value = new CardValue({
        suit: getRandomArrayItem(availableSuits),
        value: getRandomArrayItem(availableValues),
      });
    }
  }
}

/**
 * Represents a card played in the current trick
 */
export class PlayedCard extends Schema {
  @type('string') playerId: string;
  @type(Card) card: Card;
  @type('number') playOrder: number; // Order in which card was played (0 = first, 1 = second, etc.)

  constructor(playerId: string, card: Card, playOrder: number) {
    super();
    this.playerId = playerId;
    this.card = card;
    this.playOrder = playOrder;
  }
}

/**
 * Represents a completed trick
 */
export class CompletedTrick extends Schema {
  @type([PlayedCard]) playedCards = new ArraySchema<PlayedCard>();
  @type('string') winnerId: string;
  @type('number') trickNumber: number; // 1, 2, or 3

  constructor(trickNumber: number) {
    super();
    this.trickNumber = trickNumber;
  }
}

/**
 * Represents a deck of 32 cards (7-A in all suits)
 */
export class Deck extends Schema {
  @type([Card]) cards = new ArraySchema<Card>();

  constructor() {
    super();
    this.reset();
  }

  /**
   * Creates a fresh 32-card deck and shuffles it
   */
  public reset() {
    this.cards.clear();

    // Create all 32 cards (7-A in each suit)
    for (const suit of availableSuits) {
      for (const value of availableValues) {
        this.cards.push(new Card(suit, value, false)); // Cards start face down
      }
    }

    this.shuffle();
  }

  /**
   * Shuffles the deck using Fisher-Yates algorithm
   */
  public shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /**
   * Draws a card from the top of the deck
   * @param visible Whether the card should be visible to players
   * @returns The drawn card or null if deck is empty
   */
  public drawCard(visible = true): Card | null {
    if (this.cards.length === 0) {
      return null; // Deck is empty
    }

    const card = this.cards.pop();
    if (card) {
      card.visible = visible;
    }
    return card || null;
  }

  /**
   * Returns the number of cards remaining in the deck
   */
  public get remainingCards(): number {
    return this.cards.length;
  }
}

/**
 * Represents a set of cards (player's hand)
 */
export class Hand extends Schema {
  @type([Card]) cards = new ArraySchema<Card>();

  public addCardFromDeck(deck: Deck, visible = true) {
    const card = deck.drawCard(visible);
    if (card) {
      this.cards.push(card);
    }
    return card;
  }

  public clear() {
    this.cards.clear();
  }

  // SWICK-specific methods will be added in later steps
  // For now, keep basic structure compatible
  public get score() {
    // Placeholder - will be replaced with SWICK hand evaluation
    return 0;
  }

  public get isBlackjack() {
    // Not applicable to SWICK, but keeping for compatibility during transition
    return false;
  }

  public get isBusted() {
    // Not applicable to SWICK, but keeping for compatibility during transition
    return false;
  }

  public calculateScore() {
    // Placeholder - will implement SWICK hand evaluation later
  }

  // Keep old addCard method for backwards compatibility during transition
  public addCard(visible?: boolean) {
    // This will be deprecated once we fully transition to deck-based drawing
    this.cards.push(new Card(undefined, undefined, visible));
  }

  public addSpecificCard(value: Value, suit: Suit, visible = true) {
    const card = new Card(suit, value, visible);
    this.cards.push(card);
    return card;
  }
}

export class Player extends Schema {
  @type('string') sessionId: string;
  @type('string') displayName: string;
  @type('number') money: number = gameConfig.initialPlayerMoney;
  @type('number') bet: number = gameConfig.initialPlayerBet;
  @type('boolean') ready = false;
  @type('boolean') autoReady = false;
  @type('boolean') disconnected = false;
  @type('boolean') admin: boolean;
  @type('string') roundOutcome: roundOutcome;
  @type(Hand) hand = new Hand();

  // SWICK-specific player states
  @type('boolean') knockedIn = false; // Whether player "knocked in" to play this hand
  @type('boolean') hasKnockDecision = false; // Whether player has made knock decision yet
  // Discard/draw phase states
  @type('number') cardsToDiscard = 0; // Number of cards player wants to discard (0-3)
  @type([Card]) discardedCards = new ArraySchema<Card>(); // Cards the player discarded
  @type('boolean') hasDiscardDecision = false; // Whether player has made discard decision yet
  @type([Card]) selectedCards = new ArraySchema<Card>(); // Cards the player has selected for discard
  @type('boolean') dealerCompletedNormalDiscard = false; // Whether dealer finished their normal discard/draw
  // Going Set tracking
  @type('number') tricksWon: number = 0; // Number of tricks won this round
  @type('boolean') wentSet: boolean = false; // Whether player went set this round
  @type('number') setAmount: number = 0; // Amount player owes for going set
  @type('string') setType: string = ''; // 'single' or 'double' for dealers

  // Bot Handling
  @type('boolean') isBot: boolean = false;
  @type('string') botDifficulty: string = '';

  @type(['string']) shownMessages = new ArraySchema<string>();
}

export class GameState extends Schema {
  @type('string') roundState:
    | 'idle'
    | 'dealing'
    | 'trump-selection'
    | 'knock-in'
    | 'discard-draw'
    | 'turns'
    | 'trick-complete'
    | 'special-hand-win'
    | 'end' = 'idle';
  @type('string') currentDiscardPlayerId: string = '';
  @type('string') currentKnockPlayerId: string = ''; // Player whose turn it is to knock
  @type('string') currentTurnPlayerId: string;
  @type('uint64') currentTurnTimeoutTimestamp: number = 0;
  @type('uint64') nextRoundStartTimestamp: number = 0;

  @type(Hand) dealerHand = new Hand();
  @type({ map: Player }) players = new MapSchema<Player>();
  @type(Deck) deck = new Deck();

  // SWICK-specific fields
  @type('string') trumpSuit: string = '';
  @type('number') potValue: number = 0;
  @type('number') currentAnteAmount: number = 0;
  @type(Card) trumpCard?: Card; // The trump card that determines the trump suit
  @type('string') dealerId: string = ''; // Which player is the dealer for this hand
  @type([PlayedCard]) currentTrick = new ArraySchema<PlayedCard>(); // Cards played in current trick
  @type([CompletedTrick]) completedTricks = new ArraySchema<CompletedTrick>(); // History of completed tricks
  @type('string') trickLeaderId: string = ''; // Who leads the current trick
  @type('number') currentTrickNumber: number = 1; // Which trick we're on (1, 2, or 3)

  // Special hand display fields
  @type('string') specialHandWinner: string = ''; // Player ID who won with special hand
  @type('string') specialHandType: string = ''; // Type: 'three-aces', 'three-sevens', 'akq-trump'
  @type('string') specialHandDescription: string = ''; // Human-readable description
  @type('number') specialHandPotValue: number = 0; // Pot value won

  // Going Set tracking
  @type('boolean') dealerKeptTrump: boolean = false; // Whether dealer kept the trump card
  @type('string') dealerTrumpValue: string = ''; // Value of trump card dealer kept (for set requirements)
  @type('number') nextRoundPotBonus: number = 0; // Extra pot from players who went set
  @type('boolean') dealerHasSetAnte: boolean = false;

  @type('string') specialRoundOutcome: string = '';
  @type('string') specialRoundMessage: string = '';

  @type(RoomMetadata) roomMetadata = new RoomMetadata();

  @type('boolean') dealerKeptTrumpMessage: boolean = false;
  @type('number') dealerKeptTrumpMessageTimestamp: number = 0;

  @type('boolean') dealerSetAnteMessage: boolean = false;
  @type('string') dealerSetAnteAmount: string = '';
}

export type roundOutcome = 'bust' | 'win' | 'lose' | 'draw' | '';
