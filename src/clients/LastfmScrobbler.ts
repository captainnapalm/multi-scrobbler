import AbstractScrobbleClient from "./AbstractScrobbleClient.js";
import dayjs from 'dayjs';

import {
    buildTrackString, capitalize,
    playObjDataMatch, removeUndefinedKeys,
    setIntersection, sleep,
    sortByOldestPlayDate,
    truncateStringToLength,
} from "../utils.js";
import LastfmApiClient from "../apis/LastfmApiClient.js";
import {
    FormatPlayObjectOptions,
    INITIALIZING,
    PlayObject,
    TrackStringOptions
} from "../common/infrastructure/Atomic.js";
import {LastfmClientConfig} from "../common/infrastructure/config/client/lastfm.js";
import {TrackScrobbleResponse, UserGetRecentTracksResponse} from "lastfm-node-client";
import {Notifiers} from "../notifier/Notifiers.js";
import {Logger} from "winston";

export default class LastfmScrobbler extends AbstractScrobbleClient {

    api: LastfmApiClient;
    requiresAuth = true;
    requiresAuthInteraction = true;

    declare config: LastfmClientConfig;

    constructor(name: any, config: LastfmClientConfig, options = {}, notifier: Notifiers, logger: Logger) {
        super('lastfm', name, config, notifier, logger);
        // @ts-ignore
        this.api = new LastfmApiClient(name, config.data, options)
    }

    formatPlayObj = (obj: any, options: FormatPlayObjectOptions = {}) => LastfmApiClient.formatPlayObj(obj, options);

    initialize = async () => {
        // @ts-expect-error TS(2322): Type 'number' is not assignable to type 'boolean'.
        this.initialized = INITIALIZING;
        this.initialized = await this.api.initialize();
        return this.initialized;
    }

    testAuth = async () => {
        try {
            this.authed = await this.api.testAuth();
        } catch (e) {
            this.logger.error('Could not successfully communicate with Last.fm API');
            this.logger.error(e);
            this.authed = false;
        }
        return this.authed;
    }

    refreshScrobbles = async () => {
        if (this.refreshEnabled) {
            this.logger.debug('Refreshing recent scrobbles');
            const resp = await this.api.callApi<UserGetRecentTracksResponse>((client: any) => client.userGetRecentTracks({user: this.api.user, limit: 20, extended: true}));
            const {
                recenttracks: {
                    track: list = [],
                }
            } = resp;
            this.recentScrobbles = list.reduce((acc: any, x: any) => {
                try {
                    const formatted = LastfmApiClient.formatPlayObj(x);
                    const {
                        data: {
                            track,
                            playDate,
                        },
                        meta: {
                            mbid,
                            nowPlaying,
                        }
                    } = formatted;
                    if(nowPlaying === true) {
                        // if the track is "now playing" it doesn't get a timestamp so we can't determine when it started playing
                        // and don't want to accidentally count the same track at different timestamps by artificially assigning it 'now' as a timestamp
                        // so we'll just ignore it in the context of recent tracks since really we only want "tracks that have already finished being played" anyway
                        this.logger.debug("Ignoring 'now playing' track returned from Last.fm client", {track, mbid});
                        return acc;
                    } else if(playDate === undefined) {
                        this.logger.warn(`Last.fm recently scrobbled track did not contain a timestamp, omitting from time frame check`, {track, mbid});
                        return acc;
                    }
                    return acc.concat(formatted);
                } catch (e) {
                    this.logger.warn('Failed to format Last.fm recently scrobbled track, omitting from time frame check', {error: e.message});
                    this.logger.debug('Full api response object:');
                    this.logger.debug(x);
                    return acc;
                }
            }, []).sort(sortByOldestPlayDate);
            if (this.recentScrobbles.length > 0) {
                const [{data: {playDate: newestScrobbleTime = dayjs()} = {}} = {}] = this.recentScrobbles.slice(-1);
                const [{data: {playDate: oldestScrobbleTime = dayjs()} = {}} = {}] = this.recentScrobbles.slice(0, 1);
                this.newestScrobbleTime = newestScrobbleTime;
                this.oldestScrobbleTime = oldestScrobbleTime;

                this.scrobbledPlayObjs = this.scrobbledPlayObjs.filter(x => this.timeFrameIsValid(x.play)[0]);
            }
        }
        this.lastScrobbleCheck = dayjs();
    }

