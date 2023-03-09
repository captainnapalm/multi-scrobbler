import dayjs, {Dayjs} from "dayjs";
import {
    buildTrackString,
    createAjvFactory,
    mergeArr,
    playObjDataMatch,
    readJson,
    returnDuplicateStrings, validateJson
} from "../utils.js";
import MalojaScrobbler from "./MalojaScrobbler.js";
import LastfmScrobbler from "./LastfmScrobbler.js";
import {clientTypes, ConfigMeta, PlayObject} from "../common/infrastructure/Atomic.js";
import {AIOConfig} from "../common/infrastructure/config/aioConfig.js";
import * as aioSchema from '../common/schema/aio-client.json';
import * as clientSchema from '../common/schema/client.json';
import {ClientAIOConfig, ClientConfig} from "../common/infrastructure/config/client/clients.js";
import {MalojaClientConfig} from "../common/infrastructure/config/client/maloja.js";
import {LastfmClientConfig} from "../common/infrastructure/config/client/lastfm.js";
import {Notifiers} from "../notifier/Notifiers.js";
import AbstractScrobbleClient from "./AbstractScrobbleClient.js";
import {EventEmitter} from "events";
import winston from "winston";

type groupedNamedConfigs = {[key: string]: ParsedConfig[]};

type ParsedConfig = ClientAIOConfig & ConfigMeta;

export default class ScrobbleClients {

    /** @type AbstractScrobbleClient[] */
    clients: (MalojaScrobbler | LastfmScrobbler)[] = [];
    logger;
    configDir;

    emitter: EventEmitter;

    sourceEmitter: EventEmitter;

    constructor(emitter: EventEmitter, sourceEmitter: EventEmitter, configDir: any) {
        this.emitter = emitter;
        this.sourceEmitter = sourceEmitter;
        this.configDir = configDir;
        this.logger = winston.loggers.get('app').child({labels: ['Scrobblers']}, mergeArr);

        this.sourceEmitter.on('scrobble', async (payload: { data: (PlayObject | PlayObject[]), options: { forceRefresh?: boolean, checkTime?: Dayjs, scrobbleTo?: string[], scrobbleFrom?: string } }) => {
            await this.scrobble(payload.data, payload.options);
        });
    }

    getByName = (name: any) => {
        return this.clients.find(x => x.name === name);
    }

    getByType = (type: any) => {
        return this.clients.filter(x => x.type === type);
    }

    async getStatusSummary(type?: string, name?: string): Promise<[boolean, string[]]> {
        let clients: AbstractScrobbleClient[];

        const messages: string[] = [];
        let clientsReady = true;

        if(type !== undefined) {
            clients = this.getByType(type);
        } else if(name !== undefined) {
            clients = [this.getByName(name)];
        } else {
            clients = this.clients;
        }

        for(const client of clients) {
            if(!await client.isReady()) {
                clientsReady = false;
                messages.push(`Client ${client.type} - ${client.name} is not ready.`);
            }
        }

        return [clientsReady, messages];
    }

