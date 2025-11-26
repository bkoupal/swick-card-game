// src/app/lobby/lobby.component.ts - UPDATED with helper method

import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { LobbyService, RoomListingData } from '../lobby.service';
import { GameService, GameSetup } from '../game.service';
import { FormControl, Validators } from '@angular/forms';

@Component({
  selector: 'app-lobby',
  templateUrl: './lobby.component.html',
  styleUrls: ['./lobby.component.scss'],
})
export class LobbyComponent implements OnInit, OnDestroy {
  roomListings: RoomListingData[] = [];
  isLoading = false;
  error: string | null = null;
  showAdvancedCreation = false;

  playerName = new FormControl('', [
    Validators.required,
    Validators.minLength(1),
    Validators.maxLength(20),
  ]);

  // Advanced game creation properties
  totalPlayers = 3;
  playerTypes: ('human' | 'bot')[] = ['human', 'human']; // For players 2-6 (player 1 is always human)
  botDifficulty: 'easy' | 'medium' | 'hard' = 'easy';

  // ADD PRIVATE GAME OPTION
  isPrivateGame = false;

  constructor(
    private lobbyService: LobbyService,
    private gameService: GameService,
    private router: Router
  ) {
    // Auto-generate initial random name
    // this.generateRandomName();
  }

  ngOnInit(): void {
    this.loadRoomListings();
    this.lobbyService.startAutoRefresh(5000); // Refresh every 5 seconds

    this.lobbyService.getRoomListings().subscribe(
      (rooms) => {
        this.roomListings = rooms;
        this.isLoading = false;
      },
      (error) => {
        this.error = 'Failed to load room listings';
        this.isLoading = false;
      }
    );
  }

  ngOnDestroy(): void {
    this.lobbyService.stopAutoRefresh();
  }

  loadRoomListings(): void {
    this.isLoading = true;
    this.error = null;
    this.lobbyService.refreshRoomList();
  }

  async joinRoom(room: RoomListingData): Promise<void> {
    if (!this.canJoinRoom(room)) return;
    if (!this.playerName.value?.trim()) {
      this.error = 'Please enter a player name';
      return;
    }

    try {
      this.isLoading = true;
      await this.gameService.joinRoom(
        room.roomId,
        this.playerName.value.trim()
      );
    } catch (error: any) {
      console.error('Join room error:', error);
      this.error = error?.message || 'Failed to join room';
      this.isLoading = false;
    }
  }

  // UPDATED: Quick Game now respects private setting
  async createRoom(): Promise<void> {
    if (!this.playerName.value?.trim()) {
      this.error = 'Please enter a player name';
      return;
    }

    try {
      this.isLoading = true;

      // Create GameSetup for Quick Bot Game: 3 players, 2 bots
      const gameSetup: GameSetup = {
        totalPlayers: 3,
        playerTypes: ['bot', 'bot'], // Players 2 and 3 are bots
        botDifficulty: 'easy', // Default to easy for quick games
        playerName: this.playerName.value.trim(),
        isPrivate: this.isPrivateGame,
      };

      // Always create with bots for Quick Game
      await this.gameService.createRoomWithBots(gameSetup);
    } catch (error: any) {
      console.error('Create room error:', error);
      this.error = error?.message || 'Failed to create room';
      this.isLoading = false;
    }
  }

  // UPDATED: Advanced room creation respects private setting
  async createAdvancedRoom(): Promise<void> {
    if (!this.playerName.value?.trim()) {
      this.error = 'Please enter a player name';
      return;
    }

    try {
      this.isLoading = true;

      const gameSetup: GameSetup = {
        totalPlayers: this.totalPlayers,
        playerTypes: this.playerTypes,
        botDifficulty: this.botDifficulty,
        playerName: this.playerName.value.trim(),
        isPrivate: this.isPrivateGame, // ADD THIS
      };

      // Check if any bots are selected
      const hasBots = this.hasAnyBots();

      if (hasBots) {
        // Create room with bot configuration (handles private flag internally)
        await this.gameService.createRoomWithBots(gameSetup);
      } else {
        // Create regular room using unified createRoom method
        await this.gameService.createRoom(
          gameSetup.playerName,
          !this.isPrivateGame, // isPublic = !isPrivate
          this.isPrivateGame
            ? `${gameSetup.playerName}'s Private Game`
            : `${gameSetup.playerName}'s Game`,
          gameSetup.totalPlayers
        );
      }
    } catch (error: any) {
      console.error('Create advanced room error:', error);
      this.error = error?.message || 'Failed to create room';
      this.isLoading = false;
    }
  }

  canJoinRoom(room: RoomListingData): boolean {
    return this.lobbyService.canJoinRoom(room);
  }

  getJoinErrorMessage(room: RoomListingData): string | null {
    return this.lobbyService.getJoinErrorMessage(room);
  }

  // ADDED: Helper method for status class
  getStatusClass(gameStatus: string): string {
    return 'status-' + gameStatus.toLowerCase().replace(/\s+/g, '-');
  }

  generateRandomName(): void {
    const randomNamesDefault = [
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

    const randomNames = [
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

    const randomIndex = Math.floor(Math.random() * randomNames.length);
    const baseName = randomNames[randomIndex];
    const randomNumber = Math.floor(Math.random() * 999) + 1;
    const name = `${baseName}${randomNumber}`;
    this.playerName.setValue(name);
  }

  toggleAdvancedCreation(): void {
    this.showAdvancedCreation = !this.showAdvancedCreation;
  }

  // Helper methods for advanced creation
  setTotalPlayers(count: number): void {
    this.totalPlayers = count;
    // Adjust playerTypes array to match
    this.playerTypes = Array(count - 1).fill('human');
  }

  getPlayerSlots(): number[] {
    return Array.from({ length: this.totalPlayers - 1 }, (_, i) => i + 1);
  }

  setPlayerType(index: number, type: 'human' | 'bot'): void {
    this.playerTypes[index] = type;
  }

  setBotDifficulty(difficulty: 'easy' | 'medium' | 'hard'): void {
    this.botDifficulty = difficulty;
  }

  hasAnyBots(): boolean {
    return this.playerTypes.includes('bot');
  }

  getGameSummary(): string {
    const humanCount = this.playerTypes.filter((t) => t === 'human').length + 1; // +1 for you
    const botCount = this.playerTypes.filter((t) => t === 'bot').length;

    let summary = `${this.totalPlayers} players total: ${humanCount} human${
      humanCount === 1 ? '' : 's'
    }`;
    if (botCount > 0) {
      summary += `, ${botCount} ${this.botDifficulty} bot${
        botCount === 1 ? '' : 's'
      }`;
    }

    if (this.isPrivateGame) {
      summary += ' (Private Game)';
    }

    return summary;
  }

  // HELPER METHOD FOR BETTER ERROR DISPLAY
  getQuickGameDescription(): string {
    if (this.isPrivateGame) {
      return "Create a private 3-player bot game for practice (won't appear in public lobby)";
    }
    return 'Create a 3-player bot game that others can join from the lobby';
  }

  getAdvancedOptionsDescription(): string {
    return 'Configure game settings, add bots, and set privacy options';
  }
}
