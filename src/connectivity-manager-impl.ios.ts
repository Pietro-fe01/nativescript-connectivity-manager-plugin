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
  private static readonly HOTSPOT_ERROR_PENDING = 9;
  private static readonly HOTSPOT_ERROR_JOIN_ONCE_NOT_SUPPORTED = 12;
  private static readonly HOTSPOT_ERROR_ALREADY_ASSOCIATED = 13;

  private previousSsid: string = undefined;
  private cachedSsid: string | null = null;
  private ssidRefreshInFlight: Promise<string | null> = null;

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
    } catch (_) {
      // CaptiveNetwork can fail on simulator and newer SDK/runtime combinations.
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
    } catch (_) {
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
      code === ConnectivityManagerImpl.HOTSPOT_ERROR_PENDING
    );
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

    console.log(
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

    if (!this.canRetryWithoutJoinOnce(initialError)) {
      return initialError;
    }

    const fallbackConfiguration = this.createHotspotConfiguration(
      ssid,
      password,
      false
    );
    return this.applyHotspotConfiguration(fallbackConfiguration);
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
      } catch (_) {
        // Keep this method best-effort and never throw.
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
          .catch(() => {
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

      this.applyHotspotConfigurationWithFallback(expectedSsid, password)
        .then(async (err) => {
          if (err && !this.isRecoverableHotspotConfigurationError(err)) {
            this.logHotspotConfigurationError(err);
            resolve(false);
            return;
          }

          const connected = await this.waitUntil(async () => {
            const currentSsid = await this.getSSIDAsync();
            return currentSsid === expectedSsid;
          }, milliseconds, ConnectivityManagerImpl.POLL_INTERVAL_MS);

          if (connected) {
            this.previousSsid = expectedSsid;
          } else {
            console.log(
              "Timed out while waiting to connect to SSID '" + expectedSsid + "'."
            );
          }

          resolve(connected);
        })
        .catch(() => {
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
          console.log(
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
