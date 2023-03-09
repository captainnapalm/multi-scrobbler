import MemorySource from "./MemorySource.js";
import {MopidySourceConfig} from "../common/infrastructure/config/source/mopidy.js";
import {FormatPlayObjectOptions, InternalConfig, PlayObject} from "../common/infrastructure/Atomic.js";
import dayjs from "dayjs";
import Mopidy, {models} from "mopidy";
import {URL} from "url";
import normalizeUrl from 'normalize-url';
import {EventEmitter} from "events";
import pEvent from 'p-event';
import winston from 'winston';
import {RecentlyPlayedOptions} from "./AbstractSource.js";
import request from "superagent";
import {buildTrackString, removeDuplicates} from "../utils.js";
import {SubsonicSource} from "./SubsonicSource.js";

export class MopidySource extends MemorySource {
    declare config: MopidySourceConfig;

    albumBlacklist: string[] = [];

    uriWhitelist: string[] = [];

    uriBlacklist: string[] = [];

    url: URL;

    client: Mopidy;
    clientReady: boolean = false;

    constructor(name: any, config: MopidySourceConfig, internal: InternalConfig, emitter: EventEmitter) {
        const {
            data = {}
        } = config;
        const {
            albumBlacklist = ['Soundcloud'],
            uriWhitelist = [],
            uriBlacklist = [],
            interval = 10,
            maxInterval = 30,
            ...rest
        } = data;
        super('mopidy', name, {...config, data: {interval, maxInterval, ...rest}}, internal, emitter);

        this.albumBlacklist = albumBlacklist.map(x => x.toLocaleLowerCase());
        this.uriWhitelist = uriWhitelist.map(x => x.toLocaleLowerCase());
        this.uriBlacklist = uriBlacklist.map(x => x.toLocaleLowerCase());

        const {
            data: {
                url = 'ws://localhost:6680/mopidy/ws/'
            } = {}
        } = config;
        this.url = MopidySource.parseConnectionUrl(url);
        this.client = new Mopidy({
            autoConnect: false,
            webSocketUrl: this.url.toString(),
            // @ts-ignore
            console: winston.loggers.get('noop')
        });
        this.client.on('state:offline', () => {
            this.logger.verbose('Lost connection to server');
            this.clientReady = false;
        });
        this.client.on('state:online', () => {
            this.logger.verbose('Connected to server');
            this.clientReady = true;
        });
        this.client.on('reconnecting', () => {
            this.logger.verbose('Retrying connection to server...');
        });
        this.canPoll = true;
    }

    static parseConnectionUrl(val: string) {
        const normal = normalizeUrl(val, {removeTrailingSlash: false, normalizeProtocol: true})
        const url = new URL(normal);

        // default WS
        if (url.protocol === 'http:') {
            url.protocol = 'ws';
        } else if (url.protocol === 'https:') {
            url.protocol = 'wss';
        }

        if (url.port === null || url.port === '') {
            url.port = '6680';
        }
        if (url.pathname === '/') {
            url.pathname = '/mopidy/ws/';
        } else if (url.pathname === '/mopidy/ws') {
            url.pathname = '/mopidy/ws/';
        }
        return url;
    }

    initialize = async () => {
        const {
            data: {
                url
            } = {}
        } = this.config;
        this.logger.debug(`Config URL: '${url ?? '(None Given)'}' => Normalized: '${this.url.toString()}'`)

        this.client.connect();
        const res = await Promise.race([
            pEvent(this.client, 'state:online'),
            pEvent(this.client, 'websocket:error'),
            pEvent(this.client, 'websocket:close'),
        ]);
        if (res === undefined) {
            this.logger.info('Connection OK');
            this.initialized = true;
            return true;
        } else {
            this.logger.error(`Could not connect. Error => ${(res as Error).message}`);
            this.client.close();
            return false;
        }
    }

    formatPlayObj(obj: models.Track, options: FormatPlayObjectOptions = {}): PlayObject {
        const {newFromSource = true, trackProgressPosition = undefined} = options;

        const {
            artists: artistsVal,
            album: albumVal,
            name,
            uri, // like 'local:track...' 'soundcloud:song...'
            length: lengthVal,
            composers = [],
            performers = []
        } = obj;

        let artists = artistsVal === null ? [] : artistsVal;
        let album: models.Album = albumVal === null ? {} as models.Album : albumVal;
        if (this.albumBlacklist.length > 0 && album.name !== undefined && this.albumBlacklist.some(x => album.name.toLocaleLowerCase().includes(x))) {
            album = {} as models.Album;
        }
        const length = lengthVal === null ? undefined : lengthVal;

        const {
            name: albumName,
            artists: albumArtists = []
        } = album as models.Album;

        if ((artists.length === 0 || artists.every(x => x.name.toLocaleLowerCase().includes('various'))) && albumArtists.length > 0) {
            artists = albumArtists;
        }
        if (artists.length === 0 && composers.length > 0) {
            artists = composers;
        }
        if (artists.length === 0 && performers.length > 0) {
            artists = performers;
        }

        return {
            data: {
                track: name,
                album: albumName,
                artists: artists.length > 0 ? artists.map(x => x.name) : [],
                duration: Math.round(length / 1000),
                playDate: dayjs()
            },
            meta: {
                source: 'mopidy',
                trackId: uri,
                newFromSource,
                trackProgressPosition: trackProgressPosition !== undefined ? Math.round(trackProgressPosition / 1000) : undefined,
                deviceId: name,
            }
        }
    }

    getRecentlyPlayed = async (options: RecentlyPlayedOptions = {}) => {
        if (!this.clientReady) {
            this.logger.warn('Cannot actively poll since client is not connected.');
            return [];
        }

        const currTrack = await this.client.playback.getCurrentTrack();
        const playback = await this.client.playback.getTimePosition();

        let play: PlayObject | undefined = currTrack === null ? undefined : this.formatPlayObj(currTrack, {trackProgressPosition: playback});

        if(play !== undefined) {
            if (this.uriWhitelist.length > 0) {
                const match = this.uriWhitelist.find(x => currTrack.uri.includes(x));
                if (match === undefined) {
                    this.logger.debug(`URI for currently playing (${currTrack.uri}) did not match any in whitelist. Will not track play ${buildTrackString(play)}`);
                    play = undefined;
                }
            } else if (this.uriBlacklist.length > 0) {
                const match = this.uriWhitelist.find(x => currTrack.uri.includes(x));
                if (match !== undefined) {
                    this.logger.debug(`URI for currently playing (${currTrack.uri}) matched from blacklist (${match}). Will not track play ${buildTrackString(play)}`);
                    play = undefined;
                }
            }
        }

        return this.processRecentPlays(play === undefined ? [] : [play]);
    }

}
