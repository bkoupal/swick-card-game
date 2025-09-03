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
 * 0: 1:30pm (top-right) - EXCLUDED (keep empty)
 * 1: 3pm (right-top)
 * 2: 4:30pm (right-bottom) - EXCLUDED (keep empty)
 * 3: 6pm (bottom-right)
 * 4: 7:30pm (bottom-left)
 * 5: 9pm (left-bottom)
 * 6: 10:30pm (left-top) - Available for 6th player
 * 7: 12pm (top-center) - Current player (viewing player always here)
 *
 * Game order logic:
 * - Players join room in order, creating game order
 * - Dealer is assigned from game order
 * - Everyone else sits clockwise from dealer's left
 * - Each player sees themselves at position 7 (bottom center)
 * - Other players maintain their relative clockwise positions
 */
export function placePlayersAtMobileTable(
  players: (Player | undefined)[],
  playerId: string,
  tableSize: number
) {
  // Create result array for 8 positions
  const result = new Array(8).fill(undefined);

  // Filter out undefined players to get actual players list
  const realPlayers = players.filter((p) => p !== undefined);

  if (realPlayers.length === 0) {
    return result;
  }

  // Find the viewing player
  const viewingPlayerIndex = realPlayers.findIndex(
    (p) => p?.sessionId === playerId
  );

  if (viewingPlayerIndex === -1) {
    // Fallback if viewing player not found
    return players.concat(
      new Array(tableSize - players.length).fill(undefined)
    );
  }

  // ALWAYS place viewing player at position 7 (bottom center)
  result[7] = realPlayers[viewingPlayerIndex];

  // Define available positions for other players (excluding positions 0, 2, and 7)
  // These positions go clockwise around the table
  const availablePositions = [1, 3, 4, 5, 6]; // max 5 other players besides viewing player

  // Place other players in their relative positions
  // We need to maintain the game order (clockwise from dealer's perspective)
  let positionIndex = 0;

  for (
    let i = 0;
    i < realPlayers.length && positionIndex < availablePositions.length;
    i++
  ) {
    if (i === viewingPlayerIndex) {
      continue; // Skip viewing player (already placed at position 7)
    }

    // Calculate the relative position from viewing player
    // In the original game order, find where this player sits relative to viewing player
    let relativePosition = i - viewingPlayerIndex;

    // Handle wraparound for clockwise positioning
    if (relativePosition < 0) {
      relativePosition += realPlayers.length;
    }

    // Map relative position to available table positions
    // Start from position 1 (3pm) and go clockwise
    const targetPosition =
      availablePositions[(relativePosition - 1) % availablePositions.length];
    result[targetPosition] = realPlayers[i];
  }

  // Ensure excluded positions stay empty (keep top-left quadrant clear)
  result[0] = undefined; // 1:30pm - always empty
  result[2] = undefined; // 4:30pm - always empty

  return result;
}

/**
 * Alternative implementation for debugging - shows exact order preservation
 */
export function placePlayersAtMobileTableDebug(
  players: (Player | undefined)[],
  playerId: string,
  tableSize: number
) {
  console.log('=== MOBILE PLAYER POSITIONING DEBUG ===');

  const result = new Array(8).fill(undefined);
  const realPlayers = players.filter((p) => p !== undefined);

  console.log(
    'Original players array:',
    realPlayers.map((p) => p?.displayName)
  );

  if (realPlayers.length === 0) {
    return result;
  }

  const viewingPlayerIndex = realPlayers.findIndex(
    (p) => p?.sessionId === playerId
  );

  console.log('Viewing player:', realPlayers[viewingPlayerIndex]?.displayName);
  console.log('Viewing player index in original array:', viewingPlayerIndex);

  if (viewingPlayerIndex === -1) {
    console.log('Viewing player not found!');
    return players.concat(
      new Array(tableSize - players.length).fill(undefined)
    );
  }

  // Place viewing player at bottom center (position 7)
  result[7] = realPlayers[viewingPlayerIndex];
  console.log('Placed viewing player at position 7');

  // Available positions clockwise from top-right
  const positions = [1, 3, 4, 5, 6]; // Skip 0, 2, 7
  let posIndex = 0;

  // Place other players maintaining game order
  for (let i = 0; i < realPlayers.length && posIndex < positions.length; i++) {
    if (i === viewingPlayerIndex) continue;

    result[positions[posIndex]] = realPlayers[i];
    console.log(
      `Placed ${realPlayers[i]?.displayName} at position ${positions[posIndex]}`
    );
    posIndex++;
  }

  // Ensure excluded positions stay empty
  result[0] = undefined;
  result[2] = undefined;

  console.log('Final positioning:');
  result.forEach((player, index) => {
    if (player || index === 7) {
      const clockPos = [
        '1:30pm',
        '3pm',
        '4:30pm',
        '6pm',
        '7:30pm',
        '9pm',
        '10:30pm',
        '12pm',
      ][index];
      console.log(
        `Position ${index} (${clockPos}): ${
          player?.displayName || '[VIEWING PLAYER]'
        }`
      );
    }
  });

  console.log('=== END MOBILE POSITIONING DEBUG ===');
  return result;
}
