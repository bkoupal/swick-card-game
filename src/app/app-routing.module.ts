import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { GameScreenComponent } from './game-screen/game-screen.component';
import { GameGuardService } from './game-screen/game-guard.service';
import { JoinScreenComponent } from './join-screen/join-screen.component';
import { JoinGuardService } from './join-screen/join-guard.service';
import { LobbyComponent } from './lobby/lobby.component';
import { RulesComponent } from './rules/rules.component';

const routes: Routes = [
  {
    path: 'room/:id',
    component: GameScreenComponent,
    canActivate: [GameGuardService],
  },
  {
    path: 'lobby',
    component: LobbyComponent,
    pathMatch: 'full',
  },
  {
    path: 'join',
    component: JoinScreenComponent,
    canActivate: [JoinGuardService],
  },
  {
    path: '',
    redirectTo: '/lobby',
    pathMatch: 'full',
  },
  { path: 'rules', component: RulesComponent },
  { path: '**', redirectTo: '/lobby' },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
