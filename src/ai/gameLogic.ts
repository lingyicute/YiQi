import type { BoardState, Player } from './types';

export const getOpponent = (player: Player): Player => (player === 'black' ? 'white' : 'black');
