import { Room, Client, Delayed, Protocol, ServerError } from 'colyseus';
import {
  GameState,
  Player,
  PlayedCard,
  CompletedTrick,
  Card,
} from './schema/GameState';
import gameConfig from '../game.config';
import log from 'npmlog';
import {
  generateUserName,
  generateRoomId,
  computeRoundOutcome,
} from './utility';
import { ArraySchema } from '@colyseus/schema';

export class GameRoom extends Room<GameState> {
  /** Current timeout skip reference */
  public inactivityTimeoutRef?: Delayed;
  public delayedRoundStartRef?: Delayed;
  public delayedRoomDeleteRef?: Delayed;

  /** Iterator for all players that are playing in the current round */
  private roundPlayersIdIterator: IterableIterator<string>;

  public autoDispose = false;
  private LOBBY_CHANNEL = 'GameRoom';

  private log(msg: string, client?: Client | string) {
    if (process.env.ROOM_LOG_DISABLE == 'true') return;

    log.info(
      `Room ${this.roomId} ${
        client ? 'Client ' + ((<any>client).sessionId || client) : ''
      }`,
      msg
    );
  }

  private async registerRoomId(): Promise<string> {
    const currentIds = await this.presence.smembers(this.LOBBY_CHANNEL);
    let id;

    do id = generateRoomId();
    while (currentIds.includes(id));

    await this.presence.sadd(this.LOBBY_CHANNEL, id);
    return id;
  }

