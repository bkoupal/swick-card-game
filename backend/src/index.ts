import { Server } from 'colyseus';
import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import { GameRoom } from './rooms/GameRoom';

const app = express();

// Enable CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'https://play.swickcardgame.com',
  })
);

const server = createServer(app);
const gameServer = new Server({ server });

// Define your room
gameServer.define('gameRoom', GameRoom);

const port = parseInt(process.env.PORT || '2567', 10);
const host = '0.0.0.0';

gameServer.listen(port, host);
console.log(`⚔️  Listening on ws://${host}:${port}`);