    cleanSourceSearchTitle = (playObj: PlayObject) => {
        const {
            data: {
                track,
            } = {},
        } = playObj;
        return track.toLocaleLowerCase().trim();
    }

    alreadyScrobbled = async (playObj: PlayObject, log = false) => {
        return await this.existingScrobble(playObj) !== undefined;
    }

    scrobble = async (playObj: PlayObject) => {
        const {
            data: {
                artists,
                album,
                track,
                duration,
                playDate
            } = {},
            data = {},
            meta: {
                source,
                newFromSource = false,
            } = {}
        } = playObj;

        const sType = newFromSource ? 'New' : 'Backlog';

        const rawPayload = {
            artist: artists.join(', '),
            duration,
            track,
            album,
            timestamp: playDate.unix(),
        };
        // i don't know if its lastfm-node-client building the request params incorrectly
        // or the last.fm api not handling the params correctly...
        //
        // ...but in either case if any of the below properties is undefined (possibly also null??)
        // then last.fm responds with an IGNORED scrobble and error code 1 (totally unhelpful)
        // so remove all undefined keys from the object before passing to the api client
        const scrobblePayload = removeUndefinedKeys(rawPayload);

        try {
            const response = await this.api.callApi<TrackScrobbleResponse>((client: any) => client.trackScrobble(
                scrobblePayload));
            const {
                scrobbles: {
                    '@attr': {
                        accepted = 0,
                        ignored = 0,
                        code = undefined,
                    } = {},
                    scrobble: {
                        track: {
                           '#text': trackName,
                        } = {},
                        timestamp,
                        ignoredMessage: {
                            code: ignoreCode,
                            '#text': ignoreMsg,
                        } = {},
                        ...rest
                    } = {}
                } = {},
            } = response;
            if(code === 5) {
                this.initialized = false;
                throw new Error('Service reported daily scrobble limit exceeded! 😬 Disabling client');
            }
            this.addScrobbledTrack(playObj, {...rest, date: { uts: timestamp}, name: trackName});
            if (newFromSource) {
                this.logger.info(`Scrobbled (New)     => (${source}) ${buildTrackString(playObj)}`);
            } else {
                this.logger.info(`Scrobbled (Backlog) => (${source}) ${buildTrackString(playObj)}`);
            }
            if(ignored > 0) {
                await this.notifier.notify({title: `Client - ${capitalize(this.type)} - ${this.name} - Scrobble Error`, message: `Failed to scrobble => ${buildTrackString(playObj)} | Error: Service ignored this scrobble 😬 => (Code ${ignoreCode}) ${(ignoreMsg === '' ? '(No error message returned)' : ignoreMsg)}`, priority: 'warn'});
                this.logger.warn(`Service ignored this scrobble 😬 => (Code ${ignoreCode}) ${(ignoreMsg === '' ? '(No error message returned)' : ignoreMsg)} -- See https://www.last.fm/api/errorcodes for more information`, {payload: scrobblePayload});
            }

            // last fm has rate limits but i can't find a specific example of what that limit is. going to default to 1 scrobble/sec to be safe
            await sleep(1000);
        } catch (e) {
            await this.notifier.notify({title: `Client - ${capitalize(this.type)} - ${this.name} - Scrobble Error`, message: `Failed to scrobble => ${buildTrackString(playObj)} | Error: ${e.message}`, priority: 'error'});
            this.logger.error(`Scrobble Error (${sType})`, {playInfo: buildTrackString(playObj), payload: scrobblePayload});
            throw e;
        } finally {
            this.logger.debug('Raw Payload: ', rawPayload);
        }

        return true;
    }
}
