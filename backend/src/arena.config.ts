import Arena from '@colyseus/arena';
import { GameRoom } from './rooms/GameRoom';

export default Arena({
  options: {
    greet: false,
  },

  getId: () => 'swick-card-game',

  initializeGameServer: (gameServer) => {
    gameServer.define('gameRoom', GameRoom);
  },
});
