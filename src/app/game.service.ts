import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import gameConfig from 'backend/src/game.config';
import { GameState } from 'backend/src/rooms/schema/GameState';
import * as Colyseus from 'colyseus.js';
import { Subject } from 'rxjs';
import { environment } from '../environments/environment';

export interface GameSetup {
  totalPlayers: number;
  playerTypes: ('human' | 'bot')[];
  botDifficulty: 'easy' | 'medium' | 'hard';
  playerName: string;
}

@Injectable({
  providedIn: 'root',
})
export class GameService {
  public kickEvent = new Subject<void>();
  public roomErrorEvent = new Subject<string>();
  public joinInProgress = false;
  public connectedBefore = false;

  private _room?: Colyseus.Room<GameState>;
  public pingTimeout?: number;
  public client: Colyseus.Client;

  public get room() {
    return this._room;
  }

  public get roundInProgress() {
    return !!this._room && this._room.state.roundState != 'idle';
  }

  public get roundEndTimestamp() {
    return this._room?.state.currentTurnTimeoutTimestamp || 0;
  }

  public get player() {
    return this._room?.state.players.get(this._room.sessionId);
  }

  public get playersTurn() {
    return (
      !!this._room &&
      this._room.state.currentTurnPlayerId == this._room.sessionId
    );
  }

  constructor(private router: Router) {
    this.client = new Colyseus.Client(environment.gameServer);
  }

  public createRoomWithBots(gameSetup: GameSetup) {
    return this.updateRoom(
      () =>
        this.client.create('gameRoom', {
          playerName: gameSetup.playerName,
          gameSetup: gameSetup,
        }),
      true
    );
  }

  public createRoom(
    playerName: string = 'Player',
    isPublic: boolean = true,
    roomName?: string
  ) {
    return this.updateRoom(
      () =>
        this.client.create('gameRoom', {
          playerName: playerName,
          roomName: roomName || `${playerName}'s Game`,
          isPublic: isPublic,
          maxPlayers: 6,
        }),
      true
    );
  }

  public createPublicRoom(playerName: string = 'Player', roomName?: string) {
    return this.updateRoom(
      () =>
        this.client.create('gameRoom', {
          playerName: playerName,
          roomName: roomName || `${playerName}'s Game`,
          isPublic: true,
          maxPlayers: 6,
        }),
      true
    );
  }

  public joinRoom(id: string, playerName: string = 'Player') {
    return this.updateRoom(
      () =>
        this.client.joinById(id.toUpperCase(), {
          playerName: playerName,
        }),
      true
    );
  }

  /**
   * Given roomId and sessionId tries to reconnect to a room and returns if it was successful
   * @param roomId The roomId
   * @param sessionId The room sessionId
   * @returns True if reconnection was successful, false otherwise
   */
  public async reconnectRoom(roomId?: string, sessionId?: string) {
    if (!roomId) return false;

    //Try to reconnect
    if (sessionId) {
      const connected = await this.updateRoom(() =>
        this.client.reconnect(roomId, sessionId)
      );

      if (connected) return true;
    }

    //Reconnecting was not successful, try to connect, and return if it was successful
    return this.updateRoom(() => this.client.joinById(roomId));
  }

  /**
   * Tries to reconnect to a room whose data was saved in localStorage and returns if it was successful
   * @returns True if reconnection was successful, false otherwise
   */
  public async reconnectSavedRoom() {
    const roomData = this.loadRoomData();

    if (!roomData) return false;

    //Try to reconnect
    return this.updateRoom(
      () => this.client.reconnect(roomData.roomId, roomData.sessionId),
      false,
      true
    );
  }

  public setReadyState(newState: boolean) {
    this.room?.send('ready', newState);
  }

  public setAutoReadyState(newState: boolean) {
    this.room?.send('autoReady', newState);
  }

  public changeBet(change: number) {
    if (!this.player) return;

    this.room?.send('bet', this.player?.bet + change);
  }

  public setBet(newBet: number) {
    if (!newBet) return;
    this.room?.send('bet', newBet);
  }

  public kick(id: string) {
    this.room?.send('kick', id);
  }

  public playCard(cardIndex: number) {
    this.room?.send('playCard', cardIndex);
  }

  // SWICK-specific methods
  public keepTrump(keep: boolean) {
    this.room?.send('keepTrump', keep);
  }

  public knockIn(knockIn: boolean) {
    this.room?.send('knockIn', knockIn);
  }

  public discardDraw() {
    this._room?.send('discardDraw');
  }

  public get isDealer() {
    return this._room?.state.dealerId === this._room?.sessionId;
  }

  public get trumpSelectionPhase() {
    return this._room?.state.roundState === 'trump-selection';
  }

  public playCards() {
    this._room?.send('playCards');
  }

  public selectCard(cardIndex: number) {
    this._room?.send('selectCard', cardIndex);
  }

  public get knockInPhase() {
    return this._room?.state.roundState === 'knock-in';
  }

  public changeName(newName: string) {
    this.room?.send('changeName', newName);
  }

