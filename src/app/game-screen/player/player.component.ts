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
    if (this.clientIsPlayer && this.isPlayerTurn) {
      this.playCard.emit(cardIndex);
    } else if (this.clientIsPlayer && this.isDiscardDrawPhase()) {
      // During discard/draw phase, clicking selects/deselects cards
      this.selectCard.emit(cardIndex);
    }
  }

  canPlayCard(card: Card): boolean {
    if (this.isDiscardDrawPhase()) {
      // During discard/draw, all cards are clickable for selection
      return this.clientIsPlayer && this.isCurrentDiscardPlayer();
    }

    // During trick-taking, allow any card when it's the player's turn
    // The backend will validate the actual SWICK rules
    return this.clientIsPlayer && this.isPlayerTurn;
  }

  /**
   * Should this player's cards be visible to the current client?
   */
  shouldShowCards(): boolean {
    // Players can only see their own cards
    // Dealer is treated exactly like any other player
    return this.clientIsPlayer;
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

  private isDiscardDrawPhase(): boolean {
    return this.gameState?.roundState === 'discard-draw';
  }

  private isCurrentDiscardPlayer(): boolean {
    return this.gameState?.currentDiscardPlayerId === this.player?.sessionId;
  }
}