    buildClientsFromConfig = async (notifier: Notifiers) => {
        let configs: ParsedConfig[] = [];

        let configFile;
        try {
            configFile = await readJson(`${this.configDir}/config.json`, {throwOnNotFound: false});
        } catch (e) {
            // think this should stay as show-stopper since config could include important defaults (delay, retries) we don't want to ignore
            throw new Error('config.json could not be parsed');
        }
        let clientDefaults = {};
        if (configFile !== undefined) {
            const aioConfig = validateJson<AIOConfig>(configFile, aioSchema, this.logger);
            const {
                clients: mainConfigClientConfigs = [],
                clientDefaults: cd = {},
            } = aioConfig;
            clientDefaults = cd;
            // const validMainConfigs = mainConfigClientConfigs.reduce((acc: any, curr: any, i: any) => {
            //     if(curr === null) {
            //         this.logger.error(`The client config entry at index ${i} in config.json is null but should be an object, will not parse`);
            //         return acc;
            //     }
            //     if(typeof curr !== 'object') {
            //         this.logger.error(`The client config entry at index ${i} in config.json should be an object, will not parse`);
            //         return acc;
            //     }
            //     return acc.concat(curr);
            // }, []);
            for (const c of mainConfigClientConfigs) {
                const {name = 'unnamed'} = c;
                configs.push({...c,
                    name,
                    source: 'config.json',
                    configureAs: 'client', //override user value
                });
            }
        }

        for (const clientType of clientTypes) {
            let defaultConfigureAs = 'client';
            switch (clientType) {
                case 'maloja':
                    // env builder for single user mode
                    const url = process.env.MALOJA_URL;
                    const apiKey = process.env.MALOJA_API_KEY;
                    if (url !== undefined || apiKey !== undefined) {
                        configs.push({
                            type: 'maloja',
                            name: 'unnamed',
                            source: 'ENV',
                            mode: 'single',
                            configureAs: 'client',
                            data: {
                                url,
                                // @ts-ignore
                                apiKey
                            }
                        })
                    }
                    break;
                case 'lastfm':
                    const lfm = {
                        apiKey: process.env.LASTFM_API_KEY,
                        secret: process.env.LASTFM_SECRET,
                        redirectUri: process.env.LASTFM_REDIRECT_URI,
                        session: process.env.LASTFM_SESSION,
                    };
                    if (!Object.values(lfm).every(x => x === undefined)) {
                        configs.push({
                            type: 'lastfm',
                            name: 'unnamed',
                            source: 'ENV',
                            mode: 'single',
                            configureAs: 'client',
                            // @ts-ignore
                            data: lfm
                        })
                    }
                    break;
                default:
                    break;
            }
            let rawClientConfigs;
            try {
                rawClientConfigs = await readJson(`${this.configDir}/${clientType}.json`, {throwOnNotFound: false});
            } catch (e) {
                this.logger.error(`${clientType}.json config file could not be parsed`);
                continue;
            }
            if (rawClientConfigs !== undefined) {
                let clientConfigs: ParsedConfig[] = [];
                if (Array.isArray(rawClientConfigs)) {
                    clientConfigs = rawClientConfigs;
                } else if(rawClientConfigs === null) {
                    this.logger.error(`${clientType}.json contained no data`);
                    continue;
                } else if(typeof rawClientConfigs === 'object') {
                    clientConfigs = [rawClientConfigs];
                } else {
                    this.logger.error(`All top level data from ${clientType}.json must be an object or an array of objects, will not parse configs from file`);
                    continue;
                }
                for(const [i,rawConf] of rawClientConfigs.entries()) {
                    try {
                        const validConfig = validateJson<ClientConfig>(rawConf, clientSchema, this.logger);
                        // @ts-ignore
                        const {configureAs = defaultConfigureAs} = validConfig;
                        if (configureAs === 'client') {
                            const parsedConfig: ParsedConfig = {
                                ...rawConf,
                                source: `${clientType}.json`,
                                type: clientType
                            }
                            configs.push(parsedConfig);
                        }
                    } catch (e: any) {
                        this.logger.error(`The config entry at index ${i} from ${clientType}.json was not valid`);
                    }
                }
/*                for (const [i,m] of clientConfigs.entries()) {
                    if(m === null) {
                        this.logger.error(`The config entry at index ${i} from ${clientType}.json is null`);
                        continue;
                    }
                    if (typeof m !== 'object') {
                        this.logger.error(`The config entry at index ${i} from ${clientType}.json was not an object, skipping`, m);
                        continue;
                    }
                    const {configureAs = defaultConfigureAs} = m;
                    if(configureAs === 'client') {
                        m.source = `${clientType}.json`;
                        m.type = clientType;
                        configs.push(m);
                    }
                }*/
            }
        }

        // we have all possible client configurations so we'll check they are minimally valid
        /*const validConfigs = configs.reduce((acc, c) => {
            const isValid = isValidConfigStructure(c, {type: true, data: true});
            if (isValid !== true) {
                this.logger.error(`Client config from ${c.source} with name [${c.name || 'unnamed'}] of type [${c.type || 'unknown'}] will not be used because it has structural errors: ${isValid.join(' | ')}`);
                return acc;
            }
            return acc.concat(c);
        }, []);*/

        // all client configs are minimally valid
        // now check that names are unique
        const nameGroupedConfigs = configs.reduce((acc: groupedNamedConfigs, curr: ParsedConfig) => {
            const {name = 'unnamed'} = curr;
            const {[name]: n = []} = acc;
            return {...acc, [name]: [...n, curr]};
        }, {});
        let noConflictConfigs: ParsedConfig[] = [];
        for (const [name, configs] of Object.entries(nameGroupedConfigs)) {
            if (configs.length > 1) {
                const sources = configs.map((c: any) => `Config object from ${c.source} of type [${c.type}]`);
                this.logger.error(`The following clients will not be built because of config naming conflicts (they have the same name of "${name}"): 
${sources.join('\n')}`);
                if (name === 'unnamed') {
                    this.logger.info('HINT: "unnamed" configs occur when using ENVs, if a multi-user mode config does not have a "name" property, or if a config is built in single-user mode');
                }
            } else {
                noConflictConfigs = [...noConflictConfigs, ...configs];
            }
        }

        // finally! all configs are valid, structurally, and can now be passed to addClient
        // just need to re-map unnnamed to default
        const finalConfigs: ParsedConfig[] = noConflictConfigs.map(({name = 'unnamed', ...x}) => ({
            ...x,
            name
        }));
        for (const c of finalConfigs) {
            try {
                await this.addClient(c, clientDefaults, notifier);
            } catch(e) {
                this.logger.error(`Client ${c.name} was not added because it had unrecoverable errors`);
                this.logger.error(e);
            }
        }
    }

