import { Component } from '@angular/core';
import { FormControl, Validators } from '@angular/forms';
import gameConfig from 'backend/src/game.config';
import { GameService } from '../game.service';

@Component({
  selector: 'app-join-screen',
  templateUrl: './join-screen.component.html',
  styleUrls: ['./join-screen.component.scss'],
})
export class JoinScreenComponent {
  roomId = new FormControl('', [
    Validators.required,
    Validators.minLength(gameConfig.roomIdLength),
    Validators.maxLength(gameConfig.roomIdLength),
  ]);

  playerName = new FormControl('', [
    Validators.required,
    Validators.minLength(1),
    Validators.maxLength(20),
  ]);

  private randomNames = [
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

  constructor(public game: GameService) {
    // Auto-generate initial random name
    this.generateRandomName();
  }

  generateRandomName(): void {
    const randomIndex = Math.floor(Math.random() * this.randomNames.length);
    const baseName = this.randomNames[randomIndex];
    const randomNumber = Math.floor(Math.random() * 999) + 1;
    const name = `${baseName}${randomNumber}`;
    this.playerName.setValue(name);
  }

  getJoinButtonTooltip(): string {
    if (this.roomId.invalid) {
      return `Room ID needs to be ${gameConfig.roomIdLength} letters long.`;
    }
    if (!this.playerName.value?.trim()) {
      return 'Please enter a player name.';
    }
    return '';
  }
}
