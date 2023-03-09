import {CommonSourceConfig, CommonSourceData} from "./index.js";

export interface JellyData extends CommonSourceData {
    /**
     * optional list of users to scrobble tracks from
     *
     * If none are provided tracks from all users will be scrobbled
     *
     * @examples [["MyUser1","MyUser2"]]
     * */
    users?: string | string[]
    /**
     * optional list of servers to scrobble tracks from
     *
     * If none are provided tracks from all servers will be scrobbled
     *
     * @examples [["MyServerName1"]]
     * */
    servers?: string | string[]

    /**
     * Additional options for jellyfin logging and tuning
     * */
    options?: {
        /**
         * Log raw Jellyfin webhook payload to debug
         *
         * @default false
         * @examples [false]
         * */
        logPayload?: boolean
    }
}

export interface JellySourceConfig extends CommonSourceConfig {
    data: JellyData
}

export interface JellySourceAIOConfig extends JellySourceConfig {
    type: 'jellyfin'
}
