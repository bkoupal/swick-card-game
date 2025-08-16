export default {
  maxClients: 6,
  roomIdLength: 4,
  minPlayers: 3, // SWICK requires minimum 3 players

  //All times are in ms
  inactivityTimeout: 30000,
  roomDeleteTimeout: 60000,
  delayedRoundStartTime: 2000,
  roundStateDealingTime: 1000,
  dealerCardDelay: 1000,
  roundOutcomeDelay: 1000,
  roundStateEndTimeBase: 2500,
  roundStateEndTimePlayer: 500,

  // SWICK betting (using cents as base unit)
  minBet: 3, // Minimum ante is 3 cents per person
  maxBet: 1000, // Maximum bet
  initialPlayerMoney: 10000, // Starting with 100 dollars (10000 cents)
  initialPlayerBet: 3, // Default ante of 3 cents

  // Websocket Code when player is disconnected by server
  kickCode: 4000,
  roomFullCode: 4444,
  pingInterval: 5000,

  // SWICK-specific configuration
  cardsPerHand: 3, // Each player gets 3 cards
  dealerExtraAnte: 3, // Dealer antes 3 cents more than regular ante
};
