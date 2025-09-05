import { Component, EventEmitter, Input, Output } from '@angular/core';
import gameConfig from 'backend/src/game.config';

@Component({
  selector: 'app-player-actions',
  templateUrl: './player-action.component.html',
  styleUrls: ['./player-action.component.scss'],
})
export class PlayerActionsComponent {
  @Input() betMenuDisabled? = false;
  @Input() currentBet = 0;
  @Output() changeBet = new EventEmitter<number>();
  @Output() setBet = new EventEmitter<number>();

  /** If true stayHitMenu is shown instead of ready menu */
  @Input() readyMenuHidden = false;
  @Input() ready? = false;
  @Output() readyChange = new EventEmitter<boolean>();
  @Input() autoReady? = false;
  @Output() autoReadyChange = new EventEmitter<boolean>();

  @Input() cardPlayPhase = false;
  @Input() isPlayersTurn = false;

  // SWICK-specific inputs and outputs
  @Input() trumpSelectionMenuVisible = false;
  @Input() trumpCardDisplay = '';
  @Output() keepTrump = new EventEmitter<boolean>();

  @Input() knockInMenuVisible = false;
  @Input() trumpSuit = '';
  @Output() knockIn = new EventEmitter<boolean>();

  @Input() discardDrawMenuVisible = false;
  @Input() selectedCardCount = 0;
  @Output() playCards = new EventEmitter<void>();
  @Output() discardDraw = new EventEmitter<void>();

  @Input() isDealer = false;
  allowedAntes = [3, 6, 9, 12, 15];
  @Input() dealerHasSetAnte = false;

  // NEW: Dealer-specific trump keeping info
  @Input() dealerKeptTrump = false;
  @Input() dealerTrumpValue = '';
  @Input() isDealerFinalDiscard = false; // After dealer completed normal discard/draw
  @Output() dealerGoSet = new EventEmitter<boolean>();
  @Input() hasGoingSetBonus = false; // Whether there's a going set bonus active
  @Input() goingSetBonusAmount = 0; // Amount of going set bonus

  gameConfig = gameConfig;

  get isWaitingForAnteSet(): boolean {
    if (this.isDealer) return false;
    return !this.dealerHasSetAnte;
  }

  // NEW: Get the dealer's set type based on trump value
  get dealerSetType(): 'single' | 'double' {
    if (!this.dealerKeptTrump || !this.dealerTrumpValue) return 'single';
    const faceCards = ['J', 'Q', 'K', 'A'];
    return faceCards.includes(this.dealerTrumpValue) ? 'double' : 'single';
  }

  get dealerPassButtonText(): string {
    if (!this.isDealer || !this.dealerKeptTrump) return 'Pass';
    return 'Go Set Single'; // Always single when choosing not to play
  }

  get dealerFinalDecisionText(): string {
    if (!this.isDealerFinalDiscard || !this.dealerKeptTrump) return '';
    return 'Go Set Single'; // Always single when choosing not to play
  }

  /**
   * Get the appropriate ready button text based on player role and game state
   */
  getReadyButtonText(): string {
    if (this.isDealer && !this.hasGoingSetBonus) {
      return "Ante Set. Let's Play";
    }
    return "I'm Ready to Play";
  }
}
