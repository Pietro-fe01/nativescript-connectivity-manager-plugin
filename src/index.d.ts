import {Common} from './connectivity-manager-impl.common';

/**
 *
 */
export declare class ConnectivityManagerImpl extends Common {

    getSSID(): string;

    getSSIDAsync(): Promise<string | null>;

    getWifiNetworkId(): number;

    isWifiConnected(): boolean;

    isCellularConnected(): boolean;

    isWifiEnabled(): boolean;

    isCellularEnabled(): boolean;

    isGpsEnabled(): boolean;

    isGpsConnected(): boolean;

    hasInternet(): boolean;

    scanWifiNetworks(): Promise<string[]>;

    connectToWifiNetwork(ssid: string, password: string, milliseconds: number): Promise<boolean>;

    disconnectWifiNetwork(timeoutMs: number): Promise<boolean>;
}