    addClient = async (clientConfig: ParsedConfig, defaults = {}, notifier: Notifiers) => {
/*        const isValidConfig = isValidConfigStructure(clientConfig, {name: true, data: true, type: true});
        if (isValidConfig !== true) {
            throw new Error(`Config object from ${clientConfig.source || 'unknown'} with name [${clientConfig.name || 'unnamed'}] of type [${clientConfig.type || 'unknown'}] has errors: ${isValidConfig.join(' | ')}`)
        }*/
        const {type, name, data: d = {}} = clientConfig;
        // add defaults
        const data = {...defaults, ...d};
        let newClient;
        this.logger.debug(`Constructing ${type} (${name}) client...`);
        switch (type) {
            case 'maloja':
                newClient = new MalojaScrobbler(name, ({...clientConfig, data} as unknown as MalojaClientConfig), notifier, this.logger);
                break;
            case 'lastfm':
                newClient = new LastfmScrobbler(name, {...clientConfig, data: {configDir: this.configDir, ...data} } as unknown as LastfmClientConfig, {}, notifier, this.logger);
                break;
            default:
                break;
        }

        if(newClient === undefined) {
            // really shouldn't get here!
            throw new Error(`Client of type ${type} was not recognized??`);
        }
        if(newClient.initialized === false) {
            this.logger.debug(`Attempting ${type} (${name}) initialization...`);
            if ((await newClient.initialize()) === false) {
                this.logger.error(`${type} (${name}) client failed to initialize. Client needs to be successfully initialized before scrobbling.`);
            } else {
                this.logger.info(`${type} (${name}) client initialized`);
            }
        }
        if(newClient.requiresAuth && !newClient.authed) {
            this.logger.debug(`Checking ${type} (${name}) client auth...`);
            let success;
            try {
                success = await newClient.testAuth();
            } catch (e) {
                success = false;
            }
            if(!success) {
                this.logger.warn(`${type} (${name}) client auth failed.`);
            } else {
                this.logger.info(`${type} (${name}) client auth OK`);
            }
        }
        this.clients.push(newClient);
    }

    /**
     * @param {*} data
     * @param {{scrobbleFrom, scrobbleTo, forceRefresh: boolean}|{scrobbleFrom, scrobbleTo}} options
     * @returns {Array}
     */
    scrobble = async (data: (PlayObject | PlayObject[]), options: {forceRefresh?: boolean, checkTime?: Dayjs, scrobbleTo?: string[], scrobbleFrom?: string} = {}) => {
        const playObjs = Array.isArray(data) ? data : [data];
        const {
            forceRefresh = false,
            checkTime = dayjs(),
            scrobbleTo = [],
            scrobbleFrom = 'source',
        } = options;

        const tracksScrobbled: any = [];

        if (this.clients.length === 0) {
            this.logger.warn('Cannot scrobble! No clients are configured.');
        }

        for (const client of this.clients) {
            if (scrobbleTo.length > 0 && !scrobbleTo.includes(client.name)) {
                client.logger.debug(`Client was filtered out by Source '${scrobbleFrom}'`);
                continue;
            }
            if(!client.initialized) {
                if(client.initializing) {
                    client.logger.warn(`Cannot scrobble because it is still initializing`);
                    continue;
                }
                if(!(await client.initialize())) {
                    client.logger.warn(`Cannot scrobble because it could not be initialized`);
                    continue;
                }
            }

            if(client.requiresAuth && !client.authed) {
                if (client.requiresAuthInteraction) {
                    client.logger.warn(`Cannot scrobble because user interaction is required for authentication`);
                    continue;
                } else if (!(await client.testAuth())) {
                    client.logger.warn(`Cannot scrobble because auth test failed`);
                    continue;
                }
            }

            if(!(await client.isReady())) {
                client.logger.warn(`Cannot scrobble because it is not ready`);
                continue;
            }

            if (forceRefresh || client.scrobblesLastCheckedAt().unix() < checkTime.unix()) {
                try {
                    await client.refreshScrobbles();
                } catch(e) {
                    client.logger.error(`Encountered error while refreshing scrobbles`);
                    this.logger.error(e);
                }
            }
            for (const playObj of playObjs) {
                try {
                    const {
                        meta: {
                            newFromSource = false,
                        } = {}
                    } = playObj;
                    const [timeFrameValid, timeFrameValidLog] = client.timeFrameIsValid(playObj);
                    if (timeFrameValid && !(await client.alreadyScrobbled(playObj))) {
                        await client.scrobble(playObj)
                        client.tracksScrobbled++;
                        // since this is what we return to the source only add to tracksScrobbled if not already in array
                        // (source should only know that a track was scrobbled (binary) -- doesn't care if it was scrobbled more than once
                        if(!tracksScrobbled.some(x => playObjDataMatch(x, playObj) && x.data.playDate === playObj.data.playDate)) {
                            tracksScrobbled.push(playObj);
                        }
                    } else {
                        if(!timeFrameValid) {
                            client.logger.debug(`Will not scrobble ${buildTrackString(playObj)} from Source '${scrobbleFrom}' because it ${timeFrameValidLog}`);
                        }
                    }
                } catch(e) {
                    client.logger.error(`Encountered error while in scrobble loop`);
                    client.logger.error(e);
                    // for now just stop scrobbling plays for this client and move on. the client should deal with logging the issue
                    if(e.continueScrobbling !== true) {
                        break;
                    }
                }
            }
        }
        return tracksScrobbled;
    }
}