  private delay(ms: number) {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  async onCreate() {
    this.roomId = await this.registerRoomId();
    this.setPrivate();
    this.setState(new GameState({}));
    this.clock.start();

    this.log('Created');

    //Send ping messages to all clients
    this.clock.setInterval(() => {
      this.broadcast('ping');
    }, gameConfig.pingInterval);

    // Client message listeners:

    this.onMessage('ready', (client, state: boolean) => {
      //Cant change ready state during round
      if (this.state.roundState != 'idle' || typeof state != 'boolean') return;

      this.log(`Ready state change: ${state}`, client);

      this.state.players.get(client.sessionId).ready = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage('autoReady', (client, state: boolean) => {
      if (this.state.roundState != 'idle' || typeof state != 'boolean') return;

      this.log(`Auto ready state change: ${state}`, client);

      const player = this.state.players.get(client.sessionId);
      player.ready = player.autoReady = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage('bet', (client, newBet: number) => {
      if (
        this.state.roundState != 'idle' || //Cant change bet during round
        this.state.players.get(client.sessionId).ready || //Cant change bet when ready
        !Number.isInteger(newBet) // new bet is invalid
      )
        return;

      //Constrain bet
      newBet = Math.min(Math.max(newBet, gameConfig.minBet), gameConfig.maxBet);

      this.log(`Bet change: ${newBet}`, client);

      this.state.players.get(client.sessionId).bet = newBet;
    });

    this.onMessage('playCard', (client, cardIndex: number) => {
      if (
        client.sessionId != this.state.currentTurnPlayerId ||
        this.state.roundState != 'turns' ||
        typeof cardIndex !== 'number'
      )
        return;

      this.log(`Play card at index ${cardIndex}`, client);

      const player = this.state.players.get(client.sessionId);

      // Validate card index
      if (cardIndex < 0 || cardIndex >= player.hand.cards.length) {
        this.log(`Invalid card index: ${cardIndex}`);
        return;
      }

      const cardToPlay = player.hand.cards[cardIndex];

      // Validate the card play according to SWICK rules
      if (!this.isValidCardPlay(player, cardToPlay)) {
        this.log(`Invalid card play attempted`);
        return;
      }

      // Play the card
      this.playCard(player, cardToPlay, cardIndex);
    });

    this.onMessage('kick', (client, id: string) => {
      if (!this.state.players.get(client.sessionId)?.admin || !id) return;

      this.log(`Kick client ${id}`, client);

      this.clients
        .find((c) => c.sessionId == id)
        ?.leave(Protocol.WS_CLOSE_CONSENTED);
    });

    this.onMessage('keepTrump', (client, keep: boolean) => {
      // Only dealer can make trump decision during trump-selection phase
      if (
        this.state.roundState != 'trump-selection' ||
        client.sessionId != this.state.dealerId ||
        typeof keep != 'boolean'
      )
        return;

      this.log(`Dealer ${keep ? 'keeps' : 'discards'} trump card`, client);

      if (keep) {
        // Dealer keeps trump card - add it to dealer's hand
        const dealer = this.state.players.get(client.sessionId);
        if (this.state.trumpCard) {
          dealer.hand.cards.push(this.state.trumpCard);
        }
      }

      // Set trump suit based on the trump card
      if (this.state.trumpCard) {
        this.state.trumpSuit = this.state.trumpCard.value!.suit;
      }

      this.startKnockInPhase();
    });

    this.onMessage('knockIn', (client, knockIn: boolean) => {
      if (this.state.roundState != 'knock-in' || typeof knockIn != 'boolean')
        return;

      const player = this.state.players.get(client.sessionId);
      if (!player || player.hasKnockDecision) return;

      // Only allow current knock player to make decision
      if (client.sessionId !== this.state.currentKnockPlayerId) return;

      this.log(`Player ${knockIn ? 'knocks in' : 'passes'}`, client);

      player.knockedIn = knockIn;
      player.hasKnockDecision = true;

      // If player passes, they lose their ante but are out of the hand
      if (!knockIn) {
        // Money was already taken for ante, so they just lose it
        player.ready = false; // Remove from round
      }

      // Clear timeout and move to next player
      this.inactivityTimeoutRef?.clear();

      // Handle dealer vs non-dealer differently
      if (client.sessionId === this.state.dealerId) {
        // Dealer made decision
        if (knockIn) {
          // Dealer knocked in, start dealer discard phase
          this.log(`Dealer knocked in - starting dealer discard phase`);
          this.state.roundState = 'discard-draw';
          this.state.currentDiscardPlayerId = this.state.dealerId;
          this.setInactivitySkipTimeout();
        } else {
          // Dealer passed, end the hand
          this.log(`Dealer passed - ending hand`);
          this.endRound();
        }
      } else {
        // Non-dealer made decision, continue with existing flow
        this.startNextKnockTurn();
      }
    });

    this.onMessage('selectCard', (client, cardIndex: number) => {
      if (
        this.state.roundState != 'discard-draw' ||
        client.sessionId != this.state.currentDiscardPlayerId ||
        typeof cardIndex !== 'number'
      )
        return;

      const player = this.state.players.get(client.sessionId);
      if (!player || player.hasDiscardDecision) return;

      // Validate card index
      if (cardIndex < 0 || cardIndex >= player.hand.cards.length) {
        this.log(`Invalid card index for selection: ${cardIndex}`);
        return;
      }

      const card = player.hand.cards[cardIndex];

      // Special case: Dealer final discard (after completing normal discard/draw)
      const isDealerFinalDiscard =
        client.sessionId === this.state.dealerId &&
        player.hand.cards.length === 4 &&
        player.dealerCompletedNormalDiscard;

      if (isDealerFinalDiscard) {
        // Check if trying to select trump card
        if (
          card.value?.suit === this.state.trumpSuit &&
          card.value?.value === this.state.trumpCard?.value?.value
        ) {
          this.log(`Dealer cannot select trump card for discard`);
          return;
        }

        // Clear other selections (can only select 1)
        for (const otherCard of player.hand.cards) {
          if (otherCard !== card) {
            otherCard.selected = false;
          }
        }

        // Toggle this card
        card.selected = !card.selected;
        this.log(
          `Card ${card.selected ? 'selected' : 'deselected'} for final discard`
        );
        return;
      }

      // Normal discard logic (max 3 cards can be selected)
      if (card.selected) {
        card.selected = false;
        this.log(`Card deselected at index ${cardIndex}`, client);
      } else {
        // Check if dealer is trying to select trump card
        if (
          client.sessionId === this.state.dealerId &&
          card.value?.suit === this.state.trumpSuit &&
          card.value?.value === this.state.trumpCard?.value?.value
        ) {
          this.log(`Dealer cannot select trump card for discard`);
          return;
        }

        // Count currently selected cards
        const selectedCount = player.hand.cards.filter(
          (c) => c.selected
        ).length;
        if (selectedCount < 3) {
          card.selected = true;
          this.log(`Card selected at index ${cardIndex}`, client);
        } else {
          this.log(`Cannot select more than 3 cards`, client);
        }
      }
    });

    this.onMessage('playCards', (client) => {
      if (
        this.state.roundState != 'discard-draw' ||
        client.sessionId != this.state.currentDiscardPlayerId
      )
        return;

      const player = this.state.players.get(client.sessionId);
      if (!player || player.hasDiscardDecision) return;

      this.log(`Player chooses to play with current cards`, client);

      player.hasDiscardDecision = true;
      // Clear any selected cards
      for (const card of player.hand.cards) {
        card.selected = false;
      }

      this.startNextDiscardTurn();
    });

    this.onMessage('discardDraw', (client) => {
      if (
        this.state.roundState != 'discard-draw' ||
        client.sessionId != this.state.currentDiscardPlayerId
      )
        return;

      const player = this.state.players.get(client.sessionId);
      if (!player || player.hasDiscardDecision) return;

      // Get selected cards
      const selectedCards = player.hand.cards.filter((card) => card.selected);

      if (selectedCards.length === 0) {
        this.log(`No cards selected for discard`, client);
        return;
      }

      // Special case: Dealer final discard (after completing normal discard/draw)
      const isDealerFinalDiscard =
        client.sessionId === this.state.dealerId &&
        player.dealerCompletedNormalDiscard;

      if (isDealerFinalDiscard) {
        // This is dealer's final discard - just remove the selected card, no drawing
        if (selectedCards.length !== 1) {
          this.log(`Dealer must select exactly 1 card for final discard`);
          return;
        }

        this.log(
          `Dealer final discard: ${selectedCards[0].value?.value} of ${selectedCards[0].value?.suit}`
        );

        // Remove the selected card
        player.hand.cards = player.hand.cards.filter((card) => !card.selected);
        player.hasDiscardDecision = true;

        // Continue to trick-taking phase
        this.startNextDiscardTurn();
        return;
      }

      // Normal discard/draw logic
      this.log(
        `Player discards ${selectedCards.length} cards and draws new ones`,
        client
      );

      // Remove selected cards from hand
      player.hand.cards = player.hand.cards.filter((card) => !card.selected);

      // Draw new cards to replace discarded ones
      for (let i = 0; i < selectedCards.length; i++) {
        player.hand.addCardFromDeck(this.state.deck, true);
      }

      // Mark that dealer has completed their normal discard/draw
      if (client.sessionId === this.state.dealerId) {
        player.dealerCompletedNormalDiscard = true;

        // Check if dealer now has 4 cards (kept trump card)
        if (player.hand.cards.length > 3) {
          this.log(
            `Dealer has ${player.hand.cards.length} cards - needs to discard 1 more (not trump)`
          );

          // Clear any selected cards and reset decision flag for final discard
          for (const card of player.hand.cards) {
            card.selected = false;
          }
          player.hasDiscardDecision = false;

          // Stay in discard phase for dealer's final discard
          this.state.currentDiscardPlayerId = this.state.dealerId;
          this.setInactivitySkipTimeout();
          return;
        }
      }

      player.hasDiscardDecision = true;
      this.startNextDiscardTurn();
    });
  }

  onAuth(client: Client) {
    //No more space at table
    if (this.state.players.size == gameConfig.maxClients)
      throw new ServerError(gameConfig.roomFullCode, 'room is full');

    //We have to kick the oldest disconnected player to make space for new player
    if (
      this.state.players.size + Object.keys(this.reconnections).length ==
      gameConfig.maxClients
    ) {
      Object.values(this.reconnections)[0].reject();
    }

    return true;
  }

  onJoin(client: Client) {
    this.log(`Join`, client);

    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: generateUserName(),
        admin: this.state.players.size == 0,
      })
    );

    this.triggerRoomDeleteCheck();
    this.triggerNewRoundCheck();
  }

  async onLeave(client: Client, consented: boolean) {
    this.log(`Leave`, client);

    const player = this.state.players.get(client.sessionId);
    player.disconnected = true;

    //Remove player if leave was consented or if they are not in round
    if (consented || !(this.state.roundState != 'idle' && player.ready)) {
      this.deletePlayer(client.sessionId);
    }

    //Do not allow for rejoin if leave was consented
    if (consented) return;

    //Add player back if they rejoin
    try {
      this.log(`Allow reconnection`, client);

      await this.allowReconnection(client);

      this.log(`Reconnect`, client);

      player.disconnected = false;

      //Add player back if they were removed
      if (!this.state.players.has(client.sessionId)) {
        this.state.players.set(client.sessionId, player.clone());
        this.triggerRoomDeleteCheck();
        this.triggerNewRoundCheck();
      }
    } catch (error) {}
  }

  onDispose() {
    this.presence.srem(this.LOBBY_CHANNEL, this.roomId);
    this.log(`Disposing`);
  }

  /** Automatically starts round if:
   * - There is no round currently
   * - All players are ready
   */
  private triggerNewRoundCheck() {
    if (this.state.roundState != 'idle') return;

    // Clear previous start
    this.state.nextRoundStartTimestamp = 0;
    this.delayedRoundStartRef?.clear();

    const playerArr = [...this.state.players.values()];

    // NEW: Require at least minPlayers and all of them “ready”
    if (
      playerArr.length < gameConfig.minPlayers ||
      playerArr.some((p) => !p.ready)
    ) {
      return;
    }

    this.log(`Setting delayed round start`);

    this.state.nextRoundStartTimestamp =
      Date.now() + gameConfig.delayedRoundStartTime;
    this.delayedRoundStartRef = this.clock.setTimeout(() => {
      this.state.nextRoundStartTimestamp = 0;
      this.startRound();
    }, gameConfig.delayedRoundStartTime);
  }

  /**
   * Deletes room after timeout if there are no players
   */
  private triggerRoomDeleteCheck() {
    if (this.state.players.size == 0) {
      this.log(`Setting delayed room delete`);

      this.delayedRoomDeleteRef?.clear();
      this.delayedRoomDeleteRef = this.clock.setTimeout(() => {
        this.disconnect();
      }, gameConfig.roomDeleteTimeout);
    } else if (this.delayedRoomDeleteRef?.active) {
      this.log('Cancelled room deletion');

      this.delayedRoomDeleteRef?.clear();
    }
  }

  private deletePlayer(id: string) {
    const player = this.state.players.get(id);

    //If deleted player reconnects, they should not be ready
    player.ready = false;

    this.state.players.delete(id);

    //If deleted player was admin, assign random other player as admin
    if (player.admin && this.state.players.size > 0) {
      player.admin = false;

      const a = [...this.state.players.values()];
      a[Math.floor(Math.random() * a.length)].admin = true;
    }

    //If player that was removed was the currently playing player, skip them
    if (id == this.state.currentTurnPlayerId) this.turn();

    this.triggerRoomDeleteCheck();
    this.triggerNewRoundCheck();
  }

  /** Offsets player order in round, used for making every round start at different player */
  public roundIteratorOffset = 0;

  /** Iterator over players that only takes ready players into account */
  private *makeRoundIterator() {
    let players = [...this.state.players.values()].filter((p) => p.ready);

    //Rotate players by offset
    players = players.concat(
      players.splice(0, this.roundIteratorOffset % players.length)
    );

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      //If grabbed player is not ready (they left during round), go to next player
      if (!player.ready) continue;

      //Otherwise yield the new player id
      yield player.sessionId;
    }
  }

  private async startRound() {
    this.log(`Starting dealing phase`);

    this.state.roundState = 'dealing';

    // Reset and shuffle the deck before each hand (SWICK rule)
    this.state.deck.reset();

    // Determine dealer (rotate each hand based on roundIteratorOffset)
    const allPlayers = [...this.state.players.values()].filter((p) => p.ready);
    const dealerIndex = this.roundIteratorOffset % allPlayers.length;
    this.state.dealerId = allPlayers[dealerIndex].sessionId;

    this.log(
      `Dealer is: ${this.state.players.get(this.state.dealerId).displayName}`
    );
    this.log(
      `Deck shuffled. Cards remaining: ${this.state.deck.remainingCards}`
    );

    // Reset player states for new hand
    for (const player of this.state.players.values()) {
      if (player.ready) {
        player.knockedIn = false;
        player.hasKnockDecision = false;
        player.roundOutcome = '';
      }
    }

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      //Take money for ante from player account
      // Dealer antes extra amount as per SWICK rules
      const anteAmount =
        playerId === this.state.dealerId
          ? player.bet + gameConfig.dealerExtraAnte
          : player.bet;

      player.money -= anteAmount;
      this.state.potValue += anteAmount;

      //Deal player 3 cards from the deck (SWICK rule)
      player.hand.clear();
      player.hand.addCardFromDeck(this.state.deck, true); // Card 1
      player.hand.addCardFromDeck(this.state.deck, true); // Card 2
      player.hand.addCardFromDeck(this.state.deck, true); // Card 3
    }

    // Draw the trump card (next card after all players are dealt)
    this.state.trumpCard = this.state.deck.drawCard(true);

    this.log(
      `Trump card drawn: ${this.state.trumpCard?.value?.value} of ${this.state.trumpCard?.value?.suit}`
    );
    this.log(
      `Cards remaining after dealing: ${this.state.deck.remainingCards}`
    );
    this.log(`Pot value: ${this.state.potValue}`);

    //Delay then start trump selection phase
    await this.delay(gameConfig.roundStateDealingTime);

    this.startTrumpSelectionPhase();
  }

