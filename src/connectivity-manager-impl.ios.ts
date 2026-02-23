import { Common } from "./connectivity-manager-impl.common";
import { ConnectivityManagerInterface } from "./connectivity-manager-interface";

/**
 * It manages the connectivity API of an iOS mobile device.
 * This is especially thought for applications where an app needs to connect to a Wi-Fi AP for P2P communication.
 * It allows also to switch back to a network with internet connection to also to internet requests.
 */
export class ConnectivityManagerImpl
  extends Common
  implements ConnectivityManagerInterface {
  private static readonly POLL_INTERVAL_MS = 200;
  private static readonly SSID_FETCH_TIMEOUT_MS = 1500;
  private static readonly HOTSPOT_RETRY_DELAY_MS = 400;
  private static readonly HOTSPOT_ERROR_INTERNAL = 8;
  private static readonly HOTSPOT_ERROR_PENDING = 9;
  private static readonly HOTSPOT_ERROR_JOIN_ONCE_NOT_SUPPORTED = 12;
  private static readonly HOTSPOT_ERROR_ALREADY_ASSOCIATED = 13;
  private static readonly DIAGNOSTICS_DEFAULT_ENABLED = true;
  private static readonly DIAGNOSTICS_FLAG_KEY = "__APP_CONNECTIVITY_DIAGNOSTICS__";

  private previousSsid: string = undefined;
  private cachedSsid: string | null = null;
  private ssidRefreshInFlight: Promise<string | null> = null;

  private isDiagnosticsEnabled(): boolean {
    try {
      const root: any =
        typeof globalThis !== "undefined"
          ? (globalThis as any)
          : typeof global !== "undefined"
          ? (global as any)
          : {};
      const runtimeFlag = root[ConnectivityManagerImpl.DIAGNOSTICS_FLAG_KEY];
      if (typeof runtimeFlag === "boolean") {
        return runtimeFlag;
      }
    } catch (_) {
      // Fall back to default value.
    }

    return ConnectivityManagerImpl.DIAGNOSTICS_DEFAULT_ENABLED;
  }

  private logConnectivityError(message: string, error?: any): void {
    if (!this.isDiagnosticsEnabled()) {
      return;
    }

    if (error !== undefined) {
      console.error("[ConnectivityManager iOS] " + message, error);
      return;
    }

    console.error("[ConnectivityManager iOS] " + message);
  }

  private getNetworkInfo(): NSDictionary<any, any> {
    try {
      let interfaceNames = <NSArray<string>>CNCopySupportedInterfaces();
      if (!interfaceNames) {
        return null;
      }

      for (let i = 0; i < interfaceNames.count; i++) {
        let info = <NSDictionary<any, any>>(
          CNCopyCurrentNetworkInfo(interfaceNames[i])
        );
        if (!info) {
          continue;
        }
        let ssid = info.valueForKey(kCNNetworkInfoKeySSID);
        if (!ssid) {
          continue;
        }
        return info;
      }

      return null;
    } catch (error) {
      // CaptiveNetwork can fail on simulator and newer SDK/runtime combinations.
      this.logConnectivityError("getNetworkInfo failed.", error);
      return null;
    }
  }

  private normalizeSsid(rawSsid: any): string | null {
    if (rawSsid === null || rawSsid === undefined) {
      return null;
    }

    const normalized = `${rawSsid}`.trim();
    if (!normalized || normalized === "<unknown ssid>") {
      return null;
    }

    if (
      normalized.length >= 2 &&
      normalized.startsWith('"') &&
      normalized.endsWith('"')
    ) {
      return normalized.substring(1, normalized.length - 1);
    }

    return normalized;
  }

  private getSsidFromCaptiveNetwork(): string | null {
    const info = this.getNetworkInfo();
    const ssid = info ? info.valueForKey(kCNNetworkInfoKeySSID) : null;
    return this.normalizeSsid(ssid);
  }

  private getSsidFromCaptiveNetworkSafe(): string | null {
    try {
      return this.getSsidFromCaptiveNetwork();
    } catch (error) {
      this.logConnectivityError("getSsidFromCaptiveNetworkSafe failed.", error);
      return null;
    }
  }

  private getSsidFromHotspotNetwork(network: any): string | null {
    if (!network) {
      return null;
    }

    // NativeScript iOS runtime exposes this property as SSID (uppercase).
    return this.normalizeSsid(network.SSID ?? network.ssid ?? null);
  }

  private getHotspotErrorCode(err: NSError): number {
    return err ? Number(err.code) : -1;
  }

  private isRecoverableHotspotConfigurationError(err: NSError): boolean {
    const code = this.getHotspotErrorCode(err);
    return (
      code === ConnectivityManagerImpl.HOTSPOT_ERROR_ALREADY_ASSOCIATED ||
      code === ConnectivityManagerImpl.HOTSPOT_ERROR_PENDING ||
      code === ConnectivityManagerImpl.HOTSPOT_ERROR_INTERNAL
    );
  }

  private canRetryAfterConfigurationReset(err: NSError): boolean {
    const code = this.getHotspotErrorCode(err);
    return code === ConnectivityManagerImpl.HOTSPOT_ERROR_INTERNAL;
  }

  private canRetryWithoutJoinOnce(err: NSError): boolean {
    const code = this.getHotspotErrorCode(err);
    return (
      code === ConnectivityManagerImpl.HOTSPOT_ERROR_JOIN_ONCE_NOT_SUPPORTED
    );
  }

  private logHotspotConfigurationError(err: NSError): void {
    if (!err) {
      return;
    }

    this.logConnectivityError(
      "NEHotspotConfiguration error. domain=" +
        err.domain +
        ", code=" +
        err.code +
        ", message=" +
        err.localizedDescription
    );
  }

  private createHotspotConfiguration(
    ssid: string,
    password: string,
    joinOnce: boolean
  ): NEHotspotConfiguration {
    const hotspot = NEHotspotConfiguration.new();
    const configuration = password
      ? hotspot.initWithSSIDPassphraseIsWEP(ssid, password, false)
      : hotspot.initWithSSID(ssid);
    configuration.joinOnce = joinOnce;
    return configuration;
  }

  private applyHotspotConfiguration(
    configuration: NEHotspotConfiguration
  ): Promise<NSError | null> {
    return new Promise((resolve) => {
      NEHotspotConfigurationManager.sharedManager.applyConfigurationCompletionHandler(
        configuration,
        (err) => {
          resolve(err && err instanceof NSError ? err : null);
        }
      );
    });
  }

  private async applyHotspotConfigurationWithFallback(
    ssid: string,
    password: string
  ): Promise<NSError | null> {
    try {
      NEHotspotConfigurationManager.sharedManager.removeConfigurationForSSID(ssid);
    } catch (error) {
      // Best-effort cleanup before a fresh join.
      this.logConnectivityError(
        "removeConfigurationForSSID failed before initial hotspot apply.",
        error
      );
    }

    await this.delay(ConnectivityManagerImpl.HOTSPOT_RETRY_DELAY_MS);

    const initialConfiguration = this.createHotspotConfiguration(
      ssid,
      password,
      true
    );
    const initialError = await this.applyHotspotConfiguration(
      initialConfiguration
    );

    if (!initialError || this.isRecoverableHotspotConfigurationError(initialError)) {
      return initialError;
    }

    if (this.canRetryWithoutJoinOnce(initialError)) {
      const fallbackConfiguration = this.createHotspotConfiguration(
        ssid,
        password,
        false
      );
      const fallbackError = await this.applyHotspotConfiguration(
        fallbackConfiguration
      );

      if (
        fallbackError &&
        this.canRetryAfterConfigurationReset(fallbackError)
      ) {
        return this.applyHotspotConfigurationAfterReset(ssid, password);
      }

      return fallbackError;
    }

    if (this.canRetryAfterConfigurationReset(initialError)) {
      return this.applyHotspotConfigurationAfterReset(ssid, password);
    }

    return initialError;
  }

  private applyPersistentHotspotConfiguration(
    ssid: string,
    password: string
  ): Promise<NSError | null> {
    const persistentConfiguration = this.createHotspotConfiguration(
      ssid,
      password,
      false
    );
    return this.applyHotspotConfiguration(persistentConfiguration);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  private async applyHotspotConfigurationAfterReset(
    ssid: string,
    password: string
  ): Promise<NSError | null> {
    try {
      NEHotspotConfigurationManager.sharedManager.removeConfigurationForSSID(ssid);
    } catch (error) {
      // Best-effort cleanup.
      this.logConnectivityError(
        "removeConfigurationForSSID failed before reset retry apply.",
        error
      );
    }

    await this.delay(ConnectivityManagerImpl.HOTSPOT_RETRY_DELAY_MS);
    return this.applyPersistentHotspotConfiguration(ssid, password);
  }

  private fetchCurrentSsid(): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle = setTimeout(() => {
        finish(this.getSsidFromCaptiveNetworkSafe());
      }, ConnectivityManagerImpl.SSID_FETCH_TIMEOUT_MS);

      const finish = (ssid: string | null) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        resolve(ssid);
      };

      const finishWithFallback = () => {
        finish(this.getSsidFromCaptiveNetworkSafe());
      };

      try {
        const hotspotNetwork = NEHotspotNetwork as any;

        if (
          hotspotNetwork &&
          typeof hotspotNetwork.fetchCurrentWithCompletionHandler === "function"
        ) {
          hotspotNetwork.fetchCurrentWithCompletionHandler((network) => {
            const ssid = this.getSsidFromHotspotNetwork(network);
            if (ssid) {
              finish(ssid);
              return;
            }

            // Best-effort fallback for older runtime combinations.
            finishWithFallback();
          });
          return;
        }
      } catch (error) {
        // Keep this method best-effort and never throw.
        this.logConnectivityError("fetchCurrentSsid failed while reading hotspot network.", error);
      }

      finishWithFallback();
    });
  }

  private waitUntil(
    checkFn: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs = 200
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
      const safeIntervalMs = Math.max(50, Number(intervalMs) || 200);
      const startedAt = Date.now();
      let done = false;
      let loopErrorLogged = false;

      const finish = (result: boolean) => {
        if (done) {
          return;
        }
        done = true;
        resolve(result);
      };

      const loop = () => {
        if (done) {
          return;
        }

        Promise.resolve()
          .then(() => checkFn())
          .then((result) => {
            if (result) {
              finish(true);
              return;
            }

            if (Date.now() - startedAt >= safeTimeoutMs) {
              finish(false);
              return;
            }

            setTimeout(loop, safeIntervalMs);
          })
          .catch((error) => {
            if (!loopErrorLogged) {
              loopErrorLogged = true;
              this.logConnectivityError("waitUntil checkFn rejected.", error);
            }
            if (Date.now() - startedAt >= safeTimeoutMs) {
              finish(false);
              return;
            }

            setTimeout(loop, safeIntervalMs);
          });
      };

      loop();
    });
  }

  private refreshCachedSsidInBackground(): void {
    if (this.ssidRefreshInFlight) {
      return;
    }

    this.ssidRefreshInFlight = this.fetchCurrentSsid().then(
      (ssid) => {
        this.cachedSsid = ssid;
        this.ssidRefreshInFlight = null;
        return ssid;
      },
      () => {
        this.ssidRefreshInFlight = null;
        return this.cachedSsid;
      }
    );
  }

  public getSSID(): string {
    this.refreshCachedSsidInBackground();

    if (this.cachedSsid) {
      return this.cachedSsid;
    }

    const fallbackSsid = this.getSsidFromCaptiveNetwork();
    this.cachedSsid = fallbackSsid;
    return fallbackSsid;
  }

  public getSSIDAsync(): Promise<string | null> {
    const fastPathSsid = this.getSsidFromCaptiveNetworkSafe();
    if (fastPathSsid) {
      this.cachedSsid = fastPathSsid;
      return Promise.resolve(fastPathSsid);
    }

    return this.fetchCurrentSsid().then((ssid) => {
      this.cachedSsid = ssid;
      return ssid;
    });
  }

  public getWifiNetworkId(): number {
    const info = this.getNetworkInfo();
    return info ? info.valueForKey(kCNNetworkInfoKeyBSSID) : null;
  }

  public isWifiEnabled(): boolean {
    // Not implemented yet
    return undefined;
  }

  public isWifiConnected(): boolean {
    // Not implemented yet
    return undefined;
  }

  public isCellularEnabled(): boolean {
    // Not implemented yet
    return undefined;
  }

  public isCellularConnected(): boolean {
    // Not implemented yet
    return undefined;
  }

  public isGpsEnabled(): boolean {
    // Not implemented yet
    return undefined;
  }

  public isGpsConnected(): boolean {
    // Not implemented yet
    return undefined;
  }

  public hasInternet(): boolean {
    //Not implemented yet
    return undefined;
  }

  public scanWifiNetworks(): Promise<string[]> {
    // Not implemented yet
    return undefined;
  }

  public connectToWifiNetwork(
    ssid: string,
    password: string,
    milliseconds: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const expectedSsid = this.normalizeSsid(ssid);
      if (!expectedSsid) {
        resolve(false);
        return;
      }

      const safeTimeoutMs = Math.max(0, Number(milliseconds) || 0);
      const startedAt = Date.now();
      const getRemainingTimeout = () =>
        Math.max(0, safeTimeoutMs - (Date.now() - startedAt));
      const getTimeoutSlice = (preferredMs: number) =>
        Math.max(
          0,
          Math.min(Math.max(0, Number(preferredMs) || 0), getRemainingTimeout())
        );
      const observedSsids = new Set<string>();

      this.getSSIDAsync()
        .then((initialSsidRaw) => this.normalizeSsid(initialSsidRaw))
        .then(async (initialSsid) => {
          if (initialSsid) {
            observedSsids.add(initialSsid);
          }

          if (initialSsid === expectedSsid) {
            this.previousSsid = expectedSsid;
            this.cachedSsid = expectedSsid;
            resolve(true);
            return;
          }

          return this.applyHotspotConfigurationWithFallback(expectedSsid, password)
            .then(async (err) => {
              let initialError = err;
              if (initialError && this.canRetryAfterConfigurationReset(initialError)) {
                initialError = await this.applyHotspotConfigurationAfterReset(
                  expectedSsid,
                  password
                );
              }

              if (
                initialError &&
                !this.isRecoverableHotspotConfigurationError(initialError)
              ) {
                this.logHotspotConfigurationError(initialError);
                resolve(false);
                return;
              }

              if (initialError) {
                this.logHotspotConfigurationError(initialError);
              }

              let connected = await this.waitUntil(async () => {
                const currentSsid = this.normalizeSsid(await this.getSSIDAsync());
                if (currentSsid) {
                  observedSsids.add(currentSsid);
                }
                return currentSsid === expectedSsid;
              }, getTimeoutSlice(15000), ConnectivityManagerImpl.POLL_INTERVAL_MS);

              if (!connected && getRemainingTimeout() > 0) {
                let persistentError = await this.applyPersistentHotspotConfiguration(
                  expectedSsid,
                  password
                );

                if (
                  persistentError &&
                  this.canRetryAfterConfigurationReset(persistentError)
                ) {
                  persistentError = await this.applyHotspotConfigurationAfterReset(
                    expectedSsid,
                    password
                  );
                }

                if (
                  persistentError &&
                  !this.isRecoverableHotspotConfigurationError(persistentError)
                ) {
                  this.logHotspotConfigurationError(persistentError);
                  resolve(false);
                  return;
                }

                if (persistentError) {
                  this.logHotspotConfigurationError(persistentError);
                }

                connected = await this.waitUntil(async () => {
                  const currentSsid = this.normalizeSsid(await this.getSSIDAsync());
                  if (currentSsid) {
                    observedSsids.add(currentSsid);
                  }
                  return currentSsid === expectedSsid;
                }, getTimeoutSlice(15000), ConnectivityManagerImpl.POLL_INTERVAL_MS);
              }

              if (!connected && getRemainingTimeout() > 0) {
                const resetRetryError = await this.applyHotspotConfigurationAfterReset(
                  expectedSsid,
                  password
                );
                if (
                  resetRetryError &&
                  !this.isRecoverableHotspotConfigurationError(resetRetryError)
                ) {
                  this.logHotspotConfigurationError(resetRetryError);
                  resolve(false);
                  return;
                }

                if (resetRetryError) {
                  this.logHotspotConfigurationError(resetRetryError);
                }

                connected = await this.waitUntil(async () => {
                  const currentSsid = this.normalizeSsid(await this.getSSIDAsync());
                  if (currentSsid) {
                    observedSsids.add(currentSsid);
                  }
                  return currentSsid === expectedSsid;
                }, getRemainingTimeout(), ConnectivityManagerImpl.POLL_INTERVAL_MS);
              }

              if (connected) {
                this.previousSsid = expectedSsid;
                this.cachedSsid = expectedSsid;
              } else {
                const observed = Array.from(observedSsids.values());
                const observedLog = observed.length
                  ? observed.join(", ")
                  : "(none)";
                this.logConnectivityError(
                  "Timed out while waiting to connect to SSID '" +
                    expectedSsid +
                    "'. Observed SSIDs: " +
                    observedLog
                );
              }

              resolve(connected);
            })
            .catch((error) => {
              this.logConnectivityError("connectToWifiNetwork failed with unhandled error.", error);
              resolve(false);
            });
        })
        .catch((error) => {
          this.logConnectivityError("connectToWifiNetwork failed before hotspot apply.", error);
          resolve(false);
        });
    });
  }

  public disconnectWifiNetwork(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const ssidToDisconnect = this.normalizeSsid(this.previousSsid);
      if (!ssidToDisconnect) {
        resolve(true);
        return;
      }

      NEHotspotConfigurationManager.sharedManager.removeConfigurationForSSID(
        ssidToDisconnect
      );

      this.waitUntil(async () => {
        const currentSsid = await this.getSSIDAsync();
        return currentSsid !== ssidToDisconnect;
      }, timeoutMs, ConnectivityManagerImpl.POLL_INTERVAL_MS).then((disconnected) => {
        if (disconnected && this.previousSsid === ssidToDisconnect) {
          this.previousSsid = undefined;
          this.cachedSsid = null;
        } else if (!disconnected) {
          this.logConnectivityError(
            "Timed out while waiting to disconnect from SSID '" +
              ssidToDisconnect +
              "'."
          );
        }

        resolve(disconnected);
      });
    });
  }
}
