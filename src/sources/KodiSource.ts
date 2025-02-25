import MemorySource from "./MemorySource.js";
import {FormatPlayObjectOptions, InternalConfig, PlayObject} from "../common/infrastructure/Atomic.js";
import {EventEmitter} from "events";
import {RecentlyPlayedOptions} from "./AbstractSource.js";
import {KodiSourceConfig} from "../common/infrastructure/config/source/kodi.js";
import {KodiApiClient} from "../apis/KodiApiClient.js";

export class KodiSource extends MemorySource {
    declare config: KodiSourceConfig;

    client: KodiApiClient;
    clientReady: boolean = false;

    constructor(name: any, config: KodiSourceConfig, internal: InternalConfig, emitter: EventEmitter) {
        const {
            data,
        } = config;
        const {
            interval = 10,
            maxInterval = 30,
            ...rest
        } = data || {};
        super('kodi', name, {...config, data: {interval, maxInterval, ...rest}}, internal, emitter);

        this.client = new KodiApiClient(name, data);
        this.requiresAuth = true;
        this.canPoll = true;
        this.multiPlatform = true;
    }

    initialize = async () => {
        const {
            data: {
                url
            } = {}
        } = this.config;
        this.logger.debug(`Config URL: '${url ?? '(None Given)'}' => Normalized: '${this.client.url.toString()}'`)
        this.initialized = true;
        return true;

        /*const connected = await this.client.testConnection();
        if(connected) {
            //this.logger.info('Connection OK');
            this.initialized = true;
            return true;
        } else {
            this.logger.error(`Could not connect.`);
            this.initialized = false;
            return false;
        }*/
    }

    testAuth = async () => {
        const resp = await this.client.testAuth();
        this.authed = resp;
        this.clientReady = this.authed;
        return this.authed;
    }

    static formatPlayObj(obj: any, options: FormatPlayObjectOptions = {}): PlayObject {
        return KodiApiClient.formatPlayObj(obj, options);
    }

    getRecentlyPlayed = async (options: RecentlyPlayedOptions = {}) => {
        if (!this.clientReady) {
            this.logger.warn('Cannot actively poll since client is not connected.');
            return [];
        }

        let play = await this.client.getRecentlyPlayed(options);

        return this.processRecentPlays(play);
    }

}
