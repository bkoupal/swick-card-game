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
import { Suit, Value } from './schema/cardValues';

/**
 * Represents a special hand type with its priority
 */
interface SpecialHand {
  type: 'three-aces' | 'three-sevens' | 'akq-trump';
  priority: number; // Lower number = higher priority (1 is best)
  playerId: string;
  description: string;
}

interface GameSetup {
  totalPlayers: number;
  playerTypes: ('human' | 'bot')[];
  botDifficulty: 'easy' | 'medium' | 'hard';
  playerName: string;
}

export class GameRoom extends Room<GameState> {
  /** Current timeout skip reference */
  public inactivityTimeoutRef?: Delayed;
  public delayedRoundStartRef?: Delayed;
  public delayedRoomDeleteRef?: Delayed;

  /** Iterator for all players that are playing in the current round */
  private roundPlayersIdIterator: IterableIterator<string>;

  public autoDispose = false;
  private LOBBY_CHANNEL = 'GameRoom';

  private gameSetup?: GameSetup;
  private botPlayers: Set<string> = new Set(); // Track bot player IDs

  private log(msg: string, client?: Client | string) {
    if (process.env.ROOM_LOG_DISABLE == 'true') return;

    log.info(
      `Room ${this.roomId} ${
        client ? 'Client ' + ((<any>client).sessionId || client) : ''
      }`,
      msg
    );
  }

