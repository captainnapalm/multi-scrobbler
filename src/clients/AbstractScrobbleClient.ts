import dayjs, {Dayjs} from "dayjs";
import {
    buildTrackString,
    capitalize, closePlayDate,
    mergeArr,
    playObjDataMatch, setIntersection,
    truncateStringToLength
} from "../utils.js";
import {
    ClientType, FormatPlayObjectOptions,
    INITIALIZED,
    INITIALIZING,
    InitState,
    NOT_INITIALIZED,
    PlayObject, ScrobbledPlayObject, TrackStringOptions
} from "../common/infrastructure/Atomic.js";
import winston, {Logger} from "winston";
import {CommonClientConfig} from "../common/infrastructure/config/client/index.js";
import {ClientConfig} from "../common/infrastructure/config/client/clients.js";
import {Notifiers} from "../notifier/Notifiers.js";

export default abstract class AbstractScrobbleClient {

    name: string;
    type: ClientType;

    #initState: InitState = NOT_INITIALIZED;

    requiresAuth: boolean = false;
    requiresAuthInteraction: boolean = false;
    authed: boolean = false;

    recentScrobbles: PlayObject[] = [];
    scrobbledPlayObjs: ScrobbledPlayObject[] = [];
    newestScrobbleTime?: Dayjs
    oldestScrobbleTime: Dayjs = dayjs();
    tracksScrobbled: number = 0;

    lastScrobbleCheck: Dayjs = dayjs(0)
    refreshEnabled: boolean;
    checkExistingScrobbles: boolean;
    verboseOptions;

    config: CommonClientConfig;
    logger: Logger;

    notifier: Notifiers;

    constructor(type: any, name: any, config: CommonClientConfig, notifier: Notifiers, logger: Logger) {
        this.type = type;
        this.name = name;
        const identifier = `Client ${capitalize(this.type)} - ${name}`;
        this.logger = logger.child({labels: [identifier]}, mergeArr);
        this.notifier = notifier;

        const {
            data: {
                options: {
                    refreshEnabled = true,
                    checkExistingScrobbles = true,
                    verbose = {},
                } = {},
            },
        } = config;
        this.config = config;
        this.refreshEnabled = refreshEnabled;
        this.checkExistingScrobbles = checkExistingScrobbles;

        const {
            match: {
                onNoMatch = false,
                onMatch = false,
                confidenceBreakdown = false,
            } = {},
            ...vRest
        } = verbose
        if (onMatch || onNoMatch) {
            this.logger.warn('Setting verbose matching may produce noisy logs! Use with care.');
        }
        this.verboseOptions = {
            ...vRest,
            match: {
                onNoMatch,
                onMatch,
                confidenceBreakdown
            }
        };
    }

    get initialized() {
        return this.#initState === INITIALIZED;
    }

   set initialized(val) {
        // @ts-expect-error TS(2367): This condition will always return 'false' since th... Remove this comment to see the full error message
        if(val === INITIALIZING) {
            this.#initState = INITIALIZING;
        // @ts-expect-error TS(2367): This condition will always return 'false' since th... Remove this comment to see the full error message
        } else if(val === true || val === INITIALIZED) {
            this.#initState = INITIALIZED;
        } else {
            this.#initState = NOT_INITIALIZED;
        }
   }

   get initializing() {
        return this.#initState === INITIALIZING;
   }

    // default init function, should be overridden if init stage is required
    initialize = async () => {
        this.initialized = true;
        return true;
    }

    // default init function, should be overridden if auth stage is required
    testAuth = async () => {
        return this.authed;
    }

    isReady = async () => {
        return this.initialized && (!this.requiresAuth || (this.requiresAuth && this.authed));
    }

    refreshScrobbles = async () => {
        this.logger.debug('Scrobbler does not have refresh function implemented!');
    }

    alreadyScrobbled = async (playObj: PlayObject, log = false) => {
        this.logger.debug('Scrobbler does not have alreadyScrobbled check implemented!');
        return false;
    }

    scrobblesLastCheckedAt = () => {
        return this.lastScrobbleCheck;
    }

    formatPlayObj = (obj: any, options: FormatPlayObjectOptions = {}) => {
        this.logger.warn('formatPlayObj should be defined by concrete class!');
        return obj;
    }

