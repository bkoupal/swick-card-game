import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Component, Input, OnInit } from '@angular/core';
import gameConfig from 'backend/src/game.config';
import { map, Observable } from 'rxjs';
import { GameService } from '../game.service';
import {
  placePlayersAtMobileTable,
  placePlayersAtTable,
} from './placePlayersAtTable';

interface GameMessage {
  id: string;
  text: string;
  type: string;
  timestamp: number;
  duration: number;
  class: string;
}

@Component({
  selector: 'app-game-screen',
  templateUrl: './game-screen.component.html',
  styleUrls: ['./game-screen.component.scss'],
})
export class GameScreenComponent implements OnInit {
  location = location;
  Math = Math;
  Date = Date;
  smallScreen$: Observable<boolean>;

  messageQueue: GameMessage[] = [];
  activeMessages: GameMessage[] = [];
  shownMessageKeys: Set<string> = new Set();
  messageProcessingTimer: any;

  constructor(public game: GameService, public breakpoint: BreakpointObserver) {
    this.smallScreen$ = breakpoint
      .observe('(min-width: 640px)')
      .pipe(map((x) => !x.matches));
  }

  /**
   * Returns the relative position (0.5 -> 0 (middle) -> 0.5) of player at table
   */
  getPlayerPosition(index: number) {
    return Math.abs(0.5 - (index + 1) / (gameConfig.maxClients + 1));
  }

  getAllPlayers(smallScreen: boolean | null) {
    // Force rectangle layout on ALL devices for better mobile experience
    const result = placePlayersAtMobileTable(
      [...this.game.room!.state.players.values()],
      this.game.room!.sessionId,
      gameConfig.tablePositions,
      this.game.room!.state.dealerId
    );

    return result;
  }

  getTrumpCardDisplay(): string {
    const trumpCard = this.game.room?.state.trumpCard;
    if (!trumpCard?.value) return '';
    return `${trumpCard.value.value} of ${trumpCard.value.suit}`;
  }

  /**
   * Determines if the player can change their name
   * Only allowed during idle state (not during a round)
   */
  canChangeName(): boolean {
    return this.game.room?.state.roundState === 'idle' && !!this.game.player;
  }

  /**
   * Opens a prompt for the player to change their name
   */
  openNameChangeDialog(): void {
    const currentName = this.game.player?.displayName || '';
    const newName = prompt(
      'Enter your new name (max 20 characters):',
      currentName
    );

    if (newName && newName.trim() && newName.trim() !== currentName) {
      const sanitizedName = newName.trim().substring(0, 20);
      this.game.changeName(sanitizedName);
    }
  }

  getPlayerName(playerId: string): string {
    const player = this.game.room?.state.players.get(playerId);
    return player?.displayName || 'Unknown';
  }

  getCurrentPlayerName(): string {
    if (!this.game.room?.state.currentTurnPlayerId) return '';

    const currentPlayer = this.game.room.state.players.get(
      this.game.room.state.currentTurnPlayerId
    );
    return currentPlayer?.displayName || 'Unknown Player';
  }

  getTrickWinnerName(): string {
    // During trick-complete state, the winner is stored in trickLeaderId
    if (this.game.room?.state.roundState === 'trick-complete') {
      const winnerId = this.game.room.state.trickLeaderId;
      const winner = this.game.room.state.players.get(winnerId);
      return winner?.displayName || 'Unknown';
    }

    // Fallback to last completed trick
    const lastTrick = this.game.room?.state.completedTricks.at(-1);
    if (!lastTrick) return '';

    const winner = this.game.room?.state.players.get(lastTrick.winnerId);
    return winner?.displayName || 'Unknown';
  }

  getSelectedCardCount(): number {
    if (!this.game.player) return 0;
    return this.game.player.hand.cards.filter((card) => card.selected).length;
  }

  isDealerFinalDiscard(): boolean {
    const cardCount = this.game.player?.hand?.cards?.length ?? 0;
    const completedNormalDiscard =
      this.game.player?.dealerCompletedNormalDiscard ?? false;

    return (
      this.game.isDealer &&
      cardCount === 4 &&
      completedNormalDiscard &&
      this.game.room!.state.roundState === 'discard-draw'
    );
  }

  get currentPotValue(): number {
    return this.game.room?.state?.potValue || 0;
  }

  get showPotDisplay(): boolean {
    return !!(
      this.game.room?.state && this.game.room.state.roundState !== 'idle'
    );
  }

  get dealerHasSetAnte(): boolean {
    return (this.game.room?.state as any)?.dealerHasSetAnte || false;
  }

