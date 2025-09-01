// src/app/lobby.service.ts - UPDATED with inactive room filtering

import { Injectable } from '@angular/core';
import { GameService } from './game.service';
import * as Colyseus from 'colyseus.js';
import { BehaviorSubject, interval, Subscription } from 'rxjs';

export interface RoomListingData {
  roomId: string;
  name: string;
  clients: number;
  maxClients: number;
  metadata: {
    roomName: string;
    isPublic: boolean;
    allowJoining: boolean;
    currentPlayers: number;
    readyPlayers: number;
    potValue: number;
    gameStatus: string;
    dealerName: string;
    hasActiveSet: boolean;
    lastActivity?: number;
    inactive?: boolean;
  };
  locked: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class LobbyService {
  private roomListings$ = new BehaviorSubject<RoomListingData[]>([]);
  private refreshSubscription?: Subscription;

  constructor(private gameService: GameService) {}

  getRoomListings() {
    return this.roomListings$.asObservable();
  }

  async refreshRoomList(): Promise<void> {
    try {
      const rooms = await this.gameService.client.getAvailableRooms('gameRoom');

      // FILTER OUT INACTIVE ROOMS (older than 15 minutes)
      const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;

      const activePublicRooms = rooms
        .filter((room) => {
          // Only show public rooms
          if (room.metadata?.isPublic !== true) return false;

          // Filter out rooms marked as inactive
          if (room.metadata?.inactive === true) return false;

          // Filter out rooms with no recent activity (fallback check)
          if (
            room.metadata?.lastActivity &&
            room.metadata.lastActivity < fifteenMinutesAgo
          ) {
            return false;
          }

          return true;
        })
        .map((room) => ({
          roomId: room.roomId,
          name: room.metadata?.roomName || `Game ${room.roomId}`,
          clients: room.clients,
          maxClients: room.maxClients,
          metadata: room.metadata || {
            roomName: `Game ${room.roomId}`,
            isPublic: true,
            allowJoining: true,
            currentPlayers: room.clients,
            readyPlayers: 0,
            potValue: 0,
            gameStatus: 'Waiting',
            dealerName: '',
            hasActiveSet: false,
          },
          locked: false,
        }));

      this.roomListings$.next(activePublicRooms);
    } catch (error) {
      console.error('Failed to fetch room listings:', error);
      this.roomListings$.next([]);
    }
  }

  startAutoRefresh(intervalMs: number = 3000): void {
    this.stopAutoRefresh();
    this.refreshSubscription = interval(intervalMs).subscribe(() => {
      this.refreshRoomList();
    });
    // Initial load
    this.refreshRoomList();
  }

  stopAutoRefresh(): void {
    if (this.refreshSubscription) {
      this.refreshSubscription.unsubscribe();
      this.refreshSubscription = undefined;
    }
  }

  canJoinRoom(room: RoomListingData): boolean {
    return (
      room.metadata.allowJoining &&
      !room.locked &&
      room.clients < room.maxClients &&
      !room.metadata.hasActiveSet
    );
  }

  getJoinErrorMessage(room: RoomListingData): string | null {
    if (room.locked) return 'Room is locked';
    if (room.clients >= room.maxClients) return 'Room is full';
    if (room.metadata.hasActiveSet) return 'Cannot join: Player went set';
    if (!room.metadata.allowJoining) return 'Game in progress';
    return null;
  }
}