  private startTrumpSelectionPhase() {
    this.log(`Starting trump selection phase`);
    this.state.roundState = 'trump-selection';

    // Clear dealer hand from previous games
    this.state.dealerHand.clear();

    // Dealer has time to decide whether to keep trump card
    this.setInactivitySkipTimeout();
  }

  private startKnockInPhase() {
    this.log(`Starting knock-in phase`);
    this.state.roundState = 'knock-in';
    this.state.currentTurnTimeoutTimestamp = 0;
    this.inactivityTimeoutRef?.clear();

    this.log(`Trump suit is: ${this.state.trumpSuit}`);

    // Start with first non-dealer player in order they joined
    this.startNextKnockTurn();
  }

  private startNextKnockTurn() {
    // Get NON-DEALER players who need to make a knock decision
    const activePlayers = [...this.state.players.values()].filter(
      (p) => p.ready
    );

    // Only non-dealers participate in initial knock-in phase
    const nonDealers = activePlayers.filter(
      (p) => p.sessionId !== this.state.dealerId
    );

    // Find next non-dealer who hasn't made decision yet
    const nextPlayer = nonDealers.find((p) => !p.hasKnockDecision);

    if (nextPlayer) {
      this.state.currentKnockPlayerId = nextPlayer.sessionId;
      this.log(`It's ${nextPlayer.displayName}'s turn to knock`);
      this.setInactivitySkipTimeout();
    } else {
      // All non-dealers have decided, check if any knocked in
      this.state.currentKnockPlayerId = '';
      this.checkNonDealerKnockDecisions();
    }
  }