  /**
   * Calculate the value of each trick (1/3 of the pot)
   */
  getTrickValue(): number {
    const potValue = this.game.room?.state?.potValue || 0;
    return Math.floor(potValue / 3);
  }

  // GOING SET METHODS

  /**
   * Should we show going set results popup?
   */
  shouldShowGoingSetResults(): boolean {
    return (
      this.game.room?.state.roundState === 'end' &&
      this.getGoingSetPlayers().length > 0
    );
  }

  /**
   * Get list of players who went set this round
   */
  getGoingSetPlayers(): Array<{ name: string; amount: number; type: string }> {
    if (!this.game.room?.state) return [];

    const specialHandWinner = this.game.room.state.specialHandWinner;
    const setPlayers = [];

    for (const player of this.game.room.state.players.values()) {
      // Skip special hand winner
      if (player.sessionId === specialHandWinner) {
        continue;
      }

      if (player.wentSet && player.setAmount) {
        setPlayers.push({
          name: player.displayName,
          amount: player.setAmount,
          type: player.setType || 'single',
        });
      }
    }

    return setPlayers;
  }

  /**
   * Get total going set bonus for next round
   */
  getTotalGoingSetBonus(): number {
    return this.getGoingSetPlayers().reduce(
      (total, player) => total + player.amount,
      0
    );
  }

  /**
   * Get the going set bonus for next round
   */
  getNextRoundBonus(): number {
    return this.game.room?.state.nextRoundPotBonus || 0;
  }

  /**
   * Should we show the "everyone passed" message?
   */
  shouldShowEveryonePassedMessage(): boolean {
    return (
      this.game.room?.state.roundState === 'end' &&
      this.game.room?.state.specialRoundOutcome === 'dealer-auto-win'
    );
  }

  /**
   * Get discard/draw status message for display at top of table
   */
  getDiscardDrawMessage(): string | null {
    if (!this.game.room?.state) return null;

    // Only show during discard-draw phase
    if (this.game.room.state.roundState !== 'discard-draw') return null;

    const players = [...this.game.room.state.players.values()];
    const knockedInPlayers = players.filter((p) => p.ready && p.knockedIn);
    const completedPlayers = knockedInPlayers.filter(
      (p) => p.hasDiscardDecision
    );

    if (knockedInPlayers.length === 0) return null;

    // If all players completed, don't show message
    if (completedPlayers.length === knockedInPlayers.length) return null;

    // Show current player's discard status
    const currentPlayer = players.find(
      (p) => p.sessionId === this.game.room?.state.currentDiscardPlayerId
    );
    if (!currentPlayer) return null;

    return `${currentPlayer.displayName} is discarding/drawing cards`;
  }

  /**
   * Get summary of what players discarded/drew after discard phase
   */
  getDiscardDrawSummary(): string | null {
    if (!this.game.room?.state) return null;

    // Only show briefly after discard-draw phase completes, before trick-taking starts
    if (this.game.room.state.roundState !== 'turns') return null;

    const players = [...this.game.room.state.players.values()];
    const knockedInPlayers = players.filter((p) => p.ready && p.knockedIn);

    if (knockedInPlayers.length === 0) return null;

    // Create summary of what each player did
    const summaries: string[] = [];

    for (const player of knockedInPlayers) {
      const cardsDiscarded = player.discardedCards?.length || 0;
      if (cardsDiscarded === 0) {
        summaries.push(`${player.displayName}: Kept all`);
      } else {
        summaries.push(`${player.displayName}: Drew ${cardsDiscarded}`);
      }
    }

    return summaries.join(' • ');
  }

  getActiveMessages(): GameMessage[] {
    console.log('📋 Active messages requested:', this.activeMessages.length);
    return this.activeMessages;
  }

  trackMessage(index: number, message: GameMessage): string {
    return message.id;
  }

  addGameMessage(
    text: string,
    type: string,
    duration = 4000,
    cssClass = 'bg-blue-600'
  ) {
    console.log('📨 Adding message:', { text, type, cssClass });

    const message: GameMessage = {
      id: `${type}-${Date.now()}-${Math.random()}`,
      text,
      type,
      timestamp: Date.now(),
      duration,
      class: cssClass,
    };

    this.messageQueue.push(message);
    console.log('📬 Message queue length:', this.messageQueue.length);

    // Only process if no messages are currently active
    if (this.activeMessages.length === 0) {
      this.processMessageQueue();
    }
  }

  // Update the removeMessage method to clean up tracking
  private removeMessage(messageId: string) {
    this.activeMessages = this.activeMessages.filter((m) => m.id !== messageId);
    // Process any remaining queued messages
    if (this.messageQueue.length > 0) {
      setTimeout(() => this.processMessageQueue(), 200);
    }
  }

