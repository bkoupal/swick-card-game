import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import { Component, Input } from '@angular/core';
import gameConfig from 'backend/src/game.config';
import { map, Observable } from 'rxjs';
import { GameService } from '../game.service';
import {
  placePlayersAtMobileTable,
  placePlayersAtTable,
} from './placePlayersAtTable';

@Component({
  selector: 'app-game-screen',
  templateUrl: './game-screen.component.html',
  styleUrls: ['./game-screen.component.scss'],
})
export class GameScreenComponent {
  location = location;
  Math = Math;

  smallScreen$: Observable<boolean>;

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
    return (smallScreen ? placePlayersAtMobileTable : placePlayersAtTable)(
      [...this.game.room!.state.players.values()],
      this.game.room!.sessionId,
      gameConfig.tablePositions
    );
  }

  getTrumpCardDisplay(): string {
    const trumpCard = this.game.room?.state.trumpCard;
    if (!trumpCard?.value) return '';
    return `${trumpCard.value.value} of ${trumpCard.value.suit}`;
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
}