    // time frame is valid as long as the play date for the source track is newer than the oldest play time from the scrobble client
    // ...this is assuming the scrobble client is returning "most recent" scrobbles
    timeFrameIsValid = (playObj: any) => {
        const {
            data: {
                // @ts-expect-error TS(2525): Initializer provides no value for this binding ele... Remove this comment to see the full error message
                playDate,
            } = {},
        } = playObj;
        const validTime = playDate.isAfter(this.oldestScrobbleTime);
        let log = '';
        if (!validTime) {
            const dur = dayjs.duration(Math.abs(playDate.diff(this.oldestScrobbleTime))).humanize(false);
            log = `occurred ${dur} before the oldest scrobble returned by this client (${this.oldestScrobbleTime.format()})`;
        }
        return [validTime, log]
    }

    addScrobbledTrack = (playObj: any, scrobbleResp: any) => {
        this.scrobbledPlayObjs.push({play: playObj, scrobble: this.formatPlayObj(scrobbleResp)});
    }

    cleanSourceSearchTitle = (playObj: PlayObject) => {
        const {
            data: {
                track,
            } = {},
        } = playObj;

        return track.toLocaleLowerCase().trim();
    };

    findExistingSubmittedPlayObj = (playObj: PlayObject): ([undefined, undefined] | [ScrobbledPlayObject, ScrobbledPlayObject[]]) => {
        const {
            data: {
                playDate
            } = {},
            meta: {
                source,
            } = {}
        } = playObj;

        const dtInvariantMatches = this.scrobbledPlayObjs.filter(x => playObjDataMatch(playObj, x.play));

        if (dtInvariantMatches.length === 0) {
            return [undefined, undefined];
        }

        const matchPlayDate = dtInvariantMatches.find((x: ScrobbledPlayObject) => {
            const {
                play: {
                    data: {
                        playDate: sPlayDate
                    } = {},
                    meta: {
                        source: playSource
                    } = {},
                } = {},
            } = x;
            // need to account for inaccurate DT from subsonic
            if(source === 'Subsonic' && playSource === 'Subsonic') {
                return playDate.isSame(sPlayDate) || playDate.diff(sPlayDate, 'minute') <= 1;
            }
            return playDate.isSame(sPlayDate);
        });

        return [matchPlayDate, dtInvariantMatches];
    }

    protected compareExistingScrobbleTime = (existing: PlayObject, candidate: PlayObject): [boolean, boolean?] => {
        let closeTime = closePlayDate(existing, candidate);
        let fuzzyTime = false;
        if(!closeTime) {
            fuzzyTime = closePlayDate(existing, candidate, {fuzzyDuration: true});
        }
        return [closeTime, fuzzyTime];
    }
    protected compareExistingScrobbleTitle = (existing: PlayObject, candidate: PlayObject): number => {

        const {
            data: {
                track: scrobbleTitle,
            } = {},
        } = existing;

        let cleanSourceTitle = this.cleanSourceSearchTitle(candidate);

        let titleMatch;
        const lowerScrobbleTitle = scrobbleTitle.toLocaleLowerCase().trim();
        // because of all this replacing we need a more position-agnostic way of comparing titles so use intersection on title split by spaces
        // and compare against length of scrobble title
        const sourceTitleTerms = new Set(cleanSourceTitle.split(' ').filter((x: any) => x !== ''));
        const commonTerms = setIntersection(new Set(lowerScrobbleTitle.split(' ')), sourceTitleTerms);

        titleMatch = commonTerms.size / sourceTitleTerms.size;
        return titleMatch;
    }

    protected compareExistingScrobbleArtist = (existing: PlayObject, candidate: PlayObject): number => {
        const {
            data: {
                artists: sourceArtists = [],
            } = {},
        } = candidate;
        const {
            data: {
                artists = [],
            } = {},
        } = candidate;
        let artistMatch;
        const lowerSourceArtists = sourceArtists.map((x: any) => x.toLocaleLowerCase());
        const lowerScrobbleArtists = artists.map(x => x.toLocaleLowerCase());
        artistMatch = setIntersection(new Set(lowerScrobbleArtists), new Set(lowerSourceArtists)).size / artists.length;

        return artistMatch;
    }

