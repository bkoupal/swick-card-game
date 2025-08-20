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

  gameConfig = gameConfig;

  /**
   * Are non-dealers waiting for dealer to set ante?
   */
  get isWaitingForAnteSet(): boolean {
    if (this.isDealer) return false;

    // For non-dealers, check if their bet is still the default
    // This should update when dealer sets ante and it propagates to all players
    return this.currentBet <= 3; // Changed from === to <= to be safe
  }
}
