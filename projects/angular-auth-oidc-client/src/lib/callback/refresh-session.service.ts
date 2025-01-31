import { Injectable } from '@angular/core';
import { forkJoin, Observable, of, throwError, TimeoutError, timer } from 'rxjs';
import { map, mergeMap, retryWhen, switchMap, take, timeout } from 'rxjs/operators';
import { AuthStateService } from '../authState/auth-state.service';
import { AuthWellKnownService } from '../config/auth-well-known.service';
import { ConfigurationProvider } from '../config/config.provider';
import { CallbackContext } from '../flows/callback-context';
import { FlowsDataService } from '../flows/flows-data.service';
import { RefreshSessionIframeService } from '../iframe/refresh-session-iframe.service';
import { SilentRenewService } from '../iframe/silent-renew.service';
import { LoggerService } from '../logging/logger.service';
import { TokenResponse } from '../tokens/token-response';
import { FlowHelper } from '../utils/flowHelper/flow-helper.service';
import { RefreshSessionRefreshTokenService } from './refresh-session-refresh-token.service';

export const MAX_RETRY_ATTEMPTS = 3;
@Injectable({ providedIn: 'root' })
export class RefreshSessionService {
  constructor(
    private flowHelper: FlowHelper,
    private configurationProvider: ConfigurationProvider,
    private flowsDataService: FlowsDataService,
    private loggerService: LoggerService,
    private silentRenewService: SilentRenewService,
    private authStateService: AuthStateService,
    private authWellKnownService: AuthWellKnownService,
    private refreshSessionIframeService: RefreshSessionIframeService,
    private refreshSessionRefreshTokenService: RefreshSessionRefreshTokenService
  ) {}

  forceRefreshSession(extraCustomParams?: { [key: string]: string | number | boolean }): Observable<TokenResponse | null> {
    if (this.flowHelper.isCurrentFlowCodeFlowWithRefreshTokens()) {
      const { customParamsRefreshToken } = this.configurationProvider.getOpenIDConfiguration();
      const mergedParams = { ...extraCustomParams, ...customParamsRefreshToken };
      return this.startRefreshSession(mergedParams).pipe(
        map(() => {
          const isAuthenticated = this.authStateService.areAuthStorageTokensValid();
          if (isAuthenticated) {
            return {
              idToken: this.authStateService.getIdToken(),
              accessToken: this.authStateService.getAccessToken(),
            };
          }

          return null;
        })
      );
    }

    const { silentRenewTimeoutInSeconds } = this.configurationProvider.getOpenIDConfiguration();
    const timeOutTime = silentRenewTimeoutInSeconds * 1000;

    return forkJoin([
      this.startRefreshSession(extraCustomParams),
      this.silentRenewService.refreshSessionWithIFrameCompleted$.pipe(take(1)),
    ]).pipe(
      timeout(timeOutTime),
      retryWhen(this.timeoutRetryStrategy.bind(this)),
      map(([_, callbackContext]) => {
        const isAuthenticated = this.authStateService.areAuthStorageTokensValid();
        if (isAuthenticated) {
          return {
            idToken: callbackContext?.authResult?.id_token,
            accessToken: callbackContext?.authResult?.access_token,
          };
        }

        return null;
      })
    );
  }

  private startRefreshSession(extraCustomParams?: {
    [key: string]: string | number | boolean;
  }): Observable<boolean | CallbackContext | null> {
    const isSilentRenewRunning = this.flowsDataService.isSilentRenewRunning();
    this.loggerService.logDebug(`Checking: silentRenewRunning: ${isSilentRenewRunning}`);
    const shouldBeExecuted = !isSilentRenewRunning;

    if (!shouldBeExecuted) {
      return of(null);
    }

    const { authWellknownEndpoint } = this.configurationProvider.getOpenIDConfiguration() || {};

    if (!authWellknownEndpoint) {
      this.loggerService.logError('no authwellknownendpoint given!');
      return of(null);
    }

    return this.authWellKnownService.getAuthWellKnownEndPoints(authWellknownEndpoint).pipe(
      switchMap(() => {
        this.flowsDataService.setSilentRenewRunning();

        if (this.flowHelper.isCurrentFlowCodeFlowWithRefreshTokens()) {
          // Refresh Session using Refresh tokens
          return this.refreshSessionRefreshTokenService.refreshSessionWithRefreshTokens(extraCustomParams);
        }

        return this.refreshSessionIframeService.refreshSessionWithIframe(extraCustomParams);
      })
    );
  }

  private timeoutRetryStrategy(errorAttempts: Observable<any>): Observable<number> {
    return errorAttempts.pipe(
      mergeMap((error, index) => {
        const scalingDuration = 1000;
        const currentAttempt = index + 1;

        if (!(error instanceof TimeoutError) || currentAttempt > MAX_RETRY_ATTEMPTS) {
          return throwError(error);
        }

        this.loggerService.logDebug(`forceRefreshSession timeout. Attempt #${currentAttempt}`);

        this.flowsDataService.resetSilentRenewRunning();
        return timer(currentAttempt * scalingDuration);
      })
    );
  }
}
