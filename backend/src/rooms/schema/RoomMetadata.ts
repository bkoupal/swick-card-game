import { Schema, type } from '@colyseus/schema';

export class RoomMetadata extends Schema {
  @type('string') roomName: string = 'SWICK Game';
  @type('boolean') isPublic: boolean = true;
  @type('boolean') allowJoining: boolean = true;
  @type('number') maxPlayers: number = 6;
  @type('number') currentPlayers: number = 0;
  @type('number') readyPlayers: number = 0;
  @type('number') potValue: number = 0;
  @type('string') gameStatus: string = 'Waiting'; // Waiting, In Progress, Setting Up
  @type('string') dealerName: string = '';
  @type('boolean') hasActiveSet: boolean = false; // True if any player is set
}