  // Update the checkForDiscardDrawMessages method with better message key tracking
  private checkForDiscardDrawMessages() {
    if (!this.game.room?.state) return;

    const players = [...this.game.room.state.players.values()];

    // Show "player is discarding" messages
    if (this.game.room.state.roundState === 'discard-draw') {
      const currentPlayer = players.find(
        (p) => p.sessionId === this.game.room?.state.currentDiscardPlayerId
      );
      if (currentPlayer) {
        const messageKey = `discard-turn-start-${this.game.room.state.roundState}`;
        const hasShownMessage =
          currentPlayer.shownMessages?.includes(messageKey);
        const uniqueKey = `current-${currentPlayer.sessionId}-${messageKey}`;

        if (hasShownMessage && !this.hasActiveMessage(uniqueKey)) {
          this.shownMessageKeys.add(uniqueKey);
          this.addGameMessage(
            `${currentPlayer.displayName} is choosing cards to discard`,
            `discard-draw-current-${currentPlayer.sessionId}`,
            4000,
            'bg-blue-600'
          );
          return; // Exit early to prevent multiple messages at once
        }
      }
    }

    // Show completed discard messages (but only one at a time)
    for (const player of players) {
      if (player.hasDiscardDecision) {
        const messageKey = `discard-completed-${this.game.room.state.roundState}`;
        const hasShownMessage = player.shownMessages?.includes(messageKey);
        const uniqueKey = `completed-${player.sessionId}-${messageKey}`;

        if (hasShownMessage && !this.hasActiveMessage(uniqueKey)) {
          this.shownMessageKeys.add(uniqueKey);
          const cardsDiscarded = player.discardedCards?.length || 0;
          const message =
            cardsDiscarded === 0
              ? `${player.displayName} kept all cards`
              : `${player.displayName} drew ${cardsDiscarded} card${
                  cardsDiscarded > 1 ? 's' : ''
                }`;

          this.addGameMessage(
            message,
            `discard-result-completed-${player.sessionId}`,
            4000,
            'bg-green-600'
          );
          return; // Exit early to show one message at a time
        }
      }
    }
  }

  private processMessageQueue() {
    // Clear any existing timer
    if (this.messageProcessingTimer) {
      clearTimeout(this.messageProcessingTimer);
    }

    // Only process one message at a time with proper spacing
    if (this.messageQueue.length > 0 && this.activeMessages.length === 0) {
      const message = this.messageQueue.shift()!;
      this.activeMessages.push(message);

      // Set timer to remove this message
      setTimeout(() => {
        this.removeMessage(message.id);
      }, message.duration);
    }

    // If there are still queued messages, process next one after current one finishes
    if (this.messageQueue.length > 0) {
      this.messageProcessingTimer = setTimeout(() => {
        this.processMessageQueue();
      }, 500); // Process next message 500ms after current one starts
    }
  }

  private hasActiveMessage(messageKey: string): boolean {
    // Check both active messages and our tracking set
    return (
      this.activeMessages.some((msg) => msg.id.includes(messageKey)) ||
      this.shownMessageKeys.has(messageKey)
    );
  }

  private clearShownMessages() {
    this.shownMessageKeys.clear();
  }
  ngOnInit() {
    // Expose for testing - REMOVE IN PRODUCTION
    (window as any).testGame = this.game;

    // Track round state changes to clear shown messages
    let lastRoundState = '';

    // Set up interval to check for new messages
    setInterval(() => {
      // Clear shown messages when round state changes
      if (this.game.room?.state?.roundState !== lastRoundState) {
        if (lastRoundState !== '') {
          this.clearShownMessages();
        }
        lastRoundState = this.game.room?.state?.roundState || '';
      }

      this.checkForDiscardDrawMessages();
    }, 1000); // Increased to 1 second to reduce spam
  }

  getDealerPlayer() {
    if (!this.game.room?.state) return null;
    return this.game.room.state.players.get(this.game.room.state.dealerId);
  }

  /**
   * Should we show the "Play Special Hand" button?
   */
  shouldShowPlaySpecialHandButton(): boolean {
    if (!this.game.room?.state || !this.game.player) {
      return false;
    }

    // Only show during trick-taking phase, first trick, and it's the player's turn
    return (
      this.game.room.state.roundState === 'turns' &&
      this.game.room.state.currentTrickNumber === 1 &&
      this.game.playersTurn &&
      this.game.player.hasSpecialHand === true
    );
  }

  /**
   * Play the special hand
   */
  playSpecialHand() {
    this.game.playSpecialHand();
  }
}
