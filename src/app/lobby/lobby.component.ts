// src/app/lobby/lobby.component.ts
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

  constructor(
    private lobbyService: LobbyService,
    private gameService: GameService,
    private router: Router
  ) {
    // Auto-generate initial random name
    this.generateRandomName();
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
    } catch (error) {
      this.error = 'Failed to join room';
      this.isLoading = false;
    }
  }

  async createRoom(): Promise<void> {
    if (!this.playerName.value?.trim()) {
      this.error = 'Please enter a player name';
      return;
    }

    try {
      this.isLoading = true;
      await this.gameService.createPublicRoom(
        this.playerName.value.trim(),
        `${this.playerName.value.trim()}'s Game`
      );
    } catch (error) {
      this.error = 'Failed to create room';
      this.isLoading = false;
    }
  }

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
      };

      // Check if any bots are selected
      const hasBots = this.hasAnyBots();

      if (hasBots) {
        // Create room with bot configuration
        await this.gameService.createRoomWithBots(gameSetup);
      } else {
        // Create regular public room
        await this.gameService.createPublicRoom(
          gameSetup.playerName,
          `${gameSetup.playerName}'s Game`
        );
      }
    } catch (error) {
      this.error = 'Failed to create room';
      this.isLoading = false;
    }
  }

  canJoinRoom(room: RoomListingData): boolean {
    return this.lobbyService.canJoinRoom(room);
  }

  getJoinErrorMessage(room: RoomListingData): string | null {
    return this.lobbyService.getJoinErrorMessage(room);
  }

  generateRandomName(): void {
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
    const name = `${baseName}${randomNumber}`;
    this.playerName.setValue(name);
  }

  toggleAdvancedCreation(): void {
    this.showAdvancedCreation = !this.showAdvancedCreation;
  }

  // Advanced game creation methods
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
}
