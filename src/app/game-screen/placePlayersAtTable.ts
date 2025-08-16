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
  console.log('=== PLAYER POSITIONING DEBUG ===');
  console.log('Viewing Player ID:', playerId);
  console.log(
    'All Players:',
    realPlayers.map((p) => p?.displayName || 'Unknown')
  );
  console.log('Viewing Player Position in Array:', viewingPlayerPos);
  console.log('Available Seats:', availableSeats);

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
    const clockPosition = [
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
  }

  // Ensure indices 6 and 7 are always undefined (spacing positions)
  result[6] = undefined; // 10:30pm - empty for spacing
  result[7] = undefined; // 12pm - old dealer position

  // DEBUG: Log final result
  console.log('Final Result Array:');
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
export function placePlayersAtMobileTable(
  players: (Player | undefined)[],
  playerId: string,
  tableSize: number
) {
  // Use the same 8-position logic as desktop
  const arrangedPlayers = placePlayersAtTable(players, playerId, tableSize);

  // For mobile, rearrange the 8 positions into a vertical layout
  const result = [];
  for (let i = 0; i < Math.floor(tableSize / 2); i++) {
    result.push(arrangedPlayers.shift());
    result.push(arrangedPlayers.pop());
  }

  result.push(arrangedPlayers.pop());

  return result;
}
