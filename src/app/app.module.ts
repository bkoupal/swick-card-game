import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { PlayingCardComponent } from './game-screen/player/playing-card/playing-card.component';
import { TimestampProgressBar } from './game-screen/player/timestamp-progress-bar/timestamp-progress-bar.component';
import { PlayerActionsComponent } from './game-screen/player-action/player-action.component';
import { GameScreenComponent } from './game-screen/game-screen.component';
import { JoinScreenComponent } from './join-screen/join-screen.component';
import { PlayerComponent } from './game-screen/player/player.component';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MoneyCounterComponent } from './game-screen/player/money-counter/money-counter.component';
import { KickDialogComponent } from './kick-dialog/kick-dialog.component';
import { MatDialogModule } from '@angular/material/dialog';
import { InputConstrainDirective } from './game-screen/player-action/input-constrain.directive';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ClipboardModule } from '@angular/cdk/clipboard';
import { ReactiveFormsModule } from '@angular/forms';
import { NotifierModule } from 'angular-notifier';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { LayoutModule } from '@angular/cdk/layout';
import { LobbyComponent } from './lobby/lobby.component';
import { GameService } from './game.service';
import { LobbyService } from './lobby.service';
import { MatChipsModule } from '@angular/material/chips';
import { RulesComponent } from './rules/rules.component';

@NgModule({
  declarations: [
    AppComponent,
    PlayingCardComponent,
    TimestampProgressBar,
    PlayerActionsComponent,
    GameScreenComponent,
    JoinScreenComponent,
    PlayerComponent,
    MoneyCounterComponent,
    KickDialogComponent,
    InputConstrainDirective,
    LobbyComponent,
    RulesComponent,
  ],
  imports: [
    CommonModule,
    RouterModule.forRoot([]), // Add your routes here
    BrowserModule,
    AppRoutingModule,
    BrowserAnimationsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatDialogModule,
    MatIconModule,
    MatChipsModule,
    MatTooltipModule,
    ClipboardModule,
    ReactiveFormsModule,
    MatCheckboxModule,
    LayoutModule,
    MatSlideToggleModule,
    NotifierModule.withConfig({
      position: {
        horizontal: { position: 'right' },
        vertical: {
          position: 'top',
        },
      },
    }),
  ],
  providers: [GameService, LobbyService],
  bootstrap: [AppComponent],
})
export class AppModule {}
