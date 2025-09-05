// 1. First, update the PlayingCardComponent to accept trump card info

// UPDATE: src/app/game-screen/player/playing-card/playing-card.component.ts
import {
  Component,
  HostBinding,
  Input,
  Output,
  EventEmitter,
} from '@angular/core';
import { Card } from 'backend/src/rooms/schema/GameState';
import {
  trigger,
  state,
  style,
  animate,
  transition,
  group,
  query,
  animateChild,
} from '@angular/animations';

@Component({
  selector: 'app-card',
  templateUrl: './playing-card.component.html',
  styleUrls: ['./playing-card.component.scss'],
  animations: [
    trigger('enterLeaveAnimation', [
      transition(':enter', [
        style({
          transform:
            'translate(var(--card-translation-x),var(--card-translation-y))',
          opacity: 0,
        }),
        group([
          query('@hiddenVisible', animateChild()),
          animate('500ms', style({ transform: 'translate(0,0)', opacity: 1 })),
        ]),
      ]),
      transition(':leave', [
        group([
          query('@hiddenVisible', animateChild()),
          animate(
            '500ms',
            style({
              transform:
                'translate(var(--card-translation-x),var(--card-translation-y))',
              opacity: 0,
            })
          ),
        ]),
      ]),
    ]),
    trigger('hiddenVisible', [
      state(
        'true',
        style({
          transform: 'rotateY(180deg)',
        })
      ),
      state(
        'false',
        style({
          transform: 'rotateY(0deg)',
        })
      ),
      transition('* => *', [animate('700ms')]),
    ]),
  ],
})
export class PlayingCardComponent {
  @HostBinding('@enterLeaveAnimation') enterLeaveAnimation = true;
  @Input() card: Card;

  @Input() isClickable: boolean = false;
  @Output() cardClick = new EventEmitter<void>();

  // NEW: Trump card identification inputs
  @Input() isTrumpCard: boolean = false;
  @Input() trumpSuit: string = '';
  @Input() dealerKeptThisCard: boolean = false;

  onCardClick() {
    if (this.isClickable) {
      this.cardClick.emit();
    }
  }

  get isTrumpSuit(): boolean {
    return this.card?.value?.suit === this.trumpSuit;
  }

  get showTrumpIndicator(): boolean {
    return this.dealerKeptThisCard || (this.isTrumpCard && this.card.visible);
  }
}