    existingScrobble = async (playObj: PlayObject) => {
        const tr = truncateStringToLength(27);
        const scoreTrackOpts: TrackStringOptions = {include: ['track', 'time'], transformers: {track: (t: any) => tr(t).padEnd(30)}};

        // return early if we don't care about checking existing
        if (false === this.checkExistingScrobbles) {
            if (this.verboseOptions.match.onNoMatch) {
                this.logger.debug(`(Existing Check) Source: ${buildTrackString(playObj, scoreTrackOpts)} => No Match because existing scrobble check is FALSE`);
            }
            return undefined;
        }

        let existingScrobble;
        let closestMatch: {score: number, breakdowns: string[], scrobble?: PlayObject} = {score: 0, breakdowns: ['None']};

        // then check if we have already recorded this
        const [existingExactSubmitted, existingDataSubmitted = []] = this.findExistingSubmittedPlayObj(playObj);

        // if we have an submitted play with matching data and play date then we can just return the response from the original scrobble
        if (existingExactSubmitted !== undefined) {
            existingScrobble = existingExactSubmitted.scrobble;

            closestMatch = {
                score: 1,
                breakdowns: ['Exact Match found in previously successfully scrobbled']
            }
        }
        // if not though then we need to check recent scrobbles from scrobble api.
        // this will be less accurate than checking existing submitted (obv) but will happen if backlogging or on a fresh server start

        // if no recent scrobbles found then assume we haven't submitted it
        // (either user doesnt want to check history or there is no history to check!)
        if (this.recentScrobbles.length === 0) {
            if (this.verboseOptions.match.onNoMatch) {
                this.logger.debug(`(Existing Check) ${buildTrackString(playObj, scoreTrackOpts)} => No Match because no recent scrobbles returned from API`);
            }
            return undefined;
        }

        if (existingScrobble === undefined) {

            // we have have found an existing submission but without an exact date
            // in which case we can check the scrobble api response against recent scrobbles (also from api) for a more accurate comparison
            const referenceApiScrobbleResponse = existingDataSubmitted.length > 0 ? existingDataSubmitted[0].scrobble : undefined;

            // clean source title so it matches title from the scrobble api response as closely as we can get it
            let cleanSourceTitle = this.cleanSourceSearchTitle(playObj);

            existingScrobble = this.recentScrobbles.find((x) => {

                const referenceMatch = referenceApiScrobbleResponse !== undefined && playObjDataMatch(x, referenceApiScrobbleResponse);


                const [closeTime, fuzzyTime = false] = this.compareExistingScrobbleTime(x, playObj);

                const titleMatch = this.compareExistingScrobbleTitle(x, playObj);

                const artistMatch = this.compareExistingScrobbleArtist(x, playObj);

                const artistScore = .2 * artistMatch;
                const titleScore = .3 * titleMatch;
                const timeScore = .5 * (closeTime ? 1 : (fuzzyTime ? 0.5 : 0));
                const referenceScore = .5 * (referenceMatch ? 1 : 0);
                const score = artistScore + titleScore + timeScore;

                let scoreBreakdowns = [
                    `Reference: ${(referenceMatch ? 1 : 0)} * .5 = ${referenceScore.toFixed(2)}`,
                    `Artist ${artistMatch.toFixed(2)} * .2 = ${artistScore.toFixed(2)}`,
                    `Title: ${titleMatch.toFixed(2)} * .3 = ${titleScore.toFixed(2)}`,
                    `Time: ${closeTime ? 1 : 0} * .5 = ${timeScore.toFixed(2)}`,
                    `Score ${score.toFixed(2)} => ${score >= .7 ? 'Matched!' : 'No Match'}`
                ];

                const confidence = `Score ${score.toFixed(2)} => ${score >= .7 ? 'Matched!' : 'No Match'}`

                const scoreInfo = {
                    score,
                    scrobble: x,
                    breakdowns: this.verboseOptions.match.confidenceBreakdown ? scoreBreakdowns : [confidence]
                }

                if (closestMatch.score <= score && score > 0) {
                    closestMatch = scoreInfo
                }

                return score >= .7;
            });
        }

        if ((existingScrobble !== undefined && this.verboseOptions.match.onMatch) || (existingScrobble === undefined && this.verboseOptions.match.onNoMatch)) {
            const closestScrobble = closestMatch.scrobble === undefined ? closestMatch.breakdowns.join(' | ') : `Closest Scrobble: ${buildTrackString(closestMatch.scrobble, scoreTrackOpts)} => ${closestMatch.breakdowns.join(' | ')}`;
            this.logger.debug(`(Existing Check) Source: ${buildTrackString(playObj, scoreTrackOpts)} => ${closestScrobble}`);
        }
        return existingScrobble;
    }
}
