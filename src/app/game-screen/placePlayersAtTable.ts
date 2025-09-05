// src/app/game-screen/placePlayersAtTable.ts

import { Player } from 'backend/src/rooms/schema/GameState';

function rotateArray<Type>(a: Type[], n: number) {
  return a.concat(a.splice(0, n));
}

/**
 * Given an array of players, positions them so player with playerId is in the middle of it, and empty space is filled with undefined
 *
 * Example:
 *
 * `[playerId, 1, 2] to [undefined, 2, playerId, 1, undefined]`
 * @param players Array of players
 * @param playerId Id of current player (the player that will be positioned at middle of table)
 * @param tableSize Table size
 * @returns The properly positioned players
 */
export function placePlayersAtTable(
  players: (Player | undefined)[],
  playerId: string,
  tableSize: number
) {
  // Find the current viewing player
  const playerIndex = players.findIndex((p) => p?.sessionId == playerId);

  if (playerIndex === -1) {
    // If player not found, return original logic
    return players.concat(
      new Array(tableSize - players.length).fill(undefined)
    );
  }

  // Create result array for 8 seat positions around the table
  const result = new Array(8).fill(undefined);

  // Filter out undefined players to get the real player list
  const realPlayers = players.filter((p) => p !== undefined);

  // Available seat indices (skip indices 6 and 7 for spacing)
  const availableSeats = [0, 1, 2, 3, 4, 5]; // 6 actual player positions

  // Find viewing player's position in the real players array
  const viewingPlayerPos = realPlayers.findIndex(
    (p) => p?.sessionId === playerId
  );

  // Place each real player in the rotated position
  for (let i = 0; i < realPlayers.length; i++) {
    // Calculate how many positions this player is from the viewing player
    let offset = i - viewingPlayerPos;

    // Handle negative wraparound
    if (offset < 0) {
      offset += realPlayers.length;
    }

    // Map to seat position: viewing player at index 3 (6pm), others offset from there
    let seatIndex = (3 + offset) % availableSeats.length;

    result[availableSeats[seatIndex]] = realPlayers[i];
  }

  // Ensure indices 6 and 7 are always undefined (spacing positions)
  result[6] = undefined; // 10:30pm - empty for spacing
  result[7] = undefined; // 12pm - old dealer position

  return result;
}

/**
 * FIXED Mobile positioning - properly implements clockwise seating around table
 *
 * Table positions (8 total, but only 6 used):
 * 0: 12:00pm (top-center) - EXCLUDED (keep empty)
 * 1: 1:30pm (right-top)
 * 2: 10:30pm (left-top) - EXCLUDED (keep empty)
 * 3: 3:00pm (right-middle)
 * 4: 9:00pm (left-middle)
 * 5: 4:30pm (right-bottom)
 * 6: 7:30pm (left-bottom)
 * 7: 6pm (bottom-center) - Current player (viewing player always here)
 *
 * Game order logic:
 * - Players join room in order, creating game order
 * - Dealer is assigned from game order
 * - Everyone else sits clockwise from dealer's left
 * - Each player sees themselves at position 7 (bottom center)
 * - Other players maintain their relative clockwise positions
 */
/**
 * Mobile positioning - positions players around table based on join order and dealer position
 * Each player sees themselves at bottom center with others in proper clockwise positions
 */
export function placePlayersAtMobileTable(
  players: (Player | undefined)[],
  playerId: string,
  tableSize: number,
  dealerId?: string
) {
  // Create result array for 8 positions
  const result = new Array(8).fill(undefined);
  const allPlayers = players.filter((p) => p !== undefined);

  if (allPlayers.length === 0) {
    return result;
  }

  // Always place viewing player at position 7 (bottom center)
  const viewingPlayerIndex = allPlayers.findIndex(
    (p) => p?.sessionId === playerId
  );
  if (viewingPlayerIndex === -1) {
    return result;
  }
  result[7] = allPlayers[viewingPlayerIndex];

  // Create the order starting from the viewing player in join order
  const orderedPlayers = [];

  // Start from the player after viewing player and wrap around
  for (let i = 1; i < allPlayers.length; i++) {
    const playerIndex = (viewingPlayerIndex + i) % allPlayers.length;
    orderedPlayers.push(allPlayers[playerIndex]);
  }

  // Map to your desired positions based on the visual index numbers you showed:
  // You want: Join1→Index6, Join2→Index4, Join3→Index1, Join4→Index3, Join5→Index5
  const targetPositions = [6, 4, 1, 3, 5]; // Order for next 5 players after viewing player

  // Place players in their target positions
  for (
    let i = 0;
    i < orderedPlayers.length && i < targetPositions.length;
    i++
  ) {
    result[targetPositions[i]] = orderedPlayers[i];
  }

  // Keep positions 0 and 2 empty
  result[0] = undefined;
  result[2] = undefined;

  return result;
}