  /**
   * Tries to connect to given room and on success sets up lifecycle hooks
   * @param room The room
   * @param emitErrorEvent If true, on connection error a message is displayed to the user
   * @param deleteRoomDataOnInvalidRoomId If true, on connection error the localStorage room data is deleted
   * @returns If connecting was successful
   */
  public async updateRoom(
    room: () => Promise<Colyseus.Room<GameState>>,
    emitErrorEvent = false,
    deleteRoomDataOnInvalidRoomId = false
  ) {
    if (this.joinInProgress) return false;
    this.joinInProgress = true;

    try {
      this._room = await room();
      // ADD THIS LINE FOR TESTING SPECIAL HANDS:
      (window as any).testRoom = this._room;
    } catch (error: any) {
      //Was not able to connect

      if (emitErrorEvent)
        this.roomErrorEvent.next(this.convertRoomErrorToMessage(error));

      if (
        deleteRoomDataOnInvalidRoomId &&
        error?.code === Colyseus.ErrorCode.MATCHMAKE_INVALID_ROOM_ID
      )
        this.deleteRoomData();

      this.joinInProgress = false;
      return false;
    }

    // Connected

    this.connectedBefore = true;
    this.saveRoomData(this._room);

    this._room.onLeave((code) => {
      this._room = undefined;
      window.clearTimeout(this.pingTimeout);

      if (code == gameConfig.kickCode) this.kickEvent.next();

      // Player was kicked or they consented left, delete saved data
      if (code == gameConfig.kickCode || code == 1000) this.deleteRoomData();

      // Abnormal websocket shutdown
      if (code == 1006) this.roomErrorEvent.next('Lost connection to server');

      this.router.navigate(['/']);
    });

    // Setup connection lost popup
    this.ping();
    this._room.onMessage('ping', () => this.ping());

    this._room.onMessage('everyonePassed', (data) => {
      console.log(
        `Everyone passed - ${data.dealerName} wins ${data.potValue}¢`
      );
      // The UI will automatically update via the schema changes
      // You could add a toast notification here if desired using the notifier service
    });

    this.router.navigate(['/room', this._room.id], {
      queryParams: { session: this._room.sessionId },
    });

    this.joinInProgress = false;
    return true;
  }

  private ping() {
    window.clearTimeout(this.pingTimeout);

    this.pingTimeout = window.setTimeout(() => {
      this.roomErrorEvent.next('No connection to server');
      this.ping();
    }, gameConfig.pingTimeoutThreshold);
  }

  private setupAutomaticReconnection() {
    if (!this._room) return;

    this._room.onLeave((code) => {
      this._room = undefined;
      window.clearTimeout(this.pingTimeout);

      if (code == gameConfig.kickCode) this.kickEvent.next();

      // Player was kicked or they consented left, delete saved data
      if (code == gameConfig.kickCode || code == 1000) this.deleteRoomData();

      // Abnormal websocket shutdown - try to reconnect
      if (code == 1006) {
        this.roomErrorEvent.next('Lost connection to server');

        // NEW: Attempt automatic reconnection for mobile users
        this.attemptReconnection();
      }

      this.router.navigate(['/']);
    });
  }

  // Automatic reconnection method
  private reconnectionAttempts = 0;
  private maxReconnectionAttempts = 3;

  private async attemptReconnection() {
    if (this.reconnectionAttempts >= this.maxReconnectionAttempts) {
      this.roomErrorEvent.next('Unable to reconnect - please refresh');
      return;
    }

    this.reconnectionAttempts++;
    this.roomErrorEvent.next(
      `Reconnecting... (${this.reconnectionAttempts}/${this.maxReconnectionAttempts})`
    );

    // Wait 2 seconds before attempting reconnection
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const roomData = this.loadRoomData();
    if (!roomData) return;

    const reconnected = await this.updateRoom(
      () => this.client.reconnect(roomData.roomId, roomData.sessionId),
      false,
      true
    );

    if (reconnected) {
      this.reconnectionAttempts = 0; // Reset counter on successful reconnection
      this.roomErrorEvent.next('Reconnected successfully!');

      // Clear the success message after 3 seconds
      setTimeout(() => {
        if (this._room) {
          this.roomErrorEvent.next('');
        }
      }, 3000);
    } else {
      // Try again
      this.attemptReconnection();
    }
  }

  // Add mobile-specific optimizations
  private setupMobileOptimizations() {
    // Handle app going to background/foreground on mobile
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this._room) {
        // App came back to foreground, send a ping to check connection
        this._room.send('ping');
      }
    });

    // Handle network changes (WiFi to cellular, etc.)
    window.addEventListener('online', () => {
      if (!this._room) {
        // Connection came back, try to reconnect
        this.attemptReconnection();
      }
    });
  }

  /**
   * Saves room data to localStorage
   */
  private saveRoomData(room: Colyseus.Room) {
    localStorage.setItem('roomId', room.id);
    localStorage.setItem('sessionId', room.sessionId);
  }

  /**
   * Loads room data from localStorage
   */
  private loadRoomData() {
    const roomId = localStorage.getItem('roomId');
    const sessionId = localStorage.getItem('sessionId');

    if (!roomId || !sessionId) return null;

    return { roomId: roomId, sessionId: sessionId };
  }

  /**
   * Deletes room data from localStorage
   */
  private deleteRoomData() {
    localStorage.removeItem('roomId');
    localStorage.removeItem('sessionId');
  }

  private convertRoomErrorToMessage(error: any): string {
    if (error instanceof ProgressEvent) return `Can't connect to server`;

    if (error?.code === gameConfig.roomFullCode) return 'Room is full';
    if (error?.code === Colyseus.ErrorCode.MATCHMAKE_INVALID_ROOM_ID)
      return 'Invalid room ID';

    return 'Internal server error';
  }

  public createTestBot(difficulty: 'easy' | 'medium' | 'hard') {
    if (this._room) {
      this._room.send('admin-create-bot', difficulty);
    }
  }

  public listBots() {
    if (this._room) {
      this._room.send('admin-list-bots');
    }
  }

  public dealerGoSet(goSet: boolean) {
    this.room?.send('dealerGoSet', goSet);
  }
}
