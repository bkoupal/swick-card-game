import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { Card, Hand, Player } from 'backend/src/rooms/schema/GameState';

@Component({
  selector: 'app-player',
  templateUrl: './player.component.html',
  styleUrls: ['./player.component.scss'],
})
export class PlayerComponent {
  @Input() player?: Player;
  @Input() dealerHand?: Hand;
  @Input() type: 'dealer' | 'player' = 'player';
  @Input() scoreBottom: boolean | null = false;
  @Input() isDealer: boolean = false; // Add this line
  @Input() gameState?: any; // We'll pass the game state to check round state
  @Output() selectCard = new EventEmitter<number>(); // Add this output
  // For this component:
  // Player = The player that is passed into the component, can be client or any other player
  // Client = The player that is using this game instance

  @Output() kick = new EventEmitter<string>();
  @Output() playCard = new EventEmitter<number>();
  @Input() isPlayerTurn: boolean = false;
  @Input() endTimestamp: number = 0;
  @Input() clientIsPlayer: boolean = false;
  @Input() clientIsAdmin?: boolean = false;

  get hand() {
    return this.player?.hand || this.dealerHand;
  }

  public roundOutcomeToDisplayMessage = {
    bust: 'Busted',
    win: 'Win',
    lose: 'Lose',
    draw: 'Draw',
    '': '',
  };

  public roundOutcomeToDisplayMessageCurrentPlayer = {
    bust: 'Busted',
    win: 'You Won!',
    lose: 'You Lost!',
    draw: 'Draw',
    '': '',
  };

  onCardClick(cardIndex: number) {
    if (!this.clientIsPlayer) {
      // Not the current client's player, ignore clicks
      return;
    }

    if (this.isDiscardDrawPhase()) {
      // During discard/draw phase, check if this player can discard
      if (this.isCurrentDiscardPlayer()) {
        this.selectCard.emit(cardIndex);
      }
    } else if (this.isPlayerTurn) {
      // During trick-taking phase, check if it's this player's turn
      this.playCard.emit(cardIndex);
    }
  }

  canPlayCard(card: Card): boolean {
    if (!this.clientIsPlayer) {
      return false;
    }

    if (this.isDiscardDrawPhase()) {
      // During discard/draw, cards are clickable if it's this player's turn to discard
      return this.isCurrentDiscardPlayer();
    }

    // During trick-taking, allow any card when it's the player's turn
    // The backend will validate the actual SWICK rules
    return this.isPlayerTurn;
  }

  private isDiscardDrawPhase(): boolean {
    return this.gameState?.roundState === 'discard-draw';
  }

  private isCurrentDiscardPlayer(): boolean {
    return this.gameState?.currentDiscardPlayerId === this.player?.sessionId;
  }

  // Add debugging method to help troubleshoot (remove after fixing)
  onCardClickDebug(cardIndex: number) {
    console.log('Card click debug:', {
      clientIsPlayer: this.clientIsPlayer,
      isDiscardDrawPhase: this.isDiscardDrawPhase(),
      isCurrentDiscardPlayer: this.isCurrentDiscardPlayer(),
      isPlayerTurn: this.isPlayerTurn,
      currentDiscardPlayerId: this.gameState?.currentDiscardPlayerId,
      playerSessionId: this.player?.sessionId,
      roundState: this.gameState?.roundState,
    });

    this.onCardClick(cardIndex);
  }

  /**
   * Should this player's cards be visible to the current client?
   */
  shouldShowCards(): boolean {
    // Players can only see their own cards
    if (!this.clientIsPlayer) return false;

    // If this is not the dealer, always show cards
    if (!this.isDealer) return true;

    // For dealers, hide cards during specific phases until their turn
    if (this.gameState?.roundState === 'knock-in') {
      // Show cards if dealer has made their knock decision
      if (this.player?.hasKnockDecision) return true;

      // Show cards if it's currently dealer's turn to knock
      if (this.gameState?.currentKnockPlayerId === this.player?.sessionId)
        return true;

      // Otherwise hide cards during knock-in phase
      return false;
    }

    // Show cards during all other phases (dealing, discard-draw, turns, etc.)
    return true;
  }

  /**
   * Returns a card with visibility set to false (shows card back)
   */
  getHiddenCard(originalCard: Card): Card {
    // Create a copy of the card with visible set to false
    const hiddenCard = Object.assign({}, originalCard);
    hiddenCard.visible = false;
    return hiddenCard;
  }

  /**
   * Should we show tricks won indicator?
   */
  shouldShowTricksWon(): boolean {
    if (!this.player || !this.gameState) return false;

    // Show during trick-taking, trick-complete, and end phases
    const showDuringStates = ['turns', 'trick-complete', 'end'];
    return (
      showDuringStates.includes(this.gameState.roundState) &&
      this.player.knockedIn &&
      this.player.tricksWon >= 0
    );
  }
}
