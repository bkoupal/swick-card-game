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

  // DEBUG: Log the initial state
  /*console.log('=== PLAYER POSITIONING DEBUG ===');
  console.log('Viewing Player ID:', playerId);
  console.log(
    'All Players:',
    realPlayers.map((p) => p?.displayName || 'Unknown')
  );
  console.log('Viewing Player Position in Array:', viewingPlayerPos);
  console.log('Available Seats:', availableSeats);
  */
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

    // DEBUG: Log each player placement
    /*const clockPosition = [
      '1:30pm',
      '3pm',
      '4:30pm',
      '6pm',
      '7:30pm',
      '9pm',
      '10:30pm',
      '12pm',
    ][availableSeats[seatIndex]];
    console.log(
      `Player ${i} (${realPlayers[i]?.displayName}) -> Index ${availableSeats[seatIndex]} (${clockPosition}), Offset: ${offset}`
    );
    */
  }

  // Ensure indices 6 and 7 are always undefined (spacing positions)
  result[6] = undefined; // 10:30pm - empty for spacing
  result[7] = undefined; // 12pm - old dealer position

  // DEBUG: Log final result
  /*console.log('Final Result Array:');
  result.forEach((player, index) => {
    const clockPosition = [
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
      `Index ${index} (${clockPosition}): ${player?.displayName || '[EMPTY]'}`
    );
  });
  console.log('=== END DEBUG ===');
  */
  return result;
}

/**
 * Given an array of players, positions them so player with playerId is at end of it, and empty space is filled with undefined
 *
 * Example:
 *
 * `[playerId, 1, 2] to [undefined, undefined, 2, 1, playerId]`
 * @param players Array of players
 * @param playerId Id of current player
 * @param tableSize Table size
 * @returns The properly positioned players
 */
/**
 * Mobile positioning - preserves game order while putting viewing player at bottom center
 */
export function placePlayersAtMobileTable(
  players: (Player | undefined)[],
  playerId: string,
  tableSize: number
) {
  // Create result array for 8 positions
  const result = new Array(8).fill(undefined);

  // Filter out undefined players
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

  // Define clockwise positions around the table (excluding positions 0, 2, 6, 7)
  const clockwisePositions = [1, 3, 5, 4]; // clockwise from top-right

  // Place other players in clockwise order relative to viewing player
  let positionIndex = 0;

  for (let i = 0; i < realPlayers.length; i++) {
    if (i === viewingPlayerIndex) {
      continue; // Skip viewing player (already placed)
    }

    if (positionIndex < clockwisePositions.length) {
      result[clockwisePositions[positionIndex]] = realPlayers[i];
      positionIndex++;
    }
  }

  // Add position 6 for LearnerBot3 if we have enough players
  if (realPlayers.length >= 5) {
    // Find the 4th other player (5th total) and put in position 6
    let otherPlayerCount = 0;
    for (let i = 0; i < realPlayers.length; i++) {
      if (i !== viewingPlayerIndex) {
        otherPlayerCount++;
        if (otherPlayerCount === 4) {
          result[6] = realPlayers[i];
          break;
        }
      }
    }
  }

  // Ensure excluded positions stay empty
  result[0] = undefined;
  result[2] = undefined;

  return result;
}
