import { Component } from '@angular/core';
import { FormControl, Validators } from '@angular/forms';
import gameConfig from 'backend/src/game.config';
import { GameService } from '../game.service';
import { GameSetup } from '../game.service';

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

  totalPlayers = 3;
  playerTypes: ('human' | 'bot')[] = ['human', 'human']; // For players 3-6
  botDifficulty: 'easy' | 'medium' | 'hard' = 'easy';

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

  private randomNamesXmas = [
    'Rudolph',
    'SantaClaus',
    'Frosty',
    'Blitzen',
    'Dasher',
    'Prancer',
    'Snowflake',
    'Jingles',
    'MrsClaus',
    'Grinch',
    'Scrooge',
    'Tinsel',
    'CandyCane',
    'Nutcracker',
    'Kringle',
    'Mistletoe',
    'Gingerbread',
    'SugarPlum',
    'Chestnuts',
    'Krampus',
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

  getPlayerSlots(): number[] {
    // Return array for players 2 through totalPlayers
    return Array.from({ length: this.totalPlayers - 1 }, (_, i) => i + 1);
  }

  setTotalPlayers(count: number): void {
    this.totalPlayers = count;

    // Adjust playerTypes array to match new total
    const slotsNeeded = count - 1; // Player 1 is always human

    if (this.playerTypes.length < slotsNeeded) {
      // Add more slots, default to human
      while (this.playerTypes.length < slotsNeeded) {
        this.playerTypes.push('human');
      }
    } else if (this.playerTypes.length > slotsNeeded) {
      // Remove extra slots
      this.playerTypes = this.playerTypes.slice(0, slotsNeeded);
    }
  }

  // NEW: Add these Phase 2 methods
  setPlayerType(slotIndex: number, type: 'human' | 'bot'): void {
    if (slotIndex >= 0 && slotIndex < this.playerTypes.length) {
      this.playerTypes[slotIndex] = type;
    }
  }

  setBotDifficulty(difficulty: 'easy' | 'medium' | 'hard'): void {
    this.botDifficulty = difficulty;
  }

  hasAnyBots(): boolean {
    return this.playerTypes.includes('bot');
  }

  getGameSummary(): string {
    const humanCount =
      this.playerTypes.filter((type) => type === 'human').length + 1; // +1 for player 1
    const botCount = this.playerTypes.filter((type) => type === 'bot').length;

    if (botCount === 0) {
      return `${humanCount} human players`;
    } else if (humanCount === 1) {
      return `You vs ${botCount} ${this.botDifficulty} bot${
        botCount > 1 ? 's' : ''
      }`;
    } else {
      return `${humanCount} humans + ${botCount} ${this.botDifficulty} bot${
        botCount > 1 ? 's' : ''
      }`;
    }
  }

  createGameWithBots(): void {
    if (!this.playerName.value?.trim()) {
      return;
    }

    const gameSetup: GameSetup = {
      totalPlayers: this.totalPlayers,
      playerTypes: this.playerTypes,
      botDifficulty: this.botDifficulty,
      playerName: this.playerName.value.trim(),
    };

    // Check if any bots are selected
    const hasBots = this.hasAnyBots();

    if (hasBots) {
      // Create room with bot configuration
      this.game.createRoomWithBots(gameSetup);
    } else {
      // Create regular room (no bots)
      this.game.createRoom(gameSetup.playerName);
    }
  }
}