  private async endRoundWithoutTricks() {
    this.log(`Ending round without trick-taking`);
    this.state.roundState = 'end';

    // Don't call calculateGoingSet() - we already handled the going set logic above

    // Delay before starting next phase
    const baseDelay =
      gameConfig.roundStateEndTimeBase +
      this.state.players.size * gameConfig.roundStateEndTimePlayer;

    const hasGoingSetResults = [...this.state.players.values()].some(
      (p) => p.wentSet
    );
    const extraDelayForGoingSet = hasGoingSetResults ? 3000 : 0;

    await this.delay(baseDelay + extraDelayForGoingSet);

    // Clear trick data for next hand
    this.state.currentTrick.clear();
    this.state.completedTricks.clear();
    this.state.currentTrickNumber = 1;
    this.state.trickLeaderId = '';

    // Clear trump data
    this.state.trumpSuit = '';
    this.state.trumpCard = undefined;
    this.state.potValue = 0;

    // Clear ante data
    this.state.dealerHasSetAnte = false;

    // Reset all players for next hand
    for (const player of this.state.players.values()) {
      player.hand.clear();
      player.ready = player.autoReady;
      player.roundOutcome = '';
      player.knockedIn = false;
      player.hasKnockDecision = false;
      player.hasDiscardDecision = false;
      player.dealerCompletedNormalDiscard = false;

      // Clear card selections
      player.selectedCards.clear();
      for (const card of player.hand.cards) {
        card.selected = false;
      }

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
   * Checks if a client is an admin
   */
  private isAdmin(sessionId: string): boolean {
    const player = this.state.players.get(sessionId);
    return player?.admin || false;
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

  async onCreate(options: any) {
    this.roomId = await this.registerRoomId();
    if (!options.isPublic) {
      this.setPrivate();
    }
    this.setState(new GameState({}));
    this.clock.start();

    this.log('Room created');

    this.state.roomMetadata.roomName =
      options?.roomName || `SWICK Game ${this.roomId}`;
    this.state.roomMetadata.isPublic = options?.isPublic !== false;
    this.state.roomMetadata.maxPlayers = options?.maxPlayers || 6;
    this.maxClients = this.state.roomMetadata.maxPlayers;

    this.updateRoomMetadata();

    // Enable lobby listing
    this.setMetadata({
      roomName: this.state.roomMetadata.roomName,
      isPublic: this.state.roomMetadata.isPublic,
      allowJoining: this.state.roomMetadata.allowJoining,
      currentPlayers: this.state.roomMetadata.currentPlayers,
      readyPlayers: this.state.roomMetadata.readyPlayers,
      potValue: this.state.roomMetadata.potValue,
      gameStatus: this.state.roomMetadata.gameStatus,
      dealerName: this.state.roomMetadata.dealerName,
      hasActiveSet: this.state.roomMetadata.hasActiveSet,
      maxClients: this.state.roomMetadata.maxPlayers,
    });

    //Send ping messages to all clients
    this.clock.setInterval(() => {
      this.broadcast('ping');
    }, gameConfig.pingInterval);

    // Client message listeners:

    this.onMessage('ready', (client, state: boolean) => {
      if (this.state.roundState != 'idle' || typeof state != 'boolean') return;

      const player = this.state.players.get(client.sessionId);

      // If dealer is becoming ready and there's a going set bonus, auto-set ante
      if (state && client.sessionId === this.state.dealerId) {
        if (this.state.nextRoundPotBonus > 0) {
          // Going set bonus active - ante is automatically 3¢
          for (const p of this.state.players.values()) {
            p.bet = 3; // Fixed ante when players went set
          }
          this.log(
            `Dealer ante automatically set to 3¢ (going set bonus: ${this.state.nextRoundPotBonus}¢)`
          );
        }
        this.state.dealerHasSetAnte = true;
        this.log(`Dealer confirmed ante at ${player.bet}¢`);
      }

      // Prevent non-dealers from becoming ready if dealer hasn't set ante yet
      if (state && client.sessionId !== this.state.dealerId) {
        if (!this.state.dealerHasSetAnte) {
          this.log(
            `${player.displayName} cannot ready - dealer must set ante first`
          );
          return;
        }
      }

      this.log(`Ready state change: ${state}`, client);
      player.ready = state;
      this.triggerNewRoundCheck();
      this.updateRoomMetadata();
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
        this.state.roundState != 'idle' ||
        this.state.players.get(client.sessionId).ready ||
        !Number.isInteger(newBet)
      )
        return;

      // SWICK ante validation - must be 3, 6, 9, 12, or 15
      const allowedAntes = [3, 6, 9, 12, 15];
      if (!allowedAntes.includes(newBet)) {
        this.log(`Invalid ante amount: ${newBet}`);
        return;
      }

      const player = this.state.players.get(client.sessionId);

      // Only dealers can set ante for everyone
      if (client.sessionId !== this.state.dealerId) {
        this.log(`Non-dealer ${player.displayName} attempted to set ante`);
        return;
      }

      this.log(`Dealer ${player.displayName} setting ante to ${newBet}¢`);

      // Set ante for all players
      for (const p of this.state.players.values()) {
        p.bet = newBet;
      }

      // Mark that dealer has made ante decision
      this.state.dealerHasSetAnte = true;

      this.log(`Ante set to ${newBet}¢ for all players`);
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

    this.onMessage('changeName', (client, newName: string) => {
      // Only allow name changes during idle state
      if (
        this.state.roundState !== 'idle' ||
        !newName ||
        typeof newName !== 'string'
      ) {
        this.log(`Name change rejected - invalid state or name`, client);
        return;
      }

      const player = this.state.players.get(client.sessionId);
      if (!player) return;

      const sanitizedName = newName.trim().substring(0, 20);

      if (sanitizedName && sanitizedName !== player.displayName) {
        this.log(
          `${player.displayName} changed name to ${sanitizedName}`,
          client
        );
        player.displayName = sanitizedName;
      } else {
        this.log(`Name change rejected - same name or empty`, client);
      }
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

          // TRACK THAT DEALER KEPT TRUMP
          this.state.dealerKeptTrump = true;
          this.state.dealerTrumpValue = this.state.trumpCard.value!.value;

          this.log(
            `Dealer kept trump: ${this.state.dealerTrumpValue} of ${this.state.trumpSuit}`
          );
        }
      } else {
        // Dealer discarded trump
        this.state.dealerKeptTrump = false;
        this.state.dealerTrumpValue = '';
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
          // DEALER PASSED - Handle going set logic immediately
          this.log(`Dealer passed during knock-in - dealer goes set single`);

          // Dealer goes set single (always single when choosing not to play during knock-in)
          player.wentSet = true;
          player.setType = 'single';
          player.setAmount = this.state.potValue;
          player.money -= player.setAmount;

          this.log(
            `Dealer goes set SINGLE - owes ${player.setAmount}¢ (now has ${player.money}¢)`
          );

          // Ensure dealer doesn't go below 0 money
          if (player.money < 0) {
            this.log(`Dealer went below 0, setting to 0`);
            player.money = 0;
          }

          // Add dealer's set amount to next round bonus
          this.state.nextRoundPotBonus += player.setAmount;

          // Check remaining knocked-in players
          const remainingPlayers = [...this.state.players.values()].filter(
            (p) => p.ready && p.knockedIn
          );

          if (remainingPlayers.length === 0) {
            // No players left - end the round
            this.log(`No players left after dealer went set - ending hand`);
            this.endRoundWithoutTricks();
          } else if (remainingPlayers.length === 1) {
            // Only 1 player left - they win all 3 tricks automatically
            this.log(
              `Only 1 player left (${remainingPlayers[0].displayName}) - wins all tricks automatically`
            );

            const winner = remainingPlayers[0];
            winner.tricksWon = 3; // Wins all 3 tricks
            winner.money += this.state.potValue; // Gets entire pot
            winner.roundOutcome = 'win';

            this.log(
              `${winner.displayName} wins entire pot of ${this.state.potValue}¢ automatically`
            );

            this.endRoundWithoutTricks();
          } else {
            // 2+ players left - proceed to trick-taking phase
            this.log(
              `${remainingPlayers.length} players remaining - proceeding to trick-taking`
            );
            this.startTrickTakingPhase();
          }
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

      // SPECIAL CASE: Dealer with trump card has 4 cards
      if (
        client.sessionId === this.state.dealerId &&
        player.hand.cards.length > 3
      ) {
        this.log(
          `Dealer has ${player.hand.cards.length} cards - must discard 1 card (not trump) before playing`
        );
        // Force dealer into final discard mode
        player.dealerCompletedNormalDiscard = true;
        player.hasDiscardDecision = false;

        // Clear selections and stay in discard phase
        for (const card of player.hand.cards) {
          card.selected = false;
        }
        this.setInactivitySkipTimeout();
        return;
      }

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

        // NOW ALL DISCARD/DRAW IS COMPLETE - CHECK FOR SPECIAL HANDS
        this.log('Dealer completed final discard - all discard/draw complete');
        this.startTrickTakingPhase(); // This will check special hands at the right time
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

    this.onMessage('admin-check-special-hands', (client) => {
      if (!this.isAdmin(client.sessionId)) return;

      const specialHands = this.checkForSpecialHands();
      this.log(`Found ${specialHands.length} special hands:`);
      specialHands.forEach((hand) => {
        this.log(`  ${hand.description} (Priority: ${hand.priority})`);
      });
    });

    this.onMessage('admin-create-special-hand', (client, data: any) => {
      if (!this.isAdmin(client.sessionId)) return;

      const { playerId, handType } = data;
      this.createTestSpecialHand(
        playerId,
        handType as 'three-aces' | 'three-sevens' | 'akq-trump'
      );
      this.log(`Admin ${client.sessionId} created ${handType} for ${playerId}`);
    });

    this.onMessage('admin-test-special-hands', (client) => {
      if (!this.isAdmin(client.sessionId)) return;

      const knockedInPlayers = [...this.state.players.values()]
        .filter((p) => p.ready && p.knockedIn)
        .map((p) => p.sessionId);

      if (knockedInPlayers.length >= 3) {
        this.createTestSpecialHand(knockedInPlayers[0], 'three-aces');
        this.createTestSpecialHand(knockedInPlayers[1], 'three-sevens');
        if (knockedInPlayers.length > 2) {
          this.createTestSpecialHand(knockedInPlayers[2], 'akq-trump');
        }
        this.log('Admin created test special hands for multiple players');
      }
    });

    // Admin bot management commands
    this.onMessage(
      'admin-create-bot',
      (client, difficulty: 'easy' | 'medium' | 'hard') => {
        if (!this.isAdmin(client.sessionId)) return;

        // Create a simple test bot using existing createBot method but with random number
        const botId = this.createBot(Math.floor(Math.random() * 999) + 1);
        this.log(`Admin created ${difficulty} bot`);
      }
    );

    this.onMessage('admin-list-bots', (client) => {
      if (!this.isAdmin(client.sessionId)) return;

      const bots = [...this.state.players.values()].filter((p) => p.isBot);
      this.log(
        `Active bots: ${bots
          .map((b) => `${b.displayName} (${b.botDifficulty})`)
          .join(', ')}`
      );
    });

    this.onMessage('dealerGoSet', (client, goSet: boolean) => {
      if (this.state.roundState != 'discard-draw' || typeof goSet != 'boolean')
        return;

      const player = this.state.players.get(client.sessionId);
      if (!player || client.sessionId !== this.state.dealerId) return;

      this.log(`Dealer chooses to go set: ${goSet}`, client);

      if (goSet) {
        // Dealer chooses to go set - they pass but pay SINGLE penalty (always single when choosing not to play)
        player.knockedIn = false; // Dealer is no longer in the hand
        player.hasKnockDecision = true; // Mark decision as made
        player.ready = false; // Remove from round

        // Dealer who chooses not to play ALWAYS goes set single (regardless of trump value)
        player.wentSet = true;
        player.setType = 'single';
        player.setAmount = this.state.potValue;
        player.money -= player.setAmount; // Subtract immediately

        this.log(
          `Dealer chose not to play - goes set SINGLE - owes ${player.setAmount}¢ (now has ${player.money}¢)`
        );

        // Ensure player doesn't go below 0 money
        if (player.money < 0) {
          this.log(`Dealer went below 0, setting to 0`);
          player.money = 0;
        }

        // Add to next round pot bonus
        this.state.nextRoundPotBonus += player.setAmount;

        // Check if there are any other players left in the hand
        const remainingPlayers = [...this.state.players.values()].filter(
          (p) => p.ready && p.knockedIn
        );

        if (remainingPlayers.length === 0) {
          // No players left - end the round
          this.log(`No players left after dealer went set - ending hand`);
          this.endRoundWithoutTricks();
        } else {
          // Continue with remaining players - proceed to trick-taking phase
          this.log(
            `${remainingPlayers.length} players remaining - starting trick-taking`
          );
          this.startTrickTakingPhase();
        }
      }
      // If goSet is false, this message shouldn't be sent, but just ignore it
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

  onJoin(client: Client, options: any) {
    // Check both current players and maxPlayers limit
    const currentPlayerCount = this.state.players.size;
    const maxPlayersAllowed = this.state.roomMetadata.maxPlayers;

    // Check if joining is allowed
    if (!this.state.roomMetadata.allowJoining) {
      throw new Error('Cannot join: Game in progress or has active set');
    }

    // Enforce maxPlayers limit properly
    if (currentPlayerCount >= maxPlayersAllowed) {
      throw new Error(
        `Room is full (${currentPlayerCount}/${maxPlayersAllowed} players)`
      );
    }

    this.log(
      `Join - Current: ${currentPlayerCount}/${maxPlayersAllowed}`,
      client
    );

    // Store game setup from room creator
    if (options?.gameSetup && !this.gameSetup) {
      this.gameSetup = options.gameSetup;
      this.log(
        `Game setup: ${
          this.gameSetup.totalPlayers
        } players, ${this.getBotCount()} bots`
      );
    }

    // Use provided player name or generate random one
    let playerName: string;
    if (options?.playerName && options.playerName.trim()) {
      playerName = options.playerName.trim().substring(0, 20);
    } else {
      playerName = this.generateRandomName();
    }

    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: playerName,
        admin: this.state.players.size == 0,
      })
    );

    this.log(`Player joined as: ${playerName}`);

    // Create bots if this is the first human player and we have game setup
    if (this.state.players.size === 1 && this.gameSetup) {
      this.createBots();
    }

    this.triggerRoomDeleteCheck();
    this.triggerNewRoundCheck();

    this.setMetadata({
      roomName: this.state.roomMetadata.roomName,
      isPublic: this.state.roomMetadata.isPublic,
      allowJoining: this.state.roomMetadata.allowJoining,
      currentPlayers: this.state.roomMetadata.currentPlayers,
      readyPlayers: this.state.roomMetadata.readyPlayers,
      potValue: this.state.roomMetadata.potValue,
      gameStatus: this.state.roomMetadata.gameStatus,
      dealerName: this.state.roomMetadata.dealerName,
      hasActiveSet: this.state.roomMetadata.hasActiveSet,
      maxClients: this.state.roomMetadata.maxPlayers,
    });

    this.updateRoomMetadata();
  }

  private createBots(): void {
    if (!this.gameSetup) return;

    const botCount = this.getBotCount();
    this.log(
      `Creating ${botCount} bots with ${this.gameSetup.botDifficulty} difficulty`
    );

    for (let i = 0; i < botCount; i++) {
      this.createBot(i + 1);
    }
  }

  private handleDealerPassing(dealer: Player) {
    this.log(`Dealer passed - checking remaining players`);

    // Dealer goes set single (always single when choosing not to play during knock-in)
    dealer.wentSet = true;
    dealer.setType = 'single';
    dealer.setAmount = this.state.potValue;
    dealer.money -= dealer.setAmount;
    dealer.ready = false; // Remove dealer from round

    this.log(
      `Dealer goes set SINGLE - owes ${dealer.setAmount}¢ (now has ${dealer.money}¢)`
    );

    // Ensure dealer doesn't go below 0 money
    if (dealer.money < 0) {
      this.log(`Dealer went below 0, setting to 0`);
      dealer.money = 0;
    }

    // Add to next round pot bonus
    this.state.nextRoundPotBonus += dealer.setAmount;

    // ✅ KEY FIX: Check if there are remaining players who should auto-win
    const remainingPlayers = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn
    );

    this.log(
      `Remaining players after dealer passed: ${remainingPlayers.length}`
    );

    if (remainingPlayers.length === 0) {
      // No players left - end the round normally
      this.log(`No players left after dealer passed - ending hand`);
      this.endRoundWithoutTricks();
    } else if (remainingPlayers.length === 1) {
      // ✅ SINGLE PLAYER AUTO-WIN: Award all tricks to the remaining player
      const winnerPlayer = remainingPlayers[0];
      this.log(
        `Single player remaining: ${winnerPlayer.displayName} wins all tricks automatically`
      );

      // Award all 3 tricks to the winner
      winnerPlayer.tricksWon = 3;

      // Calculate winnings (full pot)
      const fullPot = this.state.potValue;
      winnerPlayer.money += fullPot;

      this.log(
        `${winnerPlayer.displayName} wins full pot of ${fullPot}¢ (now has ${winnerPlayer.money}¢)`
      );

      // Broadcast the auto-win to all players
      this.broadcast('singlePlayerAutoWin', {
        winnerId: winnerPlayer.sessionId,
        winnerName: winnerPlayer.displayName,
        potAmount: fullPot,
      });

      // End the round - going set calculation will now be correct
      this.endRoundWithoutTricks();
    } else {
      // Multiple players remaining - continue with normal discard/draw and trick-taking
      this.log(
        `${remainingPlayers.length} players remaining - continuing game`
      );
      this.startDiscardDrawPhase();
    }
  }

  private createBot(botNumber: number): void {
    if (!this.gameSetup) return;

    // Generate a unique bot session ID
    const botSessionId = `bot_${botNumber}_${Date.now()}`;

    // Generate bot name based on difficulty
    const botName = this.generateBotName(
      botNumber,
      this.gameSetup.botDifficulty
    );

    // Create bot player
    const botPlayer = new Player({
      sessionId: botSessionId,
      displayName: botName,
      admin: false,
    });

    // Mark as bot
    botPlayer.isBot = true;
    botPlayer.botDifficulty = this.gameSetup.botDifficulty;

    this.state.players.set(botSessionId, botPlayer);
    this.botPlayers.add(botSessionId);

    this.log(`Created bot: ${botName} (${this.gameSetup.botDifficulty})`);
  }

  private getBotCount(): number {
    if (!this.gameSetup) return 0;
    return this.gameSetup.playerTypes.filter((type) => type === 'bot').length;
  }

  private generateBotName(botNumber: number, difficulty: string): string {
    const easyNames = ['SimpleBot', 'BasicBot', 'NewbieBot', 'LearnerBot'];
    const mediumNames = ['CleverBot', 'SmartBot', 'TacticBot', 'StrategyBot'];
    const hardNames = ['MasterBot', 'ProBot', 'ExpertBot', 'GeniusBot'];

    let namePool: string[];
    switch (difficulty) {
      case 'easy':
        namePool = easyNames;
        break;
      case 'medium':
        namePool = mediumNames;
        break;
      case 'hard':
        namePool = hardNames;
        break;
      default:
        namePool = easyNames;
    }

    const baseName = namePool[Math.floor(Math.random() * namePool.length)];
    return `${baseName}${botNumber}`;
  }

  /**
   * Generates a random player name for players who don't provide one
   */
  private generateRandomName(): string {
    const randomNames = [
      'CardShark',
      'LuckyAce',
      'TrumpMaster',
      'SwiftPlayer',
      'DealerKing',
      'ClubCrusher',
      'HeartBreaker',
      'SpadeSeeker',
      'DiamondDave',
      'PokerFace',
      'RoyalFlush',
      'WildCard',
      'HighRoller',
      'BluffMaster',
      'AceHunter',
      'CardCounting',
      'AllInPlayer',
      'FastDeal',
      'TrickTaker',
      'SwiftSwick',
    ];

    const randomIndex = Math.floor(Math.random() * randomNames.length);
    const baseName = randomNames[randomIndex];
    const randomNumber = Math.floor(Math.random() * 999) + 1;

    return `${baseName}${randomNumber}`;
  }

  async onLeave(client: Client, consented: boolean) {
    this.log(`Leave`, client);

    // Handle bot cleanup differently
    if (this.botPlayers.has(client.sessionId)) {
      this.botPlayers.delete(client.sessionId);
      this.deletePlayer(client.sessionId);
      return;
    }

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

    this.setMetadata({
      roomName: this.state.roomMetadata.roomName,
      isPublic: this.state.roomMetadata.isPublic,
      allowJoining: this.state.roomMetadata.allowJoining,
      currentPlayers: this.state.roomMetadata.currentPlayers,
      readyPlayers: this.state.roomMetadata.readyPlayers,
      potValue: this.state.roomMetadata.potValue,
      gameStatus: this.state.roomMetadata.gameStatus,
      dealerName: this.state.roomMetadata.dealerName,
      hasActiveSet: this.state.roomMetadata.hasActiveSet,
    });

    this.updateRoomMetadata();
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

    // ASSIGN DEALER EARLY (during idle state) so ante setting works
    if (playerArr.length >= gameConfig.minPlayers) {
      const dealerIndex = this.roundIteratorOffset % playerArr.length;
      this.state.dealerId = playerArr[dealerIndex].sessionId;
      this.log(
        `Dealer assigned during idle: ${playerArr[dealerIndex].displayName}`
      );
    }

    // Get current dealer
    const dealer = this.state.players.get(this.state.dealerId);

    // HANDLE BOT DEALER ANTE SETTING FIRST
    if (dealer?.isBot && !this.state.dealerHasSetAnte) {
      this.clock.setTimeout(() => {
        if (this.state.roundState === 'idle' && !this.state.dealerHasSetAnte) {
          // Check if there's a going set bonus (players went set last round)
          if (this.state.nextRoundPotBonus > 0) {
            // Going set bonus active - ante is automatically 3¢, no choice
            for (const p of this.state.players.values()) {
              p.bet = 3; // Fixed ante when players went set
            }
            this.state.dealerHasSetAnte = true;
            this.log(
              `Bot dealer ${dealer.displayName} - ante fixed at 3¢ (going set bonus active)`
            );
          } else {
            // Normal round - bot dealer auto-sets ante to 3¢ (default)
            for (const p of this.state.players.values()) {
              p.bet = 3;
            }
            this.state.dealerHasSetAnte = true;
            this.log(`Bot dealer ${dealer.displayName} auto-set ante to 3¢`);
          }
          this.triggerNewRoundCheck(); // Re-check after setting ante
        }
      }, 1000);
      return;
    }

    // NOW HANDLE BOT AUTO-READY (after ante is set)
    for (const player of playerArr) {
      if (player.isBot && !player.ready && !player.disconnected) {
        // Only ready bots if dealer has set ante (or if this bot IS the dealer and ante is set)
        if (
          this.state.dealerHasSetAnte ||
          player.sessionId === this.state.dealerId
        ) {
          this.clock.setTimeout(() => {
            if (player && !player.ready && this.state.roundState === 'idle') {
              player.ready = true;
              player.autoReady = true;
              this.log(`${player.displayName} (bot) auto-readied`);
              this.triggerNewRoundCheck(); // Recursive check
            }
          }, 500 + Math.random() * 1500);
        }
      }
    }

    // Check if we can start the round
    if (
      playerArr.length < gameConfig.minPlayers ||
      playerArr.some((p) => !p.ready) ||
      !this.state.dealerHasSetAnte
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

    this.updateRoomMetadata();

    // Reset and shuffle the deck before each hand (SWICK rule)
    this.state.deck.reset();

    // RESET GOING SET FIELDS FOR NEW ROUND
    this.state.dealerKeptTrump = false;
    this.state.dealerTrumpValue = '';
    // Don't reset nextRoundPotBonus here - it's used for current round pot

    // Reset player states for new hand
    for (const player of this.state.players.values()) {
      if (player.ready) {
        player.knockedIn = false;
        player.hasKnockDecision = false;
        player.hasDiscardDecision = false;
        player.roundOutcome = '';
        player.dealerCompletedNormalDiscard = false;

        // Clear card selections
        player.selectedCards.clear();
        for (const card of player.hand.cards) {
          card.selected = false;
        }

        // RESET GOING SET TRACKING
        player.tricksWon = 0;
        player.wentSet = false;
        player.setAmount = 0;
        player.setType = '';
      }
    }

    // Dealer is already assigned in triggerNewRoundCheck()
    this.log(
      `Dealer is: ${this.state.players.get(this.state.dealerId).displayName}`
    );
    this.log(
      `Deck shuffled. Cards remaining: ${this.state.deck.remainingCards}`
    );

    // REPLACE the ante collection with this SWICK-correct logic:
    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      // SWICK Rule: Only dealer pays ante if players went set last round
      const shouldPayAnte =
        this.state.nextRoundPotBonus > 0
          ? playerId === this.state.dealerId // Only dealer pays if someone went set
          : true; // Everyone pays if no one went set

      if (shouldPayAnte) {
        let anteAmount;
        if (playerId === this.state.dealerId) {
          if (this.state.nextRoundPotBonus > 0) {
            // When players went set, dealer only pays extra ante (3¢)
            anteAmount = gameConfig.dealerExtraAnte;
          } else {
            // Normal round, dealer pays base + extra (6¢ total)
            anteAmount = player.bet + gameConfig.dealerExtraAnte;
          }
        } else {
          // Non-dealers always pay base ante when they pay
          anteAmount = player.bet;
        }

        player.money -= anteAmount;
        this.state.potValue += anteAmount;
        this.log(`${player.displayName} antes ${anteAmount}¢`);
      } else {
        this.log(
          `${player.displayName} gets free ride (players went set last round)`
        );
      }

      //Deal player 3 cards from the deck (SWICK rule)
      player.hand.clear();
      player.hand.addCardFromDeck(this.state.deck, true); // Card 1
      player.hand.addCardFromDeck(this.state.deck, true); // Card 2
      player.hand.addCardFromDeck(this.state.deck, true); // Card 3
    }

    // ADD POT BONUS FROM PREVIOUS ROUND GOING SET
    if (this.state.nextRoundPotBonus > 0) {
      this.log(
        `Adding ${this.state.nextRoundPotBonus}¢ to pot from players who went set last round`
      );
      this.state.potValue += this.state.nextRoundPotBonus;
      this.state.nextRoundPotBonus = 0; // Clear the bonus after using it
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
    this.updateRoomMetadata();
  }

  private startTrumpSelectionPhase() {
    this.log(`Starting trump selection phase`);
    this.state.roundState = 'trump-selection';

    // Clear dealer hand from previous games
    this.state.dealerHand.clear();

    // Dealer has time to decide whether to keep trump card
    this.setInactivitySkipTimeout();

    // Update lobby status for trump selection:
    this.updateRoomMetadata();

    // Trigger bot decisions if next player is a bot
    this.triggerBotDecisions();
  }

  private startKnockInPhase() {
    this.log(`Starting knock-in phase`);
    this.state.roundState = 'knock-in';
    this.state.currentTurnTimeoutTimestamp = 0;
    this.inactivityTimeoutRef?.clear();

    this.log(`Trump suit is: ${this.state.trumpSuit}`);

    // Update lobby status for knock-in phase:
    this.updateRoomMetadata();

    // Start with first non-dealer player in order they joined
    this.startNextKnockTurn();
  }

  private startNextKnockTurn() {
    // Get NON-DEALER players in CLOCKWISE order from dealer's left
    const nonDealersClockwise = this.getNonDealersInClockwiseOrder();

    // Find next non-dealer who hasn't made decision yet (maintaining clockwise order)
    const nextPlayer = nonDealersClockwise.find((p) => !p.hasKnockDecision);

    if (nextPlayer) {
      this.state.currentKnockPlayerId = nextPlayer.sessionId;
      this.log(
        `It's ${nextPlayer.displayName}'s turn to knock (clockwise order)`
      );
      this.setInactivitySkipTimeout();

      // Trigger bot decisions if next player is a bot
      this.triggerBotDecisions();
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
    const nonDealersIn = nonDealers.filter((p) => p.knockedIn);

    this.log(`Non-dealer players knocked in: ${nonDealersIn.length}`);

    if (nonDealersIn.length === 0) {
      // ✅ No non-dealers knocked in - DEALER WINS AUTOMATICALLY
      this.log(`No non-dealers knocked in - dealer wins automatically`);
      this.handleDealerAutoWin();
      return;
    }

    // ✅ FIX: Some non-dealers knocked in, START DISCARD/DRAW PHASE FIRST
    // Don't immediately ask dealer to knock - let non-dealers discard/draw first
    this.log(
      `${nonDealersIn.length} non-dealers knocked in - starting discard/draw phase`
    );
    this.startDiscardDrawPhase();
  }

  // Handle dealer automatic win when all players pass
  private handleDealerAutoWin() {
    this.log(
      `Everyone passed - dealer wins entire pot of ${this.state.potValue}¢`
    );

    const dealer = this.state.players.get(this.state.dealerId);
    if (!dealer) {
      this.log(`Error: No dealer found`);
      this.endRound();
      return;
    }

    // Dealer automatically wins the entire pot
    dealer.knockedIn = true;
    dealer.hasKnockDecision = true;
    dealer.tricksWon = 3; // Award all 3 tricks symbolically
    dealer.roundOutcome = 'win';

    this.log(
      `Dealer ${dealer.displayName} wins ${this.state.potValue}¢ - everyone passed`
    );

    // Broadcast special message to all players
    this.broadcast('everyonePassed', {
      dealerName: dealer.displayName,
      potValue: this.state.potValue,
      message: `Everyone passed. ${dealer.displayName} wins the pot!`,
    });

    // Set a special round outcome for the end screen
    this.state.specialRoundOutcome = 'dealer-auto-win';
    this.state.specialRoundMessage = `Everyone passed. ${dealer.displayName} wins ${this.state.potValue}¢!`;

    // End the round immediately
    this.endRound();
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
        // ✅ FIXED: Nobody knocked in - dealer wins automatically
        this.log(`No players knocked in - dealer wins automatically`);
        this.handleDealerAutoWin();
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

    // Update lobby status for discard-draw phase:
    this.updateRoomMetadata();

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

    // Trigger bot decisions if next player is a bot
    this.triggerBotDecisions();
  }

  private startNextDiscardTurn() {
    // Get NON-DEALER knocked-in players in CLOCKWISE order from dealer's left
    const nonDealersClockwise = this.getNonDealersInClockwiseOrder();
    const knockedInNonDealersClockwise = nonDealersClockwise.filter(
      (p) => p.knockedIn
    );

    // Find next non-dealer who hasn't made discard decision yet (maintaining clockwise order)
    const nextPlayer = knockedInNonDealersClockwise.find(
      (p) => !p.hasDiscardDecision
    );

    if (nextPlayer) {
      this.state.currentDiscardPlayerId = nextPlayer.sessionId;
      this.log(
        `It's ${nextPlayer.displayName}'s turn to discard/draw (clockwise order)`
      );
      this.setInactivitySkipTimeout();

      // Trigger bot decisions if next player is a bot
      this.triggerBotDecisions();
    } else {
      // ✅ FIX: All non-dealers have made discard decisions
      // NOW we ask the dealer to make their knock decision
      this.state.currentDiscardPlayerId = '';

      const dealer = this.state.players.get(this.state.dealerId);
      if (!dealer) {
        this.log(`Error: No dealer found`);
        this.endRound();
        return;
      }

      // Check if dealer has already made knock decision
      if (!dealer.hasKnockDecision) {
        // ✅ FIX: Now ask dealer to knock in (after non-dealers finished discard/draw)
        this.log(
          `Non-dealers finished discard/draw - now dealer's turn to knock`
        );
        this.state.roundState = 'knock-in';
        this.state.currentKnockPlayerId = this.state.dealerId;
        this.setInactivitySkipTimeout();

        // Trigger bot decisions if dealer is a bot
        this.triggerBotDecisions();
      } else {
        // Dealer already made knock decision, check if they knocked in
        if (dealer.knockedIn && !dealer.hasDiscardDecision) {
          // Dealer knocked in but hasn't made discard decision yet
          this.log(`Dealer's turn to discard/draw`);
          this.state.currentDiscardPlayerId = this.state.dealerId;
          this.setInactivitySkipTimeout();

          // Trigger bot decisions if dealer is a bot
          this.triggerBotDecisions();
        } else {
          // All decisions complete, start trick-taking
          this.log(
            `All discard decisions complete - starting trick-taking phase`
          );
          this.startTrickTakingPhase();
        }
      }
    }
  }

  /**
   * Gets non-dealer players in clockwise order starting from dealer's left
   */
  private getNonDealersInClockwiseOrder(): Player[] {
    // Get all ready players
    const allPlayers = [...this.state.players.values()].filter((p) => p.ready);

    // Find dealer's position in the array
    const dealerIndex = allPlayers.findIndex(
      (p) => p.sessionId === this.state.dealerId
    );

    if (dealerIndex === -1) {
      this.log(`Error: Dealer not found in ready players`);
      return [];
    }

    // Create clockwise order starting from dealer's left
    const clockwiseOrder = [];
    for (let i = 1; i < allPlayers.length; i++) {
      const playerIndex = (dealerIndex + i) % allPlayers.length;
      clockwiseOrder.push(allPlayers[playerIndex]);
    }

    this.log(
      `Clockwise order from dealer's left: ${clockwiseOrder
        .map((p) => p.displayName)
        .join(' -> ')}`
    );

    return clockwiseOrder;
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

    // Trigger bot decisions if next player is a bot
    this.triggerBotDecisions();
  }

  private async startTrickTakingPhase() {
    this.log(`Checking for special hands before starting trick-taking...`);

    // Check for special hands after all discard/draw is complete
    const specialHands = this.checkForSpecialHands();

    if (specialHands.length > 0) {
      // Special hand detected - handle the win
      await this.handleSpecialHandWin(specialHands);
      return; // Don't proceed to trick-taking
    }

    // No special hands - proceed with normal trick-taking
    this.log(`No special hands detected - starting normal trick-taking phase`);
    this.state.roundState = 'turns';

    // Update lobby status for turns phase:
    this.updateRoomMetadata();

    // Initialize first trick
    this.state.currentTrick.clear();
    this.state.currentTrickNumber = 1;

    // First player to dealer's left leads first trick
    const knockedInPlayers = [...this.state.players.values()]
      .filter((p) => p.ready && p.knockedIn)
      .map((p) => p.sessionId);

    const dealerIndex = knockedInPlayers.indexOf(this.state.dealerId);
    const firstPlayerIndex = (dealerIndex + 1) % knockedInPlayers.length;
    this.state.trickLeaderId = knockedInPlayers[firstPlayerIndex];

    this.log(
      `${
        this.state.players.get(this.state.trickLeaderId)?.displayName
      } leads the first trick`
    );

    // Set up the round iterator for trick-taking
    this.roundPlayersIdIterator = this.makeKnockedInIterator();
    this.state.currentTurnPlayerId = this.state.trickLeaderId;

    this.setInactivitySkipTimeout();

    this.triggerBotDecisions();

    this.updateRoomMetadata();
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

    // CALCULATE GOING SET AND AWARD WINNINGS
    this.calculateGoingSet();
    this.awardTrickWinnings();

    // TODO: SWICK scoring logic will be implemented in Step 5
    // For now, just end the hand and reset for next round

    // Delay before starting next phase - extra time if players went set
    const baseDelay =
      gameConfig.roundStateEndTimeBase +
      this.state.players.size * gameConfig.roundStateEndTimePlayer;

    const hasGoingSetResults = [...this.state.players.values()].some(
      (p) => p.wentSet
    );
    const extraDelayForGoingSet = hasGoingSetResults ? 3000 : 0; // Extra 3 seconds

    await this.delay(baseDelay + extraDelayForGoingSet);

    // Clear trick data for next hand
    this.state.currentTrick.clear();
    this.state.completedTricks.clear();
    this.state.currentTrickNumber = 1;
    this.state.trickLeaderId = '';

    // Clear trump data
    this.state.trumpSuit = '';
    this.state.trumpCard = undefined;
    this.state.potValue = 0;

    // Clear ante data
    this.state.dealerHasSetAnte = false;

    this.state.specialRoundOutcome = '';
    this.state.specialRoundMessage = '';

    // Reset all players for next hand
    for (const player of this.state.players.values()) {
      player.hand.clear();
      player.ready = player.autoReady;
      player.roundOutcome = '';
      player.knockedIn = false;
      player.hasKnockDecision = false;
      player.hasDiscardDecision = false;
      player.dealerCompletedNormalDiscard = false;

      // Clear card selections
      player.selectedCards.clear();
      for (const card of player.hand.cards) {
        card.selected = false;
      }

      // Remove players that are still disconnected
      if (player.disconnected) this.deletePlayer(player.sessionId);
    }

    // Change starting player/dealer for next round
    this.roundIteratorOffset++;

    this.log(`Starting idle phase`);
    this.state.roundState = 'idle';
    this.triggerNewRoundCheck();
    this.updateRoomMetadata();
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

    // Trigger bot decisions if next player is a bot
    this.triggerBotDecisions();
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

    // INCREMENT TRICK COUNT FOR WINNER
    const winner = this.state.players.get(trickWinner.playerId);
    if (winner) {
      winner.tricksWon++;
      this.log(
        `${winner.displayName} now has ${winner.tricksWon} trick(s) won`
      );
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

      // Trigger bot decisions if next player is a bot
      this.triggerBotDecisions();
    }
    this.updateRoomMetadata();
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
   * Checks if a player's hand contains a special winning combination
   */
  private checkPlayerForSpecialHand(player: Player): SpecialHand | null {
    const cards = player.hand.cards;
    if (cards.length !== 3) return null;

    const values = cards.map((card) => card.value?.value).filter(Boolean);
    const suits = cards.map((card) => card.value?.suit).filter(Boolean);

    // Check for 3 Aces (priority 1 - highest)
    if (values.every((val) => val === 'A')) {
      return {
        type: 'three-aces',
        priority: 1,
        playerId: player.sessionId,
        description: `${player.displayName} has 3 Aces - the ultimate hand!`,
      };
    }

    // Check for 3 7s (priority 2)
    if (values.every((val) => val === '7')) {
      return {
        type: 'three-sevens',
        priority: 2,
        playerId: player.sessionId,
        description: `${player.displayName} has 3 7s - a very strong hand!`,
      };
    }

    // Check for A-K-Q of Trump (priority 3)
    if (this.state.trumpSuit && values.length === 3) {
      const hasAce =
        values.includes('A') && suits.includes(this.state.trumpSuit);
      const hasKing =
        values.includes('K') && suits.includes(this.state.trumpSuit);
      const hasQueen =
        values.includes('Q') && suits.includes(this.state.trumpSuit);

      // Verify all three cards are trump suit and are A, K, Q
      const trumpCards = cards.filter(
        (card) => card.value?.suit === this.state.trumpSuit
      );
      if (trumpCards.length === 3 && hasAce && hasKing && hasQueen) {
        return {
          type: 'akq-trump',
          priority: 3,
          playerId: player.sessionId,
          description: `${player.displayName} has A-K-Q of ${this.state.trumpSuit} - a powerful trump sequence!`,
        };
      }
    }

    return null;
  }

  /**
   * Checks all knocked-in players for special hands after discard/draw phase
   */
  private checkForSpecialHands(): SpecialHand[] {
    const specialHands: SpecialHand[] = [];

    for (const player of this.state.players.values()) {
      if (player.ready && player.knockedIn) {
        const specialHand = this.checkPlayerForSpecialHand(player);
        if (specialHand) {
          specialHands.push(specialHand);
        }
      }
    }

    // Sort by priority (lower number = higher priority)
    return specialHands.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Handles special hand wins - awards the entire pot to the winner
   */
  private async handleSpecialHandWin(specialHands: SpecialHand[]) {
    this.log(`Special hands detected: ${specialHands.length}`);
    this.state.roundState = 'special-hand-win';

    // The best special hand wins (lowest priority number)
    const winningHand = specialHands[0];
    const winner = this.state.players.get(winningHand.playerId);

    if (!winner) {
      this.log(`ERROR: Special hand winner not found: ${winningHand.playerId}`);
      return;
    }

    // SET THE DISPLAY FIELDS FOR FRONTEND
    this.state.specialHandWinner = winningHand.playerId;
    this.state.specialHandType = winningHand.type;
    this.state.specialHandDescription = winningHand.description;
    this.state.specialHandPotValue = this.state.potValue;

    this.log(`${winningHand.description}`);
    this.log(
      `${winner.displayName} wins the entire pot of ${this.state.potValue}¢ with ${winningHand.type}!`
    );

    // Award the entire pot to the winner
    winner.money += this.state.potValue;
    winner.roundOutcome = 'win';

    // Mark all other players as losers
    for (const player of this.state.players.values()) {
      if (player.ready && player.sessionId !== winningHand.playerId) {
        player.roundOutcome = 'lose';
      }
    }

    // Wait for players to see the special hand result
    await this.delay(5000);

    // CLEAR THE DISPLAY FIELDS
    this.state.specialHandWinner = '';
    this.state.specialHandType = '';
    this.state.specialHandDescription = '';
    this.state.specialHandPotValue = 0;

    // End the round
    this.endRound();
  }

  /**
   * Testing method to create special hands for debugging
   */
  private createTestSpecialHand(
    playerId: string,
    handType: 'three-aces' | 'three-sevens' | 'akq-trump'
  ) {
    const player = this.state.players.get(playerId);
    if (!player) return;

    // Clear current hand
    player.hand.clear();

    switch (handType) {
      case 'three-aces':
        player.hand.addSpecificCard('A', '♠︎', true);
        player.hand.addSpecificCard('A', '♥︎', true);
        player.hand.addSpecificCard('A', '♣︎', true);
        break;

      case 'three-sevens':
        player.hand.addSpecificCard('7', '♠︎', true);
        player.hand.addSpecificCard('7', '♥︎', true);
        player.hand.addSpecificCard('7', '♣︎', true);
        break;

      case 'akq-trump':
        // Create A-K-Q of trump suit
        if (this.state.trumpSuit) {
          player.hand.addSpecificCard('A', this.state.trumpSuit as Suit, true);
          player.hand.addSpecificCard('K', this.state.trumpSuit as Suit, true);
          player.hand.addSpecificCard('Q', this.state.trumpSuit as Suit, true);
        }
        break;
    }

    this.log(`Created ${handType} for ${player.displayName}`);
  }

  /**
   * Calculates who goes set and how much they owe after all tricks are complete
   */
  private calculateGoingSet() {
    this.log('=== CALCULATING GOING SET ===');

    const knockedInPlayers = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn
    );

    for (const player of knockedInPlayers) {
      const isDealer = player.sessionId === this.state.dealerId;

      this.log(
        `Checking ${player.displayName} (${isDealer ? 'Dealer' : 'Player'}): ${
          player.tricksWon
        } tricks won`
      );

      if (!player.knockedIn) {
        this.log(`  Player didn't knock in - skipping going set check`);
        continue; // Skip players who didn't knock in
      }

      // Determine if player goes set based on SWICK rules
      let goesSet = false;
      let setType = 'single';

      if (isDealer && this.state.dealerKeptTrump) {
        // Dealer kept trump - special rules apply
        const trumpValue = this.state.dealerTrumpValue;
        const isFaceTrump = ['J', 'Q', 'K', 'A'].includes(trumpValue);

        if (isFaceTrump) {
          // Face trump: must win 2 tricks or go set double
          setType = 'double';
          goesSet = player.tricksWon < 2;
          this.log(
            `  Dealer kept face trump (${trumpValue}) - needs 2 tricks, has ${player.tricksWon}`
          );
        } else {
          // Low trump (7,8,9,10): must win 1 trick or go set single
          setType = 'single';
          goesSet = player.tricksWon < 1;
          this.log(
            `  Dealer kept low trump (${trumpValue}) - needs 1 trick, has ${player.tricksWon}`
          );
        }
      } else {
        // Standard player or dealer who didn't keep trump
        setType = 'single';
        goesSet = player.tricksWon < 1;
        this.log(`  Standard player - needs 1 trick, has ${player.tricksWon}`);
      }

      // Apply going set
      if (goesSet) {
        player.wentSet = true;
        player.setType = setType;

        if (setType === 'double') {
          player.setAmount = this.state.potValue * 2;
          this.log(
            `  ${player.displayName} GOES SET DOUBLE - owes ${player.setAmount}¢`
          );
        } else {
          player.setAmount = this.state.potValue;
          this.log(
            `  ${player.displayName} GOES SET SINGLE - owes ${player.setAmount}¢`
          );
        }
        // Subtract the money from player's account
        player.money -= player.setAmount;
        this.log(
          `  💰 Subtracted ${player.setAmount}¢ from ${player.displayName}'s account (now has ${player.money}¢)`
        );

        // Ensure player doesn't go below 0 money
        if (player.money < 0) {
          this.log(`  ⚠️  ${player.displayName} went below 0, setting to 0`);
          player.money = 0;
        }
      } else {
        this.log(
          `  ${player.displayName} won ${player.tricksWon} tricks - no going set`
        );
      }
    }

    // Calculate total set amount for next round
    const totalSetAmount = knockedInPlayers
      .filter((p) => p.wentSet)
      .reduce((total, p) => total + p.setAmount, 0);

    if (totalSetAmount > 0) {
      this.state.nextRoundPotBonus = totalSetAmount;
      this.log(`Total set amount for next round: ${totalSetAmount}¢`);
    } else {
      this.log('No players went set this round');
    }
  }

  /**
   * Awards trick winnings to players (1/3 of pot per trick)
   */
  private awardTrickWinnings() {
    this.log('=== AWARDING TRICK WINNINGS ===');

    const trickValue = Math.floor(this.state.potValue / 3);
    this.log(`Each trick worth: ${trickValue}¢`);

    const knockedInPlayers = [...this.state.players.values()].filter(
      (p) => p.ready && p.knockedIn
    );

    for (const player of knockedInPlayers) {
      if (player.tricksWon > 0) {
        const winnings = player.tricksWon * trickValue;
        player.money += winnings;
        player.roundOutcome = 'win';
        this.log(
          `${player.displayName} wins ${winnings}¢ for ${player.tricksWon} trick(s)`
        );
      }
    }

    // Mark set players as losers
    const setPlayers = knockedInPlayers.filter((p) => p.wentSet);
    for (const player of setPlayers) {
      player.roundOutcome = 'lose';
    }
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

  // ====== BOT AI DECISION METHODS ======

  /**
   * Triggers bot decisions based on current game state
   */
  private triggerBotDecisions() {
    // Small delay to ensure state is stable
    this.clock.setTimeout(() => {
      this.log(`=== CHECKING BOT DECISIONS ===`);
      this.log(`Current state: ${this.state.roundState}`);
      this.log(`Current turn player: ${this.state.currentTurnPlayerId}`);
      this.log(`Current discard player: ${this.state.currentDiscardPlayerId}`);
      this.log(`Current knock player: ${this.state.currentKnockPlayerId}`);

      for (const [playerId, player] of this.state.players.entries()) {
        if (!player.isBot || player.disconnected) continue;

        this.log(`Checking bot: ${player.displayName} (${playerId})`);

        switch (this.state.roundState) {
          case 'trump-selection':
            if (playerId === this.state.dealerId) {
              this.log(`  → Bot dealer needs trump decision`);
              this.handleBotTrumpDecision(playerId);
            }
            break;

          case 'knock-in':
            if (
              playerId === this.state.currentKnockPlayerId &&
              !player.hasKnockDecision
            ) {
              this.log(`  → Bot needs knock decision`);
              this.handleBotKnockDecision(playerId);
            }
            break;

          case 'discard-draw':
            // FIX: Check currentDiscardPlayerId, not currentTurnPlayerId
            if (
              playerId === this.state.currentDiscardPlayerId &&
              !player.hasDiscardDecision
            ) {
              this.log(`  → Bot needs discard decision`);
              this.handleBotDiscardDecision(playerId);
            }
            break;

          case 'turns':
            if (playerId === this.state.currentTurnPlayerId) {
              this.log(`  → Bot needs to play card (${player.displayName})`);
              this.handleBotCardPlay(playerId);
            }
            break;
        }
      }
      this.log(`=== END BOT DECISION CHECK ===`);
    }, 100);
  }

  /**
   * Handles bot trump selection decision
   */
  private handleBotTrumpDecision(botId: string) {
    const bot = this.state.players.get(botId);
    if (!bot || !bot.isBot) return;

    const thinkingTime = this.getBotThinkingTime(bot.botDifficulty);

    this.clock.setTimeout(() => {
      const shouldKeepTrump = this.evaluateTrumpKeeping(botId);
      this.log(
        `${bot.displayName} (${bot.botDifficulty}) decides to ${
          shouldKeepTrump ? 'keep' : 'discard'
        } trump`
      );

      // Use existing trump selection logic
      if (shouldKeepTrump) {
        if (this.state.trumpCard) {
          bot.hand.cards.push(this.state.trumpCard);
          this.state.dealerKeptTrump = true;
          this.state.dealerTrumpValue = this.state.trumpCard.value!.value;
        }
      } else {
        this.state.dealerKeptTrump = false;
        this.state.dealerTrumpValue = '';
      }

      if (this.state.trumpCard) {
        this.state.trumpSuit = this.state.trumpCard.value!.suit;
      }

      this.startKnockInPhase();
    }, thinkingTime);
  }

  /**
   * Handles bot knock-in decision
   */
  private handleBotKnockDecision(botId: string) {
    const bot = this.state.players.get(botId);
    if (!bot || !bot.isBot) return;

    const thinkingTime = this.getBotThinkingTime(bot.botDifficulty);

    this.clock.setTimeout(() => {
      const shouldKnock = this.evaluateKnockDecision(botId);

      // Use existing knock logic
      bot.knockedIn = shouldKnock;
      bot.hasKnockDecision = true;

      if (!shouldKnock) {
        bot.ready = false; // This removes them from the round
        // BROADCAST PASS MESSAGE TO ALL PLAYERS
        this.broadcast('playerPassed', {
          playerId: botId,
          playerName: bot.displayName,
        });
        this.log(`${bot.displayName} (${bot.botDifficulty}) passes`);
      } else {
        // BROADCAST KNOCK MESSAGE TO ALL PLAYERS
        this.broadcast('playerKnockedIn', {
          playerId: botId,
          playerName: bot.displayName,
        });
        this.log(`${bot.displayName} (${bot.botDifficulty}) knocks in`);
      }

      this.inactivityTimeoutRef?.clear();

      if (botId === this.state.dealerId) {
        if (shouldKnock) {
          this.log(`Dealer knocked in - starting dealer discard phase`);
          this.state.roundState = 'discard-draw';
          this.state.currentDiscardPlayerId = this.state.dealerId;
          this.log(
            `Set currentDiscardPlayerId to: ${this.state.currentDiscardPlayerId}`
          );
          this.setInactivitySkipTimeout();
          this.triggerBotDecisions();
        } else {
          // ✅ FIXED - Handle dealer passing with proper logic
          this.handleDealerPassing(bot);
        }
      } else {
        this.startNextKnockTurn();
      }
    }, thinkingTime);
  }

  /**
   * Handles bot discard/draw decision
   */
  private handleBotDiscardDecision(botId: string) {
    const bot = this.state.players.get(botId);
    if (!bot || !bot.isBot) return;

    const thinkingTime = this.getBotThinkingTime(bot.botDifficulty);

    this.clock.setTimeout(() => {
      const discardIndexes = this.evaluateDiscardDecision(botId);

      this.log(
        `Bot ${bot.displayName} evaluated discard: ${discardIndexes.length} cards to discard`
      );
      this.log(`Bot hand has ${bot.hand.cards.length} cards`);

      if (discardIndexes.length === 0) {
        // Play with current cards
        this.log(`${bot.displayName} (${bot.botDifficulty}) keeps all cards`);

        // Handle dealer special case - if dealer has 4 cards (kept trump), must discard 1
        if (botId === this.state.dealerId && bot.hand.cards.length > 3) {
          this.log(
            `Dealer has ${bot.hand.cards.length} cards - must discard 1 card (not trump)`
          );
          bot.dealerCompletedNormalDiscard = true;
          bot.hasDiscardDecision = false;

          // Clear any selections
          for (const card of bot.hand.cards) {
            card.selected = false;
          }

          // Find a non-trump card to discard
          const nonTrumpIndex = this.findNonTrumpCardForDealer(bot);
          if (nonTrumpIndex !== -1) {
            bot.hand.cards[nonTrumpIndex].selected = true;
            this.log(
              `Bot dealer selected card ${nonTrumpIndex} for final discard`
            );

            // Now trigger the final discard
            this.clock.setTimeout(() => {
              this.handleBotFinalDiscard(botId);
            }, 500);
          }
          return;
        }

        bot.hasDiscardDecision = true;
        this.startNextDiscardTurn();
      } else {
        // Discard selected cards
        this.log(
          `${bot.displayName} (${bot.botDifficulty}) discards ${discardIndexes.length} cards`
        );

        // Mark cards for discard
        discardIndexes.forEach((index) => {
          if (bot.hand.cards[index]) {
            bot.hand.cards[index].selected = true;
          }
        });

        // Handle dealer final discard vs normal discard
        const isDealerFinalDiscard =
          botId === this.state.dealerId && bot.dealerCompletedNormalDiscard;

        if (isDealerFinalDiscard) {
          // Just remove the card
          bot.hand.cards = bot.hand.cards.filter((card) => !card.selected);
          bot.hasDiscardDecision = true;
          this.log(`Dealer completed final discard - starting trick taking`);
          this.startTrickTakingPhase();
        } else {
          // Normal discard/draw
          bot.hand.cards = bot.hand.cards.filter((card) => !card.selected);
          for (let i = 0; i < discardIndexes.length; i++) {
            bot.hand.addCardFromDeck(this.state.deck, true);
          }

          if (botId === this.state.dealerId) {
            bot.dealerCompletedNormalDiscard = true;
            if (bot.hand.cards.length > 3) {
              this.log(
                `Dealer now has ${bot.hand.cards.length} cards - needs final discard`
              );
              // Clear selections and stay in discard phase for final discard
              for (const card of bot.hand.cards) {
                card.selected = false;
              }
              bot.hasDiscardDecision = false;
              this.state.currentDiscardPlayerId = this.state.dealerId;
              this.setInactivitySkipTimeout();

              // Trigger bot decisions again for final discard
              this.triggerBotDecisions();
              return;
            }
          }

          bot.hasDiscardDecision = true;
          this.startNextDiscardTurn();
        }
      }
    }, thinkingTime);
  }

  // ADD this helper method for dealer final discard:
  private handleBotFinalDiscard(botId: string) {
    const bot = this.state.players.get(botId);
    if (!bot || !bot.isBot) return;

    const selectedCards = bot.hand.cards.filter((card) => card.selected);

    if (selectedCards.length === 1) {
      this.log(
        `Bot dealer final discard: ${selectedCards[0].value?.value} of ${selectedCards[0].value?.suit}`
      );

      // Remove the selected card
      bot.hand.cards = bot.hand.cards.filter((card) => !card.selected);
      bot.hasDiscardDecision = true;

      this.log(
        'Bot dealer completed final discard - all discard/draw complete'
      );
      this.startTrickTakingPhase();
    } else {
      this.log(
        `ERROR: Bot dealer should have exactly 1 card selected for final discard, has ${selectedCards.length}`
      );
    }
  }

  // ADD this helper method to find non-trump card for dealer:
  private findNonTrumpCardForDealer(dealer: Player): number {
    const trumpValue = this.state.trumpCard?.value?.value;
    const trumpSuit = this.state.trumpCard?.value?.suit;

    for (let i = 0; i < dealer.hand.cards.length; i++) {
      const card = dealer.hand.cards[i];
      // Don't select the trump card that was kept
      if (card.value?.suit !== trumpSuit || card.value?.value !== trumpValue) {
        return i;
      }
    }

    // Fallback: select first card (shouldn't happen)
    return 0;
  }

  /**
   * Handles bot card play during tricks
   */
  private handleBotCardPlay(botId: string) {
    const bot = this.state.players.get(botId);
    if (!bot || !bot.isBot) return;

    const thinkingTime = this.getBotThinkingTime(bot.botDifficulty);

    this.clock.setTimeout(() => {
      const cardIndex = this.evaluateCardPlay(botId);

      if (cardIndex !== -1 && cardIndex < bot.hand.cards.length) {
        const cardToPlay = bot.hand.cards[cardIndex];

        // VALIDATE CARD PLAY BEFORE ATTEMPTING
        if (this.isValidCardPlay(bot, cardToPlay)) {
          this.log(
            `${bot.displayName} (${bot.botDifficulty}) plays ${cardToPlay.value?.value} of ${cardToPlay.value?.suit}`
          );
          this.playCard(bot, cardToPlay, cardIndex);
        } else {
          // CARD PLAY IS INVALID - FIND ANY LEGAL CARD
          this.log(
            `${bot.displayName}: Invalid card choice, finding legal alternative`
          );
          const legalIndex = this.findAnyLegalCard(bot);
          if (legalIndex !== -1) {
            const legalCard = bot.hand.cards[legalIndex];
            this.log(
              `${bot.displayName} plays ${legalCard.value?.value} of ${legalCard.value?.suit} (legal alternative)`
            );
            this.playCard(bot, legalCard, legalIndex);
          } else {
            this.log(`ERROR: ${bot.displayName} has no legal cards to play!`);
            // EMERGENCY: Play first card as fallback
            if (bot.hand.cards.length > 0) {
              const emergencyCard = bot.hand.cards[0];
              this.log(
                `${bot.displayName} emergency plays ${emergencyCard.value?.value} of ${emergencyCard.value?.suit}`
              );
              this.playCard(bot, emergencyCard, 0);
            }
          }
        }
      } else {
        this.log(`ERROR: ${bot.displayName} could not determine card to play`);
      }
    }, thinkingTime);
  }

  // ADD this new helper method:
  private findAnyLegalCard(player: Player): number {
    const hand = Array.from(player.hand.cards);

    for (let i = 0; i < hand.length; i++) {
      if (this.isValidCardPlay(player, hand[i])) {
        return i;
      }
    }

    return -1; // No legal cards found (shouldn't happen)
  }

  private getBotThinkingTime(difficulty: string): number {
    const baseTimes: { [key: string]: number } = {
      // FIX: Add proper typing
      easy: 500,
      medium: 1000,
      hard: 1500,
    };
    const baseTime = baseTimes[difficulty] || 1000;
    return baseTime + Math.random() * baseTime;
  }

  private evaluateTrumpKeeping(botId: string): boolean {
    const bot = this.state.players.get(botId);
    if (!bot || !this.state.trumpCard) return false;

    const trumpValue = this.state.trumpCard.value?.value;
    const trumpSuit = this.state.trumpCard.value?.suit;
    const botHand = bot.hand.cards;

    switch (bot.botDifficulty) {
      case 'easy':
        const isFaceTrumpEasy = ['J', 'Q', 'K', 'A'].includes(trumpValue || ''); // FIX: Rename variable
        if (isFaceTrumpEasy) {
          return Math.random() > 0.3;
        }
        return Math.random() > 0.6;

      case 'medium':
        const trumpCardsInHand = botHand.filter(
          (card) => card.value?.suit === trumpSuit
        ).length;
        const isFaceTrumpMedium = ['J', 'Q', 'K', 'A'].includes(
          trumpValue || ''
        ); // FIX: Rename variable

        if (trumpCardsInHand > 0 || isFaceTrumpMedium) {
          return Math.random() > 0.2;
        }
        return Math.random() > 0.7;

      case 'hard':
        const trumpsInHand = botHand.filter(
          (card) => card.value?.suit === trumpSuit
        ).length;
        const faceCardsInHand = botHand.filter((card) =>
          ['J', 'Q', 'K', 'A'].includes(card.value?.value || '')
        ).length;
        const isFaceTrumpHard = ['J', 'Q', 'K', 'A'].includes(trumpValue || ''); // FIX: Rename variable

        let keepScore = 0;
        if (isFaceTrumpHard) keepScore += 3;
        if (trumpsInHand > 0) keepScore += trumpsInHand * 2;
        if (faceCardsInHand >= 2) keepScore += 2;

        return keepScore >= 3;

      default:
        return Math.random() > 0.5;
    }
  }

  private evaluateKnockDecision(botId: string): boolean {
    const bot = this.state.players.get(botId);
    if (!bot) return false;

    const botHand = Array.from(bot.hand.cards); // FIX: Convert ArraySchema to Array
    const trumpSuit = this.state.trumpSuit;

    // Check for special hands
    if (this.hasSpecialHand(botHand, trumpSuit)) {
      return true;
    }

    switch (bot.botDifficulty) {
      case 'easy':
        return Math.random() > 0.4;

      case 'medium':
        const handStrength = this.evaluateHandStrength(botHand, trumpSuit);
        return handStrength >= 0.4;

      case 'hard':
        const strength = this.evaluateHandStrength(botHand, trumpSuit);
        const potOdds = this.state.potValue / (bot.bet || 3);
        const adjustedThreshold = 0.5 - potOdds * 0.05;
        return strength >= adjustedThreshold;

      default:
        return Math.random() > 0.5;
    }
  }

  private evaluateDiscardDecision(botId: string): number[] {
    const bot = this.state.players.get(botId);
    if (!bot) return [];

    const botHand = Array.from(bot.hand.cards); // FIX: Convert ArraySchema to Array
    const trumpSuit = this.state.trumpSuit;

    // Don't discard if we have special hand
    if (this.hasSpecialHand(botHand, trumpSuit)) {
      return [];
    }

    const isDealerFinalDiscard =
      botId === this.state.dealerId && bot.dealerCompletedNormalDiscard;

    if (isDealerFinalDiscard) {
      // Find worst non-trump card to discard
      for (let i = 0; i < botHand.length; i++) {
        const card = botHand[i];
        if (
          card.value?.suit !== trumpSuit ||
          card.value?.value !== this.state.trumpCard?.value?.value
        ) {
          const score = this.scoreCard(card, trumpSuit, bot.botDifficulty);
          if (score < 0.4) {
            return [i];
          }
        }
      }
      return [0]; // Fallback
    }

    // Normal discard logic
    const cardScores = botHand.map((card, index) => ({
      index,
      score: this.scoreCard(card, trumpSuit, bot.botDifficulty),
    }));

    cardScores.sort((a, b) => a.score - b.score);

    switch (bot.botDifficulty) {
      case 'easy':
        const numToDiscard = Math.floor(Math.random() * 3);
        return cardScores.slice(0, numToDiscard).map((cs) => cs.index);

      case 'medium':
        return cardScores
          .filter((cs) => cs.score < 0.3)
          .slice(0, 2)
          .map((cs) => cs.index);

      case 'hard':
        // Try to improve toward special hands or keep strong cards
        return cardScores
          .filter((cs) => cs.score < 0.25)
          .slice(0, 2)
          .map((cs) => cs.index);

      default:
        return [];
    }
  }

  private evaluateCardPlay(botId: string): number {
    const bot = this.state.players.get(botId);
    if (!bot) return -1;

    const botHand = Array.from(bot.hand.cards); // FIX: Convert ArraySchema to Array
    const legalPlays = this.getLegalPlays(botHand);

    if (legalPlays.length === 0) return -1;
    if (legalPlays.length === 1) return legalPlays[0];

    switch (bot.botDifficulty) {
      case 'easy':
        return legalPlays[Math.floor(Math.random() * legalPlays.length)];

      case 'medium':
      case 'hard':
        // Try to win trick if possible, otherwise play low
        for (const playIndex of legalPlays) {
          const card = botHand[playIndex];
          if (this.wouldWinTrick(card)) {
            return playIndex;
          }
        }

        // Play lowest card
        const cardScores = legalPlays.map((index) => ({
          index,
          score: this.scoreCard(
            botHand[index],
            this.state.trumpSuit,
            bot.botDifficulty
          ),
        }));

        cardScores.sort((a, b) => a.score - b.score);
        return cardScores[0].index;

      default:
        return legalPlays[0];
    }
  }

  // ====== UTILITY METHODS (CORRECTED) ======

  private hasSpecialHand(hand: Card[], trumpSuit: string): boolean {
    const values = hand.map((card) => card.value?.value).filter(Boolean);
    const suits = hand.map((card) => card.value?.suit).filter(Boolean);

    // Three Aces
    if (values.filter((v) => v === 'A').length === 3) return true;

    // Three Sevens
    if (values.filter((v) => v === '7').length === 3) return true;

    // A-K-Q of Trump
    if (suits.filter((s) => s === trumpSuit).length === 3) {
      const trumpValues = hand
        .filter((card) => card.value?.suit === trumpSuit)
        .map((card) => card.value?.value);
      if (
        trumpValues.includes('A') &&
        trumpValues.includes('K') &&
        trumpValues.includes('Q')
      ) {
        return true;
      }
    }

    return false;
  }

  private evaluateHandStrength(hand: Card[], trumpSuit: string): number {
    if (this.hasSpecialHand(hand, trumpSuit)) return 1.0;

    let score = 0;
    const trumpCards = hand.filter(
      (card) => card.value?.suit === trumpSuit
    ).length;
    const faceCards = hand.filter((card) =>
      ['J', 'Q', 'K', 'A'].includes(card.value?.value || '')
    ).length;

    score += trumpCards * 0.3;
    score += faceCards * 0.2;

    return Math.min(score, 1.0);
  }

  private scoreCard(card: Card, trumpSuit: string, difficulty: string): number {
    const value = card.value?.value;
    const suit = card.value?.suit;

    let score = 0;

    if (suit === trumpSuit) score += 0.4;

    const faceValues = ['J', 'Q', 'K', 'A'];
    if (faceValues.includes(value || '')) {
      score += 0.3;
    }

    if (value === 'A') score += 0.2;
    if (value === '7') score += 0.1;

    return score;
  }

  private getLegalPlays(hand: Card[]): number[] {
    const currentTrick = this.state.currentTrick;
    const trumpSuit = this.state.trumpSuit;
    const legalPlays: number[] = [];

    // If no trick started, any card is legal (except Ace of Trump rule)
    if (currentTrick.length === 0) {
      // Check for Ace of Trump rule on first trick
      if (this.state.currentTrickNumber === 1) {
        const aceOfTrumpIndex = hand.findIndex(
          (card) => card.value?.value === 'A' && card.value?.suit === trumpSuit
        );

        // If player has Ace of Trump and is first after dealer, must play it
        const currentPlayerId = this.state.currentTurnPlayerId;
        if (
          aceOfTrumpIndex !== -1 &&
          this.isFirstPlayerAfterDealer(currentPlayerId)
        ) {
          return [aceOfTrumpIndex]; // Must play Ace of Trump
        }
      }

      // Otherwise any card is legal when leading
      return hand.map((_, index) => index);
    }

    const leadSuit = currentTrick[0].card.value?.suit;

    // Must follow suit if possible
    const sameSuitIndexes = hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card.value?.suit === leadSuit)
      .map(({ index }) => index);

    if (sameSuitIndexes.length > 0) {
      return sameSuitIndexes;
    }

    // Can't follow suit - must trump if possible
    const trumpIndexes = hand
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card.value?.suit === trumpSuit)
      .map(({ index }) => index);

    if (trumpIndexes.length > 0) {
      return trumpIndexes;
    }

    // Can't follow suit or trump - any card is legal
    return hand.map((_, index) => index);
  }

  private wouldWinTrick(card: Card): boolean {
    // Simplified logic - in a real implementation, this would simulate the trick
    const isTrump = card.value?.suit === this.state.trumpSuit;
    const isFace = ['J', 'Q', 'K', 'A'].includes(card.value?.value || '');

    // Higher chance to win with trump or face cards
    if (isTrump && isFace) return Math.random() > 0.3;
    if (isTrump) return Math.random() > 0.5;
    if (isFace) return Math.random() > 0.6;

    return Math.random() > 0.8;
  }

  /**
   * Updates room metadata for lobby display
   */
  private updateRoomMetadata() {
    const activePlayers = [...this.state.players.values()].filter(
      (p) => !p.disconnected
    );
    const readyPlayers = [...this.state.players.values()].filter(
      (p) => p.ready && !p.disconnected
    );
    const dealer = this.state.players.get(this.state.dealerId);
    const hasActiveSet = [...this.state.players.values()].some(
      (p) => p.wentSet
    );

    this.state.roomMetadata.currentPlayers = activePlayers.length;
    this.state.roomMetadata.readyPlayers = readyPlayers.length;
    this.state.roomMetadata.potValue = this.state.potValue;
    this.state.roomMetadata.dealerName = dealer?.displayName || '';
    this.state.roomMetadata.hasActiveSet = hasActiveSet;

    // IMPROVED: Better game status based on round state and player count
    switch (this.state.roundState) {
      case 'idle':
        if (activePlayers.length < gameConfig.minPlayers) {
          this.state.roomMetadata.gameStatus = 'Waiting for Players';
        } else if (readyPlayers.length < activePlayers.length) {
          this.state.roomMetadata.gameStatus = 'Players Getting Ready';
        } else {
          this.state.roomMetadata.gameStatus = 'Starting Game';
        }
        this.state.roomMetadata.allowJoining = true;
        break;

      case 'dealing':
        this.state.roomMetadata.gameStatus = 'Dealing Cards';
        this.state.roomMetadata.allowJoining = false;
        break;

      case 'trump-selection':
        this.state.roomMetadata.gameStatus = 'Dealer Choosing Trump';
        this.state.roomMetadata.allowJoining = false;
        break;

      case 'knock-in':
        this.state.roomMetadata.gameStatus = 'Players Deciding';
        this.state.roomMetadata.allowJoining = false;
        break;

      case 'discard-draw':
        this.state.roomMetadata.gameStatus = 'Drawing Cards';
        this.state.roomMetadata.allowJoining = false;
        break;

      case 'turns':
        this.state.roomMetadata.gameStatus = 'Playing Tricks';
        this.state.roomMetadata.allowJoining = false;
        break;

      case 'end':
        if (hasActiveSet) {
          this.state.roomMetadata.gameStatus = 'Someone Went Set!';
          this.state.roomMetadata.allowJoining = false; // Can't join if someone went set
        } else {
          this.state.roomMetadata.gameStatus = 'Hand Complete';
          this.state.roomMetadata.allowJoining = true; // Can join between hands
        }
        break;

      default:
        this.state.roomMetadata.gameStatus = 'In Progress';
        this.state.roomMetadata.allowJoining = false;
    }

    // Don't allow joining if room is full
    if (activePlayers.length >= this.state.roomMetadata.maxPlayers) {
      this.state.roomMetadata.allowJoining = false;
    }
    // IMPORTANT: Always update the Colyseus metadata for lobby
    this.setMetadata({
      roomName: this.state.roomMetadata.roomName,
      isPublic: this.state.roomMetadata.isPublic,
      allowJoining: this.state.roomMetadata.allowJoining,
      currentPlayers: this.state.roomMetadata.currentPlayers,
      readyPlayers: this.state.roomMetadata.readyPlayers,
      potValue: this.state.roomMetadata.potValue,
      gameStatus: this.state.roomMetadata.gameStatus,
      dealerName: this.state.roomMetadata.dealerName,
      hasActiveSet: this.state.roomMetadata.hasActiveSet,
      maxClients: this.state.roomMetadata.maxPlayers,
    });
  }
}