  private checkNonDealerKnockDecisions() {
    const nonDealers = [...this.state.players.values()].filter(
      (p) => p.ready && p.sessionId !== this.state.dealerId
    );
    const playersIn = nonDealers.filter((p) => p.knockedIn);

    this.log(`Non-dealer players knocked in: ${playersIn.length}`);

    if (playersIn.length === 0) {
      // No non-dealers knocked in - end the hand, pot carries over
      this.log(`No non-dealers knocked in - ending hand`);
      this.endRound();
    } else {
      // Start discard/draw phase for non-dealers only
      this.log(`Starting discard/draw phase for non-dealers`);
      this.startDiscardDrawPhase();
    }
  }

  private checkAllKnockDecisions() {
    const activePlayers = [...this.state.players.values()].filter(
      (p) => p.ready
    );
    const decidedPlayers = activePlayers.filter((p) => p.hasKnockDecision);

    this.log(
      `Knock decisions: ${decidedPlayers.length}/${activePlayers.length}`
    );

    if (decidedPlayers.length === activePlayers.length) {
      // All players have made their knock decision
      const playersIn = activePlayers.filter((p) => p.knockedIn);

      this.log(`Players knocked in: ${playersIn.length}`);

      if (playersIn.length === 0) {
        // Nobody knocked in - end the hand, pot carries over
        this.log(`No players knocked in - ending hand`);
        this.endRound();
      } else {
        // Start the discard/draw phase
        this.log(`Starting discard/draw phase`);
        this.startDiscardDrawPhase();
      }
    }
  }

