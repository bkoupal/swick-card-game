import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { LobbyService, RoomListingData } from '../lobby.service';
import { GameService } from '../game.service';
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

  playerName = new FormControl('', [
    Validators.required,
    Validators.minLength(1),
    Validators.maxLength(20),
  ]);

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

  private loadRoomListings(): void {
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
      await this.gameService.createRoom(this.playerName.value.trim());
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

  refreshRoomList(): void {
    this.loadRoomListings();
  }

  public generateRandomName(): void {
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

  trackByRoomId(index: number, room: RoomListingData): string {
    return room.roomId;
  }

  getStatusClass(status: string): string {
    switch (status.toLowerCase()) {
      case 'waiting for players':
        return 'waiting';
      case 'setting up':
      case 'players deciding':
      case 'drawing cards':
        return 'setting-up';
      case 'playing tricks':
      case 'hand complete':
        return 'in-progress';
      case 'someone went set!':
        return 'has-set';
      default:
        return 'in-progress';
    }
  }
}