  private startDiscardDrawPhase() {
    this.state.roundState = 'discard-draw';
    this.state.currentTurnTimeoutTimestamp = 0;
    this.inactivityTimeoutRef?.clear();

    // Reset discard states for all knocked-in players
    for (const player of this.state.players.values()) {
      if (player.ready && player.knockedIn) {
        player.hasDiscardDecision = false;
        player.cardsToDiscard = 0;
        player.discardedCards.clear();
      }
    }

    this.log(`Starting discard/draw phase`);
    // Start with first non-dealer player in order they joined
    this.startNextDiscardTurn();
  }

  private startNextDiscardTurn() {
    // Get NON-DEALER knocked-in players who need to make discard decisions
    const knockedInNonDealers = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn && p.sessionId !== this.state.dealerId
    );

    // Find next non-dealer who hasn't made discard decision yet
    const nextPlayer = knockedInNonDealers.find((p) => !p.hasDiscardDecision);

    if (nextPlayer) {
      this.state.currentDiscardPlayerId = nextPlayer.sessionId;
      this.log(`It's ${nextPlayer.displayName}'s turn to discard/draw`);
      this.setInactivitySkipTimeout();
    } else {
      // All non-dealers have made discard decisions
      this.state.currentDiscardPlayerId = '';

      // Check if we're in dealer's discard phase
      const dealer = this.state.players.get(this.state.dealerId);
      if (dealer && dealer.knockedIn && !dealer.hasDiscardDecision) {
        // Dealer has knocked in but hasn't made discard decision yet
        this.state.currentDiscardPlayerId = this.state.dealerId;
        this.log(`Dealer's turn to discard/draw`);
        this.setInactivitySkipTimeout();
      } else {
        // Either dealer hasn't knocked in yet, or all discard decisions are complete
        if (!dealer.hasKnockDecision) {
          // Dealer hasn't made knock decision yet
          this.startDealerDecisionPhase();
        } else {
          // All decisions complete, start trick-taking
          this.startTrickTakingPhase();
        }
      }
    }
  }

  private startDealerDecisionPhase() {
    this.log(`Starting dealer decision phase`);

    const dealer = this.state.players.get(this.state.dealerId);
    if (!dealer) {
      this.log(`Error: No dealer found`);
      this.endRound();
      return;
    }

    // Check if any non-dealers knocked in
    const nonDealersIn = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn && p.sessionId !== this.state.dealerId
    );

    if (nonDealersIn.length === 0) {
      // No non-dealers knocked in, so dealer doesn't get to play
      this.log(`No non-dealers knocked in - ending hand`);
      this.endRound();
      return;
    }

    // Now dealer gets to make knock decision
    this.state.roundState = 'knock-in';
    this.state.currentKnockPlayerId = this.state.dealerId;

    this.log(`Dealer's turn to knock`);
    this.setInactivitySkipTimeout();
  }

  private startTrickTakingPhase() {
    this.log(`Starting trick-taking phase`);
    this.state.roundState = 'turns';
    this.state.currentTrickNumber = 1;
    this.state.currentTrick.clear();
    this.state.completedTricks.clear();

    // First trick is led by first player to dealer's left
    const knockedInPlayers = [...this.state.players.values()]
      .filter((p) => p.ready && p.knockedIn)
      .map((p) => p.sessionId);
    const dealerIndex = knockedInPlayers.indexOf(this.state.dealerId);
    const firstPlayerIndex = (dealerIndex + 1) % knockedInPlayers.length;
    const firstPlayerId = knockedInPlayers[firstPlayerIndex];

    this.state.trickLeaderId = firstPlayerId;
    this.state.currentTurnPlayerId = firstPlayerId;

    this.log(`First trick led by player after dealer: ${firstPlayerId}`);

    this.roundPlayersIdIterator = this.makeKnockedInIterator();
    this.setInactivitySkipTimeout();
  }

  /** Iterator over players that knocked in */
  private *makeKnockedInIterator() {
    let players = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn
    );

    //Rotate players by offset
    players = players.concat(
      players.splice(0, this.roundIteratorOffset % players.length)
    );

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      //If grabbed player is not ready or didn't knock in, skip them
      if (!player.ready || !player.knockedIn) continue;

      //Otherwise yield the new player id
      yield player.sessionId;
    }
  }

  private turn() {
    // New turn, do not skip player from previous turn
    this.state.currentTurnTimeoutTimestamp = 0;
    this.inactivityTimeoutRef?.clear();

    // Get next player
    const nextPlayer = this.roundPlayersIdIterator.next();
    this.state.currentTurnPlayerId = nextPlayer.value || '';

    // If there are no more players, end current round
    if (nextPlayer.done) {
      this.endRound();
      return;
    }

    this.log('Turn', this.state.currentTurnPlayerId);

    //Skip round if player has blackjack
    if (this.state.players.get(this.state.currentTurnPlayerId).hand.isBlackjack)
      this.turn();
    else this.setInactivitySkipTimeout();
  }

  private setInactivitySkipTimeout() {
    this.state.currentTurnTimeoutTimestamp =
      Date.now() + gameConfig.inactivityTimeout;

    this.inactivityTimeoutRef?.clear();

    this.inactivityTimeoutRef = this.clock.setTimeout(() => {
      if (this.state.roundState === 'discard-draw') {
        this.log(
          'Inactivity timeout - auto keeping cards',
          this.state.currentDiscardPlayerId
        );
        // Auto-keep cards for inactive player during discard phase
        const player = this.state.players.get(
          this.state.currentDiscardPlayerId
        );
        if (player && !player.hasDiscardDecision) {
          player.hasDiscardDecision = true;
          player.cardsToDiscard = 0; // Keep all cards
        }
        this.startNextDiscardTurn();
      } else if (this.state.roundState === 'knock-in') {
        // ... existing knock-in timeout logic
      } else {
        // ... existing turn timeout logic
      }
    }, gameConfig.inactivityTimeout);
  }

  private async endRound() {
    this.log(`Starting end phase`);

    this.state.roundState = 'end';

    // TODO: SWICK scoring logic will be implemented in Step 5
    // For now, just end the hand and reset for next round

    // Delay before starting next phase
    await this.delay(
      gameConfig.roundStateEndTimeBase +
        this.state.players.size * gameConfig.roundStateEndTimePlayer
    );

    // Clear trick data for next hand
    this.state.currentTrick.clear();
    this.state.completedTricks.clear();
    this.state.currentTrickNumber = 1;
    this.state.trickLeaderId = '';

    // Clear trump data
    this.state.trumpSuit = '';
    this.state.trumpCard = undefined;
    this.state.potValue = 0;

    // Reset all players for next hand
    for (const player of this.state.players.values()) {
      player.hand.clear();
      player.ready = player.autoReady;
      player.roundOutcome = '';
      player.knockedIn = false;
      player.hasKnockDecision = false;
      player.hasDiscardDecision = false;
      player.dealerCompletedNormalDiscard = false;

      // Remove players that are still disconnected
      if (player.disconnected) this.deletePlayer(player.sessionId);
    }

    // Change starting player/dealer for next round
    this.roundIteratorOffset++;

    this.log(`Starting idle phase`);
    this.state.roundState = 'idle';
    this.triggerNewRoundCheck();
  }

  /**
   * Validates if a card play is legal according to SWICK rules
   */
  private isValidCardPlay(player: Player, cardToPlay: Card): boolean {
    const currentTrick = this.state.currentTrick;

    // Special rule: First player to dealer's left must lead with Ace of Trump if they have it
    if (currentTrick.length === 0 && this.state.currentTrickNumber === 1) {
      const isFirstPlayerAfterDealer = this.isFirstPlayerAfterDealer(
        player.sessionId
      );
      if (isFirstPlayerAfterDealer) {
        const hasAceOfTrump = player.hand.cards.some(
          (card) =>
            card.value?.value === 'A' &&
            card.value?.suit === this.state.trumpSuit
        );

        if (
          hasAceOfTrump &&
          !(
            cardToPlay.value?.value === 'A' &&
            cardToPlay.value?.suit === this.state.trumpSuit
          )
        ) {
          this.log(`Player must lead with Ace of Trump if they have it`);
          return false;
        }
      }
    }

    // If this is the first card of the trick, any card is valid (except the Ace of Trump rule above)
    if (currentTrick.length === 0) {
      return true;
    }

    // Get the suit that was led
    const leadSuit = currentTrick[0].card.value?.suit;
    const cardSuit = cardToPlay.value?.suit;

    // Check if player can follow suit
    const hasLeadSuit = player.hand.cards.some(
      (card) => card.value?.suit === leadSuit
    );

    if (hasLeadSuit) {
      // Player has the lead suit, so they must play it
      if (cardSuit !== leadSuit) {
        this.log(`Player must follow suit: ${leadSuit}`);
        return false;
      }

      // Check if player must beat the current highest card of the lead suit
      const highestLeadSuitCard = this.getHighestCardOfSuit(
        currentTrick,
        leadSuit
      );
      if (
        highestLeadSuitCard &&
        !this.cardBeats(cardToPlay, highestLeadSuitCard.card)
      ) {
        // Player must beat if they can
        const canBeat = player.hand.cards.some(
          (card) =>
            card.value?.suit === leadSuit &&
            this.cardBeats(card, highestLeadSuitCard.card)
        );

        if (canBeat) {
          this.log(`Player must beat the current highest card if possible`);
          return false;
        }
      }

      return true;
    } else {
      // Player doesn't have lead suit
      const hasTrump = player.hand.cards.some(
        (card) => card.value?.suit === this.state.trumpSuit
      );

      if (hasTrump && cardSuit !== this.state.trumpSuit) {
        this.log(`Player must trump if they can't follow suit`);
        return false;
      }

      // If they don't have trump either, they can play any card
      return true;
    }
  }

  /**
   * Plays a card and handles trick logic
   */
  private playCard(player: Player, cardToPlay: Card, cardIndex: number) {
    // Add card to current trick
    const playedCard = new PlayedCard(
      player.sessionId,
      cardToPlay,
      this.state.currentTrick.length
    );
    this.state.currentTrick.push(playedCard);

    // Remove card from player's hand
    player.hand.cards.splice(cardIndex, 1);

    this.log(
      `Card played: ${cardToPlay.value?.value} of ${cardToPlay.value?.suit} by ${player.displayName}`
    );

    // Check if trick is complete (all knocked-in players have played)
    const knockedInPlayers = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn
    );

    if (this.state.currentTrick.length === knockedInPlayers.length) {
      // Trick is complete - determine winner
      this.log(
        `Trick ${this.state.currentTrickNumber} complete with ${this.state.currentTrick.length} cards`
      );
      this.completeTrick();
    } else {
      // Move to next player in the trick
      this.nextPlayerInTrick();
    }
  }

  /**
   * Moves to the next player in the current trick
   */
  private nextPlayerInTrick() {
    const knockedInPlayers = [...this.state.players.values()]
      .filter((p) => p.ready && p.knockedIn)
      .map((p) => p.sessionId);

    // Find current player's position
    const currentPlayerIndex = knockedInPlayers.indexOf(
      this.state.currentTurnPlayerId
    );

    // Get next player (wrap around)
    const nextPlayerIndex = (currentPlayerIndex + 1) % knockedInPlayers.length;
    const nextPlayerId = knockedInPlayers[nextPlayerIndex];

    this.state.currentTurnPlayerId = nextPlayerId;

    this.log(`Next player in trick: ${nextPlayerId}`);
    this.setInactivitySkipTimeout();
  }

  /**
   * Completes the current trick and determines the winner
   */
  private async completeTrick() {
    const trickWinner = this.determineTrickWinner(this.state.currentTrick);
    if (!trickWinner) {
      this.log('Error: No trick winner determined');
      return;
    }

    this.log(
      `Trick ${this.state.currentTrickNumber} won by: ${
        trickWinner.playerId
      } (${this.state.players.get(trickWinner.playerId)?.displayName})`
    );

    // Create completed trick record BEFORE showing the message
    const completedTrick = new CompletedTrick(this.state.currentTrickNumber);
    completedTrick.playedCards.push(...this.state.currentTrick);
    completedTrick.winnerId = trickWinner.playerId;
    this.state.completedTricks.push(completedTrick);

    // Set the current trick winner for display purposes
    this.state.trickLeaderId = trickWinner.playerId; // Temporarily store winner here

    // PAUSE to show the completed trick and winner
    this.state.roundState = 'trick-complete';

    // Wait for 3 seconds to show the trick result
    await this.delay(3000);

    // Clear current trick
    this.state.currentTrick.clear();

    // Check if all tricks are complete
    if (this.state.currentTrickNumber >= 3) {
      // All tricks done - end the hand
      this.log(`All 3 tricks completed - ending hand`);
      this.endRound();
    } else {
      // Start next trick - winner leads
      this.state.currentTrickNumber++;
      this.state.currentTurnPlayerId = trickWinner.playerId;

      this.log(
        `Starting trick ${this.state.currentTrickNumber}, led by ${
          trickWinner.playerId
        } (${this.state.players.get(trickWinner.playerId)?.displayName})`
      );

      // Resume turns
      this.state.roundState = 'turns';
      this.setInactivitySkipTimeout();
    }
  }

  /**
   * Determines who wins a trick based on SWICK rules
   */
  private determineTrickWinner(trick: ArraySchema<PlayedCard>): PlayedCard {
    if (trick.length === 0) return null;

    const leadSuit = trick[0].card.value?.suit;
    let winner = trick[0];

    for (const playedCard of trick) {
      const card = playedCard.card;

      // Trump cards always beat non-trump cards
      if (
        card.value?.suit === this.state.trumpSuit &&
        winner.card.value?.suit !== this.state.trumpSuit
      ) {
        winner = playedCard;
      }
      // If both are trump, higher trump wins
      else if (
        card.value?.suit === this.state.trumpSuit &&
        winner.card.value?.suit === this.state.trumpSuit
      ) {
        if (this.cardBeats(card, winner.card)) {
          winner = playedCard;
        }
      }
      // If neither is trump, must be same suit as lead to win
      else if (
        card.value?.suit === leadSuit &&
        winner.card.value?.suit === leadSuit
      ) {
        if (this.cardBeats(card, winner.card)) {
          winner = playedCard;
        }
      }
    }

    return winner;
  }

  /**
   * Checks if card1 beats card2 based on SWICK card values
   */
  private cardBeats(card1: Card, card2: Card): boolean {
    const getValue = (value: string): number => {
      switch (value) {
        case 'A':
          return 14;
        case 'K':
          return 13;
        case 'Q':
          return 12;
        case 'J':
          return 11;
        case '10':
          return 10;
        case '9':
          return 9;
        case '8':
          return 8;
        case '7':
          return 7;
        default:
          return 0;
      }
    };

    return (
      getValue(card1.value?.value || '') > getValue(card2.value?.value || '')
    );
  }

  /**
   * Gets the highest card of a specific suit in the current trick
   */
  private getHighestCardOfSuit(
    trick: ArraySchema<PlayedCard>,
    suit: string
  ): PlayedCard | null {
    const suitCards = trick.filter((pc) => pc.card.value?.suit === suit);
    if (suitCards.length === 0) return null;

    let highest = suitCards[0];
    for (const playedCard of suitCards) {
      if (this.cardBeats(playedCard.card, highest.card)) {
        highest = playedCard;
      }
    }

    return highest;
  }

  /**
   * Checks if a player is the first player to the left of the dealer
   */
  private isFirstPlayerAfterDealer(playerId: string): boolean {
    const knockedInPlayers = [...this.state.players.values()]
      .filter((p) => p.ready && p.knockedIn)
      .map((p) => p.sessionId);

    const dealerIndex = knockedInPlayers.indexOf(this.state.dealerId);
    const firstPlayerIndex = (dealerIndex + 1) % knockedInPlayers.length;

    return knockedInPlayers[firstPlayerIndex] === playerId;
  }
}
